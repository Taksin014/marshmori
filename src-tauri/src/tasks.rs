// Work Mamori hands to a coding agent ("สั่งงาน").
//
// You write the task in the island, pick the agent, the folder and how much it may do
// without asking, and Mamori runs that agent's own command-line tool in the background,
// signed in the way it already is, in that folder, with no window. It is an ordinary
// session of that agent: its hooks report to Marshmori like any other (the relay tags
// them with MARSHMORI_TASK, so the island knows Mamori started it), and when it wants
// permission for something the card comes to the island, because there is no terminal
// to answer in. A follow-up continues the same agent session.
//
// * The task text only ever travels on stdin, never on the command line.
// * How much it may do on its own maps onto each agent's own permission modes. The one
//   exception is agy: in print mode its own check can't ask anyone and declines every
//   command, so while Marshmori's hooks are connected it runs without that check and
//   the island's card is the gate (gate.rs, by the task's mode). Never for a plan.
// * What was asked and what came back are kept in tasks.json (not the files the agent
//   touched), so the island can still show them after a restart. Quitting Marshmori
//   stops tasks that are still running.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agents::{self, short};
use crate::chat::{self, Provider};
use crate::{island, log, paths, AppState};

/// Longest a task may run, and longest it may stay silent (an approval card waiting is
/// bounded by its own timeout; a long build can be quiet for a while).
const MAX_RUN: Duration = Duration::from_secs(4 * 3600);
const MAX_SILENCE: Duration = Duration::from_secs(45 * 60);
/// Kept in the list (finished ones beyond this are forgotten, oldest first).
const MAX_TASKS: usize = 30;
const MAX_TURNS: usize = 12;
const MAX_RUNNING: usize = 4;
const MAX_PROMPT_CHARS: usize = 20_000;
const MAX_RESULT_CHARS: usize = 12_000;
const MAX_FOLDERS: usize = 8;
/// Files (or folders) attached to one message.
const MAX_FILES: usize = 10;
/// Live updates to the island at most this often per task.
const EMIT_EVERY: Duration = Duration::from_millis(250);

/// How much the agent may do without asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Reads on its own; edits and commands come to the island as cards.
    Ask,
    /// Edits files in the folder on its own; commands still ask.
    Edits,
    /// The agent's own automatic mode (Claude Code's safety classifier).
    Auto,
    /// Looks around and writes a plan; changes nothing.
    Plan,
}

impl Mode {
    pub fn parse(s: &str) -> Mode {
        match s {
            "edits" => Mode::Edits,
            "auto" => Mode::Auto,
            "plan" => Mode::Plan,
            _ => Mode::Ask,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Mode::Ask => "ask",
            Mode::Edits => "edits",
            Mode::Auto => "auto",
            Mode::Plan => "plan",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Running,
    Done,
    Error,
    Stopped,
}

/// One message to the agent and what came back.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub prompt: String,
    #[serde(default)]
    pub result: String,
    #[serde(default)]
    pub error: Option<String>,
    pub status: Status,
    pub started_at: u64,
    #[serde(default)]
    pub ended_at: Option<u64>,
    /// Files and folders dragged in with this message (their paths go to the agent).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// It picked up the agent's latest conversation in the folder (from a terminal or
    /// an IDE) instead of starting a new one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub continued: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    /// claude | codex | antigravity | gemini
    pub agent: String,
    pub agent_label: String,
    pub cwd: String,
    pub project: String,
    pub mode: Mode,
    pub status: Status,
    /// What it is doing right now, from the agent's own output.
    #[serde(default)]
    pub activity: String,
    /// The agent's own id for the conversation, to continue it.
    #[serde(default)]
    pub agent_session: Option<String>,
    /// The island's session for it once its hooks reported in ("claude:<id>").
    #[serde(default)]
    pub session_key: Option<String>,
    pub turns: Vec<Turn>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRequest {
    /// claude | codex | antigravity | gemini (ignored for a follow-up).
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub cwd: String,
    pub prompt: String,
    /// ask | edits | auto | plan
    #[serde(default)]
    pub mode: String,
    /// Continue this task instead of starting a new one.
    #[serde(default)]
    pub follow: Option<String>,
    /// Files and folders dragged in (absolute paths).
    #[serde(default)]
    pub files: Vec<String>,
    /// A new task picks up the agent's latest conversation in that folder (the one you
    /// had going in a terminal or an IDE) instead of starting from nothing.
    #[serde(default)]
    pub continue_last: bool,
}

/// Which conversation a run continues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Resume<'a> {
    New,
    Session(&'a str),
    /// The latest one in the folder (Claude Code `--continue`, Codex `resume --last`,
    /// Gemini `--resume latest`).
    Latest,
}

/// The agents that can pick up "the latest conversation in this folder".
pub(crate) fn can_continue(p: Provider) -> bool {
    matches!(p, Provider::Claude | Provider::Codex | Provider::Gemini)
}

/// Checks the attached paths: absolute, there, at most `MAX_FILES`, no repeats.
fn attachments(files: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in files {
        let f = raw.trim();
        if f.is_empty() || f.len() > 1000 || f.chars().any(char::is_control) {
            continue;
        }
        let path = Path::new(f);
        if !path.is_absolute() || !path.exists() {
            return Err(format!("ไม่พบไฟล์ {}", agents::basename(f)));
        }
        if !out.iter().any(|o| o == f) {
            out.push(f.to_string());
        }
    }
    if out.len() > MAX_FILES {
        return Err(format!("แนบได้ครั้งละไม่เกิน {MAX_FILES} ไฟล์"));
    }
    Ok(out)
}

/// What the agent reads: the message, then where the attached files are.
fn with_files(prompt: &str, files: &[String]) -> String {
    if files.is_empty() {
        return prompt.to_string();
    }
    let list: Vec<String> = files.iter().map(|f| format!("- {f}")).collect();
    format!("{prompt}\n\nFiles the user attached (open them from these paths):\n{}", list.join("\n"))
}

/// Folders outside the working folder that the attachments live in (so the agent may
/// read them there), at most five.
fn outside_dirs(cwd: &Path, files: &[String]) -> Vec<String> {
    let norm = |p: &Path| p.to_string_lossy().replace('\\', "/").to_lowercase().trim_end_matches('/').to_string();
    let root = norm(cwd);
    let mut out: Vec<String> = Vec::new();
    for f in files {
        let path = Path::new(f);
        let dir = if path.is_dir() { path.to_path_buf() } else { path.parent().map(Path::to_path_buf).unwrap_or_default() };
        let d = norm(&dir);
        if d.is_empty() || d == root || d.starts_with(&format!("{root}/")) {
            continue;
        }
        let text = dir.display().to_string();
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out.truncate(5);
    out
}

/// Everything the island needs to draw the task pages.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub tasks: Vec<Task>,
    /// Folders used for tasks lately, newest first.
    pub folders: Vec<String>,
    /// What was picked last time.
    pub agent: String,
    pub mode: Mode,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    #[serde(default)]
    tasks: Vec<Task>,
    #[serde(default)]
    folders: Vec<String>,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    mode: Option<Mode>,
}

struct Job {
    cancelled: AtomicBool,
    /// agy runs without its own permission check: Marshmori's hooks are the only gate.
    skips_own_check: AtomicBool,
    pid: Mutex<Option<u32>>,
    /// Everything the run started (Windows: a job object; elsewhere its process group).
    group: Mutex<Option<Arc<crate::platform::KillGroup>>>,
}

impl Job {
    fn new() -> Self {
        Job { cancelled: AtomicBool::new(false), skips_own_check: AtomicBool::new(false), pid: Mutex::new(None), group: Mutex::new(None) }
    }

    /// Stops the run and everything it started.
    fn stop(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        if let Some(group) = self.group.lock().unwrap().as_ref() {
            group.kill();
        }
        if let Some(pid) = *self.pid.lock().unwrap() {
            chat::kill_tree(pid);
        }
    }
}

#[derive(Default)]
pub struct TaskState {
    /// Newest first.
    tasks: Mutex<Vec<Task>>,
    /// Held while tasks.json is written, so two saves never cross.
    saving: Mutex<()>,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    folders: Mutex<Vec<String>>,
    last: Mutex<(String, Option<Mode>)>,
    counter: AtomicU64,
}

fn file() -> PathBuf {
    paths::data_dir().join("tasks.json")
}

/// Reads tasks.json at start-up. A task that was running when Marshmori last quit was
/// stopped with it.
pub fn load(app: &AppHandle) {
    let state = app.state::<AppState>();
    let saved: Saved = match std::fs::read(file()) {
        Ok(b) => match serde_json::from_slice(b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&b)) {
            Ok(saved) => saved,
            Err(err) => {
                // Unreadable: kept aside (not written over), and the list starts empty.
                let aside = file().with_extension(format!("json.bad-{}", paths::stamp()));
                let _ = std::fs::rename(file(), &aside);
                log::line(format!("tasks: {} was unreadable ({err}), moved to {}", file().display(), aside.display()));
                Saved::default()
            }
        },
        Err(_) => Saved::default(),
    };
    let now = paths::now_ms();
    let mut tasks = saved.tasks;
    for t in tasks.iter_mut().filter(|t| t.status == Status::Running) {
        t.status = Status::Stopped;
        t.activity = "หยุดไปตอนปิด Marshmori".into();
        if let Some(turn) = t.turns.last_mut().filter(|turn| turn.status == Status::Running) {
            turn.status = Status::Stopped;
            turn.ended_at = Some(now);
        }
    }
    tasks.truncate(MAX_TASKS);
    *state.tasks.tasks.lock().unwrap() = tasks;
    *state.tasks.folders.lock().unwrap() = saved.folders.into_iter().take(MAX_FOLDERS).collect();
    *state.tasks.last.lock().unwrap() = (saved.agent, saved.mode);
}

fn save(app: &AppHandle) {
    let state = app.state::<AppState>();
    // The snapshot and the write go together, so the newest state always lands last.
    let _saving = state.tasks.saving.lock().unwrap();
    let (agent, mode) = state.tasks.last.lock().unwrap().clone();
    let tasks = state.tasks.tasks.lock().unwrap().clone();
    let folders = state.tasks.folders.lock().unwrap().clone();
    let saved = Saved { tasks, folders, agent, mode };
    if let Ok(bytes) = serde_json::to_vec_pretty(&saved) {
        if let Err(err) = paths::write_atomic(&file(), &bytes) {
            log::line(format!("tasks: could not save: {err}"));
        }
    }
}

pub fn snapshot(app: &AppHandle) -> Snapshot {
    let state = app.state::<AppState>();
    let (agent, mode) = state.tasks.last.lock().unwrap().clone();
    let tasks = state.tasks.tasks.lock().unwrap().clone();
    let folders = state.tasks.folders.lock().unwrap().clone();
    Snapshot { tasks, folders, agent, mode: mode.unwrap_or(Mode::Ask) }
}

/// How much a task may do on its own.
pub fn mode_of(app: &AppHandle, id: &str) -> Option<Mode> {
    app.state::<AppState>().tasks.tasks.lock().unwrap().iter().find(|t| t.id == id).map(|t| t.mode)
}

/// A task's mode and folder, for gating its Antigravity tool calls.
pub fn gate_of(app: &AppHandle, id: &str) -> Option<(Mode, String)> {
    app.state::<AppState>().tasks.tasks.lock().unwrap().iter().find(|t| t.id == id).map(|t| (t.mode, t.cwd.clone()))
}

/// The folders Mamori may open for you: the ones tasks ran in.
pub fn knows_folder(app: &AppHandle, path: &str) -> bool {
    let state = app.state::<AppState>();
    let known = state.tasks.tasks.lock().unwrap().iter().any(|t| t.cwd == path);
    known || state.tasks.folders.lock().unwrap().iter().any(|f| f == path)
}

fn emit_task(app: &AppHandle, task: &Task) {
    let _ = app.emit_to(island::LABEL, "task", task.clone());
}

/// Changes one task and tells the island.
fn update(app: &AppHandle, id: &str, change: impl FnOnce(&mut Task)) {
    let state = app.state::<AppState>();
    let snapshot = {
        let mut tasks = state.tasks.tasks.lock().unwrap();
        let Some(t) = tasks.iter_mut().find(|t| t.id == id) else { return };
        change(t);
        t.updated_at = paths::now_ms();
        t.clone()
    };
    emit_task(app, &snapshot);
}

fn not_installed(p: Provider) -> String {
    format!("ยังไม่พบ {} ในเครื่องนี้ — ติดตั้งแล้วเปิด {} ใน terminal เพื่อล็อกอินหนึ่งครั้ง", p.label(), p.program())
}

fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max).collect();
    format!("{cut}\n\n…(ตัดให้สั้นลง)")
}

/// A folder the agent may work in: an existing directory, given as a full path.
fn work_dir(raw: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(raw.trim());
    if raw.trim().is_empty() {
        return Err("เลือกโฟลเดอร์ที่จะให้ทำงานก่อน".into());
    }
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("ไม่พบโฟลเดอร์นี้ ลองเลือกใหม่".into());
    }
    Ok(dir)
}

/// Starts a task, or a follow-up to one. Returns it as it is now (running).
pub fn start(app: &AppHandle, req: TaskRequest) -> Result<Task, String> {
    let state = app.state::<AppState>();
    let prompt = req.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("พิมพ์งานที่อยากให้ทำก่อน".into());
    }
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("งานนี้ยาวเกินไป ลองย่อให้สั้นลงหน่อย".into());
    }
    let running = state.tasks.jobs.lock().unwrap().len();
    if running >= MAX_RUNNING {
        return Err(format!("ตอนนี้มีงานทำอยู่ {running} งานแล้ว รอให้เสร็จก่อนนะ"));
    }
    let files = attachments(&req.files)?;
    let now = paths::now_ms();
    let mut turn = Turn {
        prompt: prompt.clone(),
        result: String::new(),
        error: None,
        status: Status::Running,
        started_at: now,
        ended_at: None,
        files: files.clone(),
        continued: false,
    };

    let (task, provider, program, resume) = match req.follow.as_deref() {
        Some(id) => {
            let mut tasks = state.tasks.tasks.lock().unwrap();
            let index = tasks.iter().position(|t| t.id == id).ok_or("ไม่พบงานนี้แล้ว")?;
            if tasks[index].status == Status::Running {
                return Err("งานนี้ยังทำอยู่ รอให้เสร็จก่อนนะ".into());
            }
            let provider = Provider::parse(&tasks[index].agent).ok_or("ไม่รู้จัก agent ของงานนี้")?;
            let program = chat::find_program(provider.program()).ok_or_else(|| not_installed(provider))?;
            work_dir(&tasks[index].cwd)?;
            let mut t = tasks.remove(index);
            if !req.mode.is_empty() {
                t.mode = Mode::parse(&req.mode);
            }
            t.status = Status::Running;
            t.activity = "กำลังเริ่ม…".into();
            t.turns.push(turn.clone());
            let extra = t.turns.len().saturating_sub(MAX_TURNS);
            t.turns.drain(..extra);
            t.updated_at = now;
            let resume = t.agent_session.clone();
            tasks.insert(0, t.clone());
            (t, provider, program, resume)
        }
        None => {
            let provider = Provider::parse(&req.agent).ok_or("เลือก agent ที่จะให้ทำงานก่อน")?;
            let program = chat::find_program(provider.program()).ok_or_else(|| not_installed(provider))?;
            let dir = work_dir(&req.cwd)?;
            let cwd = dir.display().to_string();
            let id = format!("t{}{}", now % 100_000_000, state.tasks.counter.fetch_add(1, Ordering::Relaxed) + 1);
            turn.continued = req.continue_last && can_continue(provider);
            let t = Task {
                id,
                agent: provider.id().to_string(),
                agent_label: provider.label().to_string(),
                project: crate::sessions::project_name(&cwd),
                cwd,
                mode: Mode::parse(&req.mode),
                status: Status::Running,
                activity: "กำลังเริ่ม…".into(),
                agent_session: None,
                session_key: None,
                turns: vec![turn.clone()],
                created_at: now,
                updated_at: now,
            };
            let mut tasks = state.tasks.tasks.lock().unwrap();
            tasks.insert(0, t.clone());
            // Forget the oldest finished ones beyond the limit.
            while tasks.len() > MAX_TASKS {
                match tasks.iter().rposition(|x| x.status != Status::Running) {
                    Some(i) => {
                        tasks.remove(i);
                    }
                    None => break,
                }
            }
            (t, provider, program, None)
        }
    };
    let continued = task.turns.last().map(|t| t.continued).unwrap_or(false);

    {
        let mut folders = state.tasks.folders.lock().unwrap();
        folders.retain(|f| f != &task.cwd);
        folders.insert(0, task.cwd.clone());
        folders.truncate(MAX_FOLDERS);
    }
    *state.tasks.last.lock().unwrap() = (task.agent.clone(), Some(task.mode));
    save(app);
    emit_task(app, &task);
    log::line(format!("task {}: {} in {} ({})", task.id, provider.id(), task.project, task.mode.id()));

    let job = Arc::new(Job::new());
    state.tasks.jobs.lock().unwrap().insert(task.id.clone(), job.clone());
    let (app2, id, cwd, mode, job2) = (app.clone(), task.id.clone(), PathBuf::from(&task.cwd), task.mode, job.clone());
    let message = with_files(&prompt, &files);
    let spawned = std::thread::Builder::new().name(format!("marshmori-{id}")).spawn(move || {
        // Whatever happens in there, the task ends with an outcome (never stuck "running").
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let resume = match (&resume, continued) {
                (Some(session), _) => Resume::Session(session.as_str()),
                (None, true) => Resume::Latest,
                (None, false) => Resume::New,
            };
            let extra = outside_dirs(&cwd, &files);
            let first = run(&app2, &id, provider, &program, &cwd, &message, mode, resume, &extra, &job2);
            // An older CLI that doesn't know an option we used gets one more go without it.
            match first {
                Outcome::BadOption(raw) => match fallback(provider, mode, resume, &raw) {
                    Some((mode2, resume2, note)) => {
                        update(&app2, &id, |t| {
                            t.mode = mode2;
                            t.activity = note.to_string();
                            if resume2 == Resume::New {
                                if let Some(turn) = t.turns.last_mut() {
                                    turn.continued = false;
                                }
                            }
                        });
                        match run(&app2, &id, provider, &program, &cwd, &message, mode2, resume2, &extra, &job2) {
                            Outcome::Done(text) => Outcome::Done(format!("*({note})*\n\n{text}")),
                            Outcome::BadOption(raw) => Outcome::Failed(chat::friendly_error(provider, &raw)),
                            other => other,
                        }
                    }
                    None => Outcome::Failed(chat::friendly_error(provider, &raw)),
                },
                other => other,
            }
        }))
        .unwrap_or_else(|_| Outcome::Failed("ขัดข้องระหว่างทำงาน".into()));
        finish(&app2, &id, provider, outcome, &job2);
    });
    if let Err(err) = spawned {
        finish(app, &task.id, provider, Outcome::Failed(format!("เริ่มงานไม่ได้: {err}")), &job);
        return Err(format!("เริ่มงานไม่ได้: {err}"));
    }
    Ok(task)
}

pub fn cancel(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let job = state.tasks.jobs.lock().unwrap().get(id).cloned();
    if let Some(job) = job {
        update(app, id, |t| {
            if t.status == Status::Running {
                t.activity = "กำลังหยุด…".into();
            }
        });
        job.stop();
    }
}

/// Takes a finished task off the list.
pub fn dismiss(app: &AppHandle, id: &str) -> bool {
    let state = app.state::<AppState>();
    let removed = {
        let mut tasks = state.tasks.tasks.lock().unwrap();
        let before = tasks.len();
        tasks.retain(|t| t.id != id || t.status == Status::Running);
        tasks.len() != before
    };
    if removed {
        save(app);
        let _ = app.emit_to(island::LABEL, "task-removed", id.to_string());
    }
    removed
}

/// Antigravity's hooks were disconnected: a run without agy's own check has no gate left,
/// so it stops. Returns how many did.
pub fn stop_ungated(app: &AppHandle) -> usize {
    let state = app.state::<AppState>();
    let running: Vec<String> = {
        let tasks = state.tasks.tasks.lock().unwrap();
        tasks.iter().filter(|t| t.status == Status::Running && t.agent == Provider::Antigravity.id()).map(|t| t.id.clone()).collect()
    };
    let hit: Vec<(String, Arc<Job>)> = {
        let jobs = state.tasks.jobs.lock().unwrap();
        running.into_iter().filter_map(|id| jobs.get(&id).filter(|j| j.skips_own_check.load(Ordering::Relaxed)).cloned().map(|j| (id, j))).collect()
    };
    for (id, job) in &hit {
        log::line(format!("task {id}: stopped, Antigravity hooks disconnected"));
        update(app, id, |t| t.activity = "หยุดแล้ว: ตัดการเชื่อม hooks ของ Antigravity".into());
        job.stop();
    }
    hit.len()
}

/// Quitting: whatever still runs is stopped (and saved as stopped).
pub fn stop_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    let jobs: Vec<Arc<Job>> = state.tasks.jobs.lock().unwrap().values().cloned().collect();
    for job in jobs {
        job.stop();
    }
}

/// One of Mamori's own tasks is this session (it shows itself as a task).
pub fn has_session(app: &AppHandle, key: &str) -> bool {
    let state = app.state::<AppState>();
    let tasks = state.tasks.tasks.lock().unwrap();
    tasks.iter().any(|t| t.session_key.as_deref() == Some(key))
}

/// A hook event said which island session a task is (the relay tagged it).
pub fn link(app: &AppHandle, task_id: &str, session_key: &str) {
    let state = app.state::<AppState>();
    let known = state.tasks.tasks.lock().unwrap().iter().any(|t| t.id == task_id && t.session_key.as_deref() != Some(session_key));
    if known {
        update(app, task_id, |t| t.session_key = Some(session_key.to_string()));
    }
}

/// Lets you pick a folder for a task (the system's own folder dialog).
pub fn pick_folder(app: &AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title("เลือกโฟลเดอร์ที่จะให้ทำงาน").blocking_pick_folder()?;
    let path = picked.into_path().ok()?;
    path.is_dir().then(|| path.display().to_string())
}

/// The system's file picker, for attaching files to a task ("แนบไฟล์").
pub fn pick_files(app: &AppHandle, start: Option<&str>) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title("แนบไฟล์ให้งานนี้");
    if let Some(dir) = start.map(Path::new).filter(|d| d.is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    dialog
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .filter(|p| p.exists())
        .map(|p| p.display().to_string())
        .take(MAX_FILES)
        .collect()
}

// ── Running one turn ────────────────────────────────────────────────────────────

enum Outcome {
    Done(String),
    Failed(String),
    Stopped,
    /// The CLI refused one of our options (an older version): what it said.
    BadOption(String),
}

/// The CLI's own words for "I don't know that option / value".
fn rejected_option(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    ["unknown option", "unexpected argument", "unrecognized option", "unrecognized argument", "invalid value", "allowed choices", "is invalid. allowed", "unknown argument", "no such option"]
        .iter()
        .any(|k| t.contains(k))
}

/// What to try instead when the CLI refused an option: (mode, resume, what to tell the user).
fn fallback<'a>(p: Provider, mode: Mode, resume: Resume<'a>, said: &str) -> Option<(Mode, Resume<'a>, &'static str)> {
    let t = said.to_ascii_lowercase();
    if p == Provider::Claude && mode == Mode::Auto && (t.contains("auto") || t.contains("permission-mode")) {
        return Some((Mode::Edits, resume, "Claude Code รุ่นนี้ยังไม่มีโหมดอัตโนมัติ เลยใช้ ‘แก้ไฟล์ได้’ แทน"));
    }
    if resume == Resume::Latest {
        return Some((mode, Resume::New, "ต่อจากงานล่าสุดไม่ได้ เลยเริ่มงานใหม่แทน"));
    }
    None
}

/// agy's option for running without its own permission check (see the top of this file).
const AGY_SKIP_OWN_CHECK: &str = "--dangerously-skip-permissions";

/// agy goes without its own check only where Marshmori's hook can be the gate, and never
/// for a plan (there agy declining every command is what we want).
fn agy_skips_own_check(mode: Mode, hooks_gate: bool) -> bool {
    hooks_gate && mode != Mode::Plan
}

/// Marshmori's Antigravity hooks are connected, point at the relay and weren't taken off:
/// every tool call reaches the island before it runs.
fn antigravity_hooks_gate(app: &AppHandle) -> bool {
    let off = app.state::<AppState>().settings.lock().unwrap().hooks_off.iter().any(|a| a == "antigravity");
    let st = crate::installer::status(agents::Agent::Antigravity);
    !off && st.installed && st.up_to_date && st.relay_ready && st.error.is_none()
}

/// The agent's own permission settings for `mode`, then its output options, and a
/// resume of the conversation when there is one. The task text is not here: it goes
/// in on stdin.
pub(crate) fn args_for(p: Provider, mode: Mode, resume: Resume, dirs: &[String]) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    let resume_id = match resume {
        Resume::Session(id) => Some(id),
        _ => None,
    };
    let latest = resume == Resume::Latest;
    match p {
        Provider::Claude => {
            let permission = match mode {
                Mode::Ask => "default",
                Mode::Edits => "acceptEdits",
                Mode::Auto => "auto",
                Mode::Plan => "plan",
            };
            let mut a = s(&["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", permission]);
            if let Some(id) = resume_id {
                a.push("--resume".into());
                a.push(id.to_string());
            } else if latest {
                a.push("--continue".into());
            }
            for d in dirs {
                a.push("--add-dir".into());
                a.push(d.clone());
            }
            a
        }
        Provider::Codex => {
            // codex exec never stops to ask: its sandbox is what keeps it in bounds.
            let sandbox = if mode == Mode::Plan { "read-only" } else { "workspace-write" };
            let mut a = s(&["exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox]);
            if let Some(id) = resume_id {
                a.push("resume".into());
                a.push(id.to_string());
            } else if latest {
                a.push("resume".into());
                a.push("--last".into());
            }
            a.push("-".into());
            a
        }
        Provider::Antigravity => {
            let mut a = s(&["--input-format", "stream-json", "--output-format", "stream-json"]);
            if let Some(id) = resume_id {
                a.push("--conversation".into());
                a.push(id.to_string());
            }
            a
        }
        Provider::Gemini => {
            let approval = match mode {
                Mode::Edits | Mode::Auto => "auto_edit",
                Mode::Ask | Mode::Plan => "default",
            };
            let mut a = s(&["-p", "Do the task described above.", "--output-format", "stream-json", "--approval-mode", approval]);
            if let Some(id) = resume_id {
                a.push("--resume".into());
                a.push(id.to_string());
            } else if latest {
                a.push("--resume".into());
                a.push("latest".into());
            }
            if !dirs.is_empty() {
                a.push("--include-directories".into());
                a.push(dirs.join(","));
            }
            a
        }
    }
}

fn stdin_for(p: Provider, prompt: &str, mode: Mode) -> Vec<u8> {
    let text = match (p, mode) {
        // Codex and Gemini have no plan mode of their own here: say it in words.
        (Provider::Codex | Provider::Gemini | Provider::Antigravity, Mode::Plan) => {
            format!("{prompt}\n\n(Only look around and write a plan. Do not change any files or run commands that change things.)")
        }
        _ => prompt.to_string(),
    };
    match p {
        Provider::Antigravity => {
            let mut line = serde_json::to_vec(&json!({"event": "user", "message": {"content": text}})).unwrap_or_default();
            line.push(b'\n');
            line
        }
        _ => text.into_bytes(),
    }
}

#[allow(clippy::too_many_arguments)]
fn run(app: &AppHandle, id: &str, p: Provider, program: &Path, cwd: &Path, prompt: &str, mode: Mode, resume: Resume, dirs: &[String], job: &Arc<Job>) -> Outcome {
    let mut args = args_for(p, mode, resume, dirs);
    let skips = p == Provider::Antigravity && agy_skips_own_check(mode, antigravity_hooks_gate(app));
    job.skips_own_check.store(skips, Ordering::Relaxed);
    if skips {
        args.push(AGY_SKIP_OWN_CHECK.into());
    }
    let group = Arc::new(crate::platform::KillGroup::new());
    let mut child = match chat::quiet_command(program)
        .args(&args)
        .current_dir(cwd)
        .env("MARSHMORI_TASK", id)
        .env_remove("MARSHMORI_INTERNAL")
        .env_remove("AIMOJI_INTERNAL")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Outcome::Failed(format!("เปิด {} ไม่ได้: {e}", p.label())),
    };
    group.add(&child);
    *job.group.lock().unwrap() = Some(group.clone());
    *job.pid.lock().unwrap() = Some(child.id());
    if job.cancelled.load(Ordering::Relaxed) {
        job.stop();
    }

    // The task goes in from its own thread (a long one must not block us while the tool
    // is busy writing). agy reads further turns from stdin, so its stays open until the
    // run is over; the others get end-of-input right away.
    let writer = child.stdin.take().map(|mut stdin| {
        let data = stdin_for(p, prompt, mode);
        let keep_open = p == Provider::Antigravity;
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
            let _ = stdin.flush();
            keep_open.then_some(stdin)
        })
    });
    let err_handle = child.stderr.take().map(chat::drain);
    // Lines come in on a thread of their own, so a run can be watched (and given up on)
    // even if something it started keeps the pipe open after it is gone.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).split(b'\n') {
                let Ok(line) = line else { break };
                if tx.send(String::from_utf8_lossy(&line).into_owned()).is_err() {
                    break;
                }
            }
        });
    }

    let start = Instant::now();
    let mut last_output = Instant::now();
    let mut exited_at: Option<Instant> = None;
    let mut status = None;
    let mut timed_out = false;
    let mut stream = Stream::new(p);
    let mut last_emit = Instant::now() - EMIT_EVERY;
    let mut pending = false;
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                last_output = Instant::now();
                if stream.feed(line.trim()) {
                    pending = true;
                }
                if stream.finished && p == Provider::Antigravity {
                    // agy waits for another turn on stdin: its answer is in, so it's done.
                    job_group_kill(&group, child.id());
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                if exited_at.is_none() {
                    status = child.wait().ok();
                }
                break;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        // Updates go out a few times a second, and the last one never waits for a next line.
        if pending && last_emit.elapsed() >= EMIT_EVERY {
            pending = false;
            last_emit = Instant::now();
            publish(app, id, p, &stream);
        }
        if exited_at.is_none() {
            if let Ok(Some(s)) = child.try_wait() {
                status = Some(s);
                exited_at = Some(Instant::now());
            }
        } else if exited_at.map(|t| t.elapsed() > Duration::from_secs(3)).unwrap_or(false) {
            // It's gone, but something it started still holds its output open: done waiting.
            break;
        }
        if exited_at.is_none() && (start.elapsed() > MAX_RUN || last_output.elapsed() > MAX_SILENCE) {
            timed_out = true;
            job_group_kill(&group, child.id());
        }
    }
    if status.is_none() {
        status = child.try_wait().ok().flatten();
    }
    // Whatever it left running goes too (Claude Code does the same with its own
    // background shells when a -p run ends).
    group.kill();
    drop(writer.and_then(|h| join_within(h, Duration::from_secs(2))).flatten());
    let stderr = err_handle.and_then(|h| join_within(h, Duration::from_secs(2))).unwrap_or_default();
    publish(app, id, p, &stream);

    if job.cancelled.load(Ordering::Relaxed) {
        return Outcome::Stopped;
    }
    if timed_out {
        return Outcome::Failed(format!("{} ทำนานเกินไป เลยหยุดไว้ก่อน", p.label()));
    }
    if let Some(err) = stream.error.clone() {
        return Outcome::Failed(chat::friendly_error(p, &err));
    }
    let ok = status.map(|s| s.success()).unwrap_or(false);
    let answer = stream.answer();
    if stream.finished || (ok && !answer.is_empty()) {
        let mut text = if answer.is_empty() { "เสร็จแล้ว (ไม่มีข้อความตอบกลับ)".to_string() } else { answer };
        if stream.denials > 0 {
            text.push_str(&format!("\n\n*(มีขั้นตอนที่ไม่ได้รับอนุญาต {} ครั้ง)*", stream.denials));
        }
        if stream.own_check_declined && mode != Mode::Plan {
            text.push_str("\n\n*(Antigravity ไม่ยอมรันคำสั่งเอง เพราะงานเบื้องหลังไม่มีใครตอบได้ — เชื่อม hooks ของ Antigravity ที่ ตั้งค่า › เชื่อมต่อ agent แล้วคำสั่งจะมาขออนุมัติที่ Mamori)*");
        }
        return Outcome::Done(text);
    }
    let detail = if stderr.trim().is_empty() { stream.raw_tail.clone() } else { stderr };
    if answer.is_empty() && rejected_option(&detail) {
        return Outcome::BadOption(detail);
    }
    Outcome::Failed(chat::friendly_error(p, &detail))
}

/// Stops a run: its whole group, and its process tree for good measure.
fn job_group_kill(group: &crate::platform::KillGroup, pid: u32) {
    group.kill();
    chat::kill_tree(pid);
}

/// The thread's result if it finishes within `limit` (else it is left to end on its own).
fn join_within<T: Send + 'static>(handle: std::thread::JoinHandle<T>, limit: Duration) -> Option<T> {
    let until = Instant::now() + limit;
    while !handle.is_finished() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(25));
    }
    if handle.is_finished() {
        handle.join().ok()
    } else {
        None
    }
}

/// What the stream told us so far goes onto the task.
fn publish(app: &AppHandle, id: &str, p: Provider, stream: &Stream) {
    let activity = stream.activity.clone();
    let session = stream.session.clone();
    let mut learned = false;
    update(app, id, |t| {
        if !activity.is_empty() {
            t.activity = activity;
        }
        if let Some(s) = session {
            if t.session_key.is_none() {
                t.session_key = session_key(p, &s);
            }
            learned = t.agent_session.as_deref() != Some(s.as_str());
            t.agent_session = Some(s);
        }
    });
    // Kept right away: if Marshmori quits mid-run, a follow-up still continues this
    // conversation instead of quietly starting a new one.
    if learned {
        save(app);
    }
}

fn session_key(p: Provider, agent_session: &str) -> Option<String> {
    let agent = match p {
        Provider::Claude => "claude",
        Provider::Codex => "codex",
        Provider::Antigravity => "antigravity",
        Provider::Gemini => return None,
    };
    Some(format!("{agent}:{agent_session}"))
}

fn finish(app: &AppHandle, id: &str, p: Provider, outcome: Outcome, job: &Arc<Job>) {
    let now = paths::now_ms();
    let outcome = match outcome {
        Outcome::BadOption(raw) => Outcome::Failed(chat::friendly_error(p, &raw)),
        other => other,
    };
    let (status, label) = match &outcome {
        Outcome::Done(_) => (Status::Done, "done"),
        Outcome::Failed(_) | Outcome::BadOption(_) => (Status::Error, "error"),
        Outcome::Stopped => (Status::Stopped, "stopped"),
    };
    update(app, id, |t| {
        t.status = status;
        t.activity = match &outcome {
            Outcome::Done(_) => "เสร็จแล้ว".into(),
            Outcome::Failed(e) | Outcome::BadOption(e) => short(e, 80),
            Outcome::Stopped => "หยุดแล้ว".into(),
        };
        if let Some(turn) = t.turns.last_mut() {
            turn.status = status;
            turn.ended_at = Some(now);
            match &outcome {
                Outcome::Done(text) => turn.result = clip_chars(text, MAX_RESULT_CHARS),
                Outcome::Failed(err) | Outcome::BadOption(err) => turn.error = Some(err.clone()),
                Outcome::Stopped => {}
            }
        }
    });
    let state = app.state::<AppState>();
    {
        let mut jobs = state.tasks.jobs.lock().unwrap();
        if jobs.get(id).map(|j| Arc::ptr_eq(j, job)).unwrap_or(false) {
            jobs.remove(id);
        }
    }
    // Its session in the island: a stopped run never says goodbye through its hooks (they
    // went with it), so it is closed here, and any card still waiting for it goes.
    let key = state.tasks.tasks.lock().unwrap().iter().find(|t| t.id == id).and_then(|t| t.session_key.clone());
    if let Some(key) = key {
        state.approvals.cancel_session(&key);
        let still_busy = state
            .sessions
            .lock()
            .unwrap()
            .get(&key)
            .map(|s| matches!(s.state, crate::sessions::State::Working | crate::sessions::State::Thinking | crate::sessions::State::Approval))
            .unwrap_or(false);
        if still_busy {
            let (session_state, text) = match status {
                Status::Done => (crate::sessions::State::Done, "เสร็จแล้ว"),
                Status::Error => (crate::sessions::State::Error, "มีปัญหา"),
                _ => (crate::sessions::State::Idle, "หยุดแล้ว"),
            };
            state.sessions.lock().unwrap().set_state(&key, session_state, text);
            crate::pipeline::emit_sessions(app);
            crate::pipeline::emit_approvals(app);
        }
    }
    save(app);
    log::line(format!("task {id}: {} {label}", p.id()));
}

// ── Reading what each tool prints ───────────────────────────────────────────────

/// Follows one run's JSON lines: the conversation id, what it is doing, the answer.
pub(crate) struct Stream {
    p: Provider,
    pub session: Option<String>,
    pub activity: String,
    /// Text of the agent's latest message.
    message: String,
    /// The answer, when the tool says which one it is.
    final_text: Option<String>,
    pub finished: bool,
    pub error: Option<String>,
    raw_tail: String,
    /// Codex: text so far of each message item.
    items: HashMap<String, String>,
    /// Gemini: the last thing seen was a tool call (the next text starts a new message).
    after_tool: bool,
    pub denials: usize,
    /// agy: its own permission check declined a step (nobody can answer it in print mode).
    pub own_check_declined: bool,
}

impl Stream {
    pub(crate) fn new(p: Provider) -> Self {
        Stream {
            p,
            session: None,
            activity: String::new(),
            message: String::new(),
            final_text: None,
            finished: false,
            error: None,
            raw_tail: String::new(),
            items: HashMap::new(),
            after_tool: false,
            denials: 0,
            own_check_declined: false,
        }
    }

    /// The final answer of the run.
    pub(crate) fn answer(&self) -> String {
        self.final_text.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| self.message.clone()).trim().to_string()
    }

    /// One line of output. True when something worth showing changed.
    pub(crate) fn feed(&mut self, line: &str) -> bool {
        if line.is_empty() {
            return false;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            self.raw_tail.push_str(line);
            self.raw_tail.push('\n');
            if self.raw_tail.len() > 4000 {
                let cut = self.raw_tail.len() - 4000;
                let cut = (cut..self.raw_tail.len()).find(|&i| self.raw_tail.is_char_boundary(i)).unwrap_or(0);
                self.raw_tail.drain(..cut);
            }
            return false;
        };
        match self.p {
            Provider::Claude => self.claude(&v),
            Provider::Codex => self.codex(&v),
            Provider::Antigravity => self.antigravity(&v),
            Provider::Gemini => self.gemini(&v),
        }
    }

    fn doing(&mut self, text: String) -> bool {
        if text.is_empty() || text == self.activity {
            return false;
        }
        self.activity = text;
        true
    }

    fn claude(&mut self, v: &Value) -> bool {
        match v["type"].as_str().unwrap_or("") {
            "system" => match v["subtype"].as_str() {
                Some("init") => {
                    self.session = v["session_id"].as_str().map(str::to_string);
                    self.doing("เริ่มทำงาน".into())
                }
                Some("api_retry") => {
                    let kind = v["error"].as_str().unwrap_or("");
                    if matches!(kind, "authentication_failed" | "billing_error" | "oauth_org_not_allowed" | "account_on_hold") && v["attempt"].as_u64().unwrap_or(0) >= 2 {
                        self.error = Some(kind.replace('_', " "));
                    }
                    self.doing("ลองเชื่อมต่อใหม่…".into())
                }
                _ => false,
            },
            "assistant" => {
                let sub = v["parent_tool_use_id"].is_string();
                let mut text = String::new();
                let mut tool: Option<String> = None;
                for b in v["message"]["content"].as_array().into_iter().flatten() {
                    match b["type"].as_str() {
                        Some("text") => text.push_str(b["text"].as_str().unwrap_or("")),
                        Some("tool_use") => {
                            let name = b["name"].as_str().unwrap_or("tool");
                            tool = Some(agents::describe(name, &b["input"]).summary);
                        }
                        _ => {}
                    }
                }
                if !sub && !text.trim().is_empty() {
                    self.message = text.clone();
                }
                match tool {
                    Some(t) if sub => self.doing(format!("ผู้ช่วย: {t}")),
                    Some(t) => self.doing(t),
                    None if !sub && !text.trim().is_empty() => self.doing(short(&text, 80)),
                    None => false,
                }
            }
            "result" => {
                self.finished = true;
                if let Some(s) = v["session_id"].as_str() {
                    self.session = Some(s.to_string());
                }
                self.denials = v["permission_denials"].as_array().map(Vec::len).unwrap_or(0);
                let text = v["result"].as_str().unwrap_or("").to_string();
                if v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().map(|s| s.starts_with("error")).unwrap_or(false) {
                    self.error = Some(if text.is_empty() { v["subtype"].as_str().unwrap_or("error").replace('_', " ") } else { text });
                } else {
                    // It got through in the end: a sign-in hiccup it retried past doesn't count.
                    self.error = None;
                    self.final_text = Some(text);
                }
                true
            }
            _ => false,
        }
    }

    fn codex(&mut self, v: &Value) -> bool {
        match v["type"].as_str() {
            Some("thread.started") => {
                self.session = v["thread_id"].as_str().map(str::to_string);
                self.doing("เริ่มทำงาน".into())
            }
            Some("item.started") | Some("item.updated") | Some("item.completed") => {
                let item = &v["item"];
                match item["type"].as_str() {
                    Some("agent_message") => {
                        let id = item["id"].as_str().unwrap_or("").to_string();
                        let t = item["text"].as_str().unwrap_or("").to_string();
                        self.items.insert(id, t.clone());
                        if !t.trim().is_empty() {
                            self.message = t.clone();
                            return self.doing(short(&t, 80));
                        }
                        false
                    }
                    Some("command_execution") => {
                        let cmd = item["command"].as_str().unwrap_or("");
                        self.doing(format!("รัน {}", short(&unwrap_shell(cmd), 70)))
                    }
                    Some("file_change") => {
                        let names: Vec<String> = item["changes"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|c| c["path"].as_str())
                            .map(|p| agents::basename(p).to_string())
                            .take(3)
                            .collect();
                        self.doing(if names.is_empty() { "แก้ไฟล์".into() } else { format!("แก้ไข {}", names.join(", ")) })
                    }
                    Some("reasoning") => self.doing("กำลังคิด…".into()),
                    Some("web_search") => self.doing(format!("ค้นเว็บ: {}", short(item["query"].as_str().unwrap_or(""), 60))),
                    Some("mcp_tool_call") => self.doing(format!("ใช้ {}", item["tool"].as_str().unwrap_or("เครื่องมือ"))),
                    _ => false,
                }
            }
            Some("turn.completed") => {
                self.finished = true;
                true
            }
            Some("turn.failed") => {
                self.finished = true;
                self.error = Some(v["error"]["message"].as_str().unwrap_or("turn failed").to_string());
                true
            }
            Some("error") => {
                let msg = v["message"].as_str().unwrap_or("");
                if !msg.to_lowercase().contains("reconnect") {
                    self.raw_tail.push_str(msg);
                    self.raw_tail.push('\n');
                }
                false
            }
            _ => false,
        }
    }

    fn antigravity(&mut self, v: &Value) -> bool {
        if let Some(id) = find_id(v) {
            if self.session.as_deref() != Some(id.as_str()) {
                self.session = Some(id);
            }
        }
        // agy reports a failure on a line of its own: {"status":"ERROR","error":"…"}.
        if v["status"].as_str().map(|s| s.eq_ignore_ascii_case("error")).unwrap_or(false) || v["event"].as_str() == Some("error") {
            self.finished = true;
            let why = v["error"]
                .as_str()
                .or(v["message"].as_str())
                .or(v["error"]["message"].as_str())
                .unwrap_or("Antigravity stopped with an error");
            self.error = Some(why.to_string());
            return true;
        }
        match v["event"].as_str() {
            Some("init") => self.doing("เริ่มทำงาน".into()),
            Some("step_update") => {
                let s = &v["step_update"];
                let failed = s["tool_info"]["error"]["message"].as_str().unwrap_or("");
                if failed.contains("permission check failed") {
                    self.own_check_declined = true;
                }
                let kind = s["step_type"].as_str().unwrap_or("");
                if kind.is_empty() || kind == "agent_response" {
                    if let Some(t) = s["text_delta"].as_str() {
                        if self.after_tool {
                            self.message.clear();
                            self.after_tool = false;
                        }
                        self.message.push_str(t);
                    }
                    false
                } else {
                    // A tool step: whatever it says next is a new message.
                    self.after_tool = true;
                    let what = s["title"].as_str().or(s["description"].as_str()).or(s["tool_name"].as_str()).unwrap_or("กำลังทำงาน…");
                    self.doing(short(what, 80))
                }
            }
            Some("result") => {
                self.finished = true;
                let r = &v["result"];
                let status = r["status"].as_str().unwrap_or("SUCCESS");
                if status != "SUCCESS" {
                    self.error = Some(r["error"].as_str().unwrap_or(status).to_string());
                } else if let Some(t) = r["response"].as_str() {
                    self.final_text = Some(t.to_string());
                }
                true
            }
            _ => false,
        }
    }

    fn gemini(&mut self, v: &Value) -> bool {
        match v["type"].as_str() {
            Some("init") => {
                self.session = v["session_id"].as_str().map(str::to_string);
                self.doing("เริ่มทำงาน".into())
            }
            Some("message") if v["role"] == "assistant" => {
                let t = v["content"].as_str().unwrap_or("");
                if self.after_tool {
                    self.message.clear();
                    self.after_tool = false;
                }
                if v["delta"].as_bool().unwrap_or(false) {
                    self.message.push_str(t);
                } else {
                    self.message = t.to_string();
                }
                false
            }
            Some("tool_use") => {
                self.after_tool = true;
                let name = v["tool_name"].as_str().unwrap_or("tool");
                let summary = agents::describe(name, &v["parameters"]).summary;
                self.doing(summary)
            }
            Some("result") => {
                self.finished = true;
                if v["status"].as_str().unwrap_or("success") != "success" {
                    self.error = Some(v["error"]["message"].as_str().or(v["error"].as_str()).unwrap_or("error").to_string());
                }
                true
            }
            Some("error") => {
                let msg = v["message"].as_str().unwrap_or("");
                self.raw_tail.push_str(msg);
                self.raw_tail.push('\n');
                false
            }
            _ => false,
        }
    }
}

/// `bash -lc 'npm test'` → `npm test` (Codex wraps every command in a shell).
fn unwrap_shell(cmd: &str) -> String {
    let c = cmd.trim();
    for prefix in ["bash -lc ", "bash -c ", "/bin/bash -lc ", "sh -c ", "powershell.exe -Command ", "pwsh -Command ", "cmd.exe /c "] {
        if let Some(rest) = c.strip_prefix(prefix) {
            let rest = rest.trim();
            let unq = rest.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')).or_else(|| rest.strip_prefix('"').and_then(|r| r.strip_suffix('"'))).unwrap_or(rest);
            return unq.to_string();
        }
    }
    c.to_string()
}

/// Antigravity names its conversation in a few places; the first one found.
fn find_id(v: &Value) -> Option<String> {
    for key in ["conversation_id", "conversationId"] {
        if let Some(id) = v.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    for inner in ["init", "result"] {
        if let Some(obj) = v.get(inner) {
            for key in ["conversation_id", "conversationId"] {
                if let Some(id) = obj.get(key).and_then(Value::as_str) {
                    return Some(id.to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(p: Provider, lines: &[&str]) -> Stream {
        let mut s = Stream::new(p);
        for l in lines {
            s.feed(l);
        }
        s
    }

    #[test]
    fn permission_levels_map_onto_each_agents_own_modes() {
        let claude = args_for(Provider::Claude, Mode::Ask, Resume::New, &[]);
        assert!(claude.windows(2).any(|w| w == ["--permission-mode", "default"]));
        assert!(args_for(Provider::Claude, Mode::Edits, Resume::New, &[]).windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]));
        assert!(args_for(Provider::Claude, Mode::Plan, Resume::Session("abc"), &[]).windows(2).any(|w| w == ["--resume", "abc"]));
        let codex = args_for(Provider::Codex, Mode::Plan, Resume::New, &[]);
        assert!(codex.windows(2).any(|w| w == ["--sandbox", "read-only"]));
        assert_eq!(codex.last().map(String::as_str), Some("-"));
        let codex = args_for(Provider::Codex, Mode::Edits, Resume::Session("th1"), &[]);
        assert!(codex.windows(2).any(|w| w == ["--sandbox", "workspace-write"]));
        assert!(codex.ends_with(&["resume".to_string(), "th1".to_string(), "-".to_string()]));
        assert!(args_for(Provider::Gemini, Mode::Edits, Resume::New, &[]).windows(2).any(|w| w == ["--approval-mode", "auto_edit"]));
        assert!(args_for(Provider::Antigravity, Mode::Ask, Resume::Session("c9"), &[]).windows(2).any(|w| w == ["--conversation", "c9"]));
    }

    #[test]
    fn picking_up_the_latest_conversation_in_the_folder() {
        assert!(args_for(Provider::Claude, Mode::Ask, Resume::Latest, &[]).contains(&"--continue".to_string()));
        let codex = args_for(Provider::Codex, Mode::Edits, Resume::Latest, &[]);
        assert!(codex.ends_with(&["resume".to_string(), "--last".to_string(), "-".to_string()]));
        assert!(args_for(Provider::Gemini, Mode::Ask, Resume::Latest, &[]).windows(2).any(|w| w == ["--resume", "latest"]));
        assert!(!can_continue(Provider::Antigravity));
        // A follow-up resumes its own conversation, never "the latest".
        assert!(!args_for(Provider::Claude, Mode::Ask, Resume::Session("s"), &[]).contains(&"--continue".to_string()));
    }

    #[test]
    fn attached_files_are_named_to_the_agent_and_their_folders_opened() {
        let dir = std::env::temp_dir().join(format!("marshmori-attach-{}", std::process::id()));
        let inside = dir.join("proj");
        let outside = dir.join("Desktop");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let a = inside.join("a.ts");
        let b = outside.join("shot.png");
        std::fs::write(&a, "x").unwrap();
        std::fs::write(&b, "x").unwrap();
        let files = attachments(&[a.display().to_string(), b.display().to_string(), a.display().to_string()]).unwrap();
        assert_eq!(files.len(), 2, "no repeats");
        assert!(attachments(&["relative/x.ts".into()]).is_err());
        assert!(attachments(&[dir.join("gone.txt").display().to_string()]).is_err());
        let msg = with_files("fix it", &files);
        assert!(msg.starts_with("fix it\n\n") && msg.contains(&b.display().to_string()));
        assert_eq!(with_files("fix it", &[]), "fix it");
        let extra = outside_dirs(&inside, &files);
        assert_eq!(extra, vec![outside.display().to_string()], "only folders outside the working one");
        let claude = args_for(Provider::Claude, Mode::Ask, Resume::New, &extra);
        assert!(claude.windows(2).any(|w| w[0] == "--add-dir" && w[1] == extra[0]));
        assert!(args_for(Provider::Gemini, Mode::Ask, Resume::New, &extra).contains(&"--include-directories".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_older_cli_gets_a_second_try_without_the_option_it_refused() {
        let said = "error: option '--permission-mode <mode>' argument 'auto' is invalid. Allowed choices are acceptEdits, bypassPermissions, default, plan.";
        assert!(rejected_option(said));
        assert!(!rejected_option("Error: rate limit reached"));
        let (mode, resume, _) = fallback(Provider::Claude, Mode::Auto, Resume::New, said).unwrap();
        assert_eq!((mode, resume), (Mode::Edits, Resume::New));
        let (mode, resume, _) = fallback(Provider::Codex, Mode::Edits, Resume::Latest, "error: unexpected argument '--last' found").unwrap();
        assert_eq!((mode, resume), (Mode::Edits, Resume::New));
        assert!(fallback(Provider::Codex, Mode::Edits, Resume::New, "error: unexpected argument").is_none());
    }

    #[test]
    fn the_task_never_rides_on_the_command_line() {
        let secret = "แก้บั๊กใน src/pay.ts ให้หน่อย";
        for p in Provider::ALL {
            for m in [Mode::Ask, Mode::Edits, Mode::Auto, Mode::Plan] {
                assert!(!args_for(p, m, Resume::Session("x"), &[]).iter().any(|a| a.contains(secret)));
                assert!(String::from_utf8(stdin_for(p, secret, m)).unwrap().contains(secret));
            }
        }
    }

    #[test]
    fn claude_runs_report_session_activity_and_answer() {
        let s = feed_all(
            Provider::Claude,
            &[
                r#"{"type":"system","subtype":"init","session_id":"s-1"}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ดูไฟล์ก่อนนะ"},{"type":"tool_use","name":"Read","input":{"file_path":"/w/a.ts"}}]}}"#,
                r#"{"type":"assistant","parent_tool_use_id":"x","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"แก้เสร็จแล้ว"}]}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"แก้ a.ts เรียบร้อย","session_id":"s-1","permission_denials":[{"tool_name":"Bash"}]}"#,
            ],
        );
        assert_eq!(s.session.as_deref(), Some("s-1"));
        assert!(s.finished && s.error.is_none());
        assert_eq!(s.answer(), "แก้ a.ts เรียบร้อย");
        assert_eq!(s.denials, 1);
    }

    #[test]
    fn a_retried_sign_in_hiccup_is_forgotten_when_the_run_succeeds() {
        let s = feed_all(
            Provider::Claude,
            &[
                r#"{"type":"system","subtype":"api_retry","error":"authentication_failed","attempt":2}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s"}"#,
            ],
        );
        assert!(s.error.is_none());
        assert_eq!(s.answer(), "ok");
    }

    #[test]
    fn antigravity_errors_on_their_own_line_end_the_run() {
        let s = feed_all(Provider::Antigravity, &[r#"{"status":"ERROR","error":"quota exhausted"}"#]);
        assert!(s.finished);
        assert_eq!(s.error.as_deref(), Some("quota exhausted"));
    }

    #[test]
    fn claude_errors_come_through() {
        let s = feed_all(Provider::Claude, &[r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}"#]);
        assert_eq!(s.error.as_deref(), Some("error max turns"));
    }

    #[test]
    fn codex_runs_report_commands_files_and_the_last_message() {
        let mut s = Stream::new(Provider::Codex);
        s.feed(r#"{"type":"thread.started","thread_id":"th-9"}"#);
        s.feed(r#"{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"bash -lc 'npm test'"}}"#);
        assert_eq!(s.activity, "รัน npm test");
        s.feed(r#"{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"/w/src/app.ts","kind":"update"}]}}"#);
        assert_eq!(s.activity, "แก้ไข app.ts");
        s.feed(r#"{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"ผ่านหมดแล้ว"}}"#);
        s.feed(r#"{"type":"turn.completed","usage":{}}"#);
        assert_eq!(s.session.as_deref(), Some("th-9"));
        assert!(s.finished);
        assert_eq!(s.answer(), "ผ่านหมดแล้ว");
    }

    #[test]
    fn gemini_keeps_the_text_after_the_last_tool() {
        let s = feed_all(
            Provider::Gemini,
            &[
                r#"{"type":"init","session_id":"g1"}"#,
                r#"{"type":"message","role":"assistant","content":"เดี๋ยวดูก่อน","delta":true}"#,
                r#"{"type":"tool_use","tool_name":"read_file","parameters":{"file_path":"a.md"}}"#,
                r#"{"type":"message","role":"assistant","content":"สรุป: ","delta":true}"#,
                r#"{"type":"message","role":"assistant","content":"ไฟล์นี้คือ README","delta":true}"#,
                r#"{"type":"result","status":"success"}"#,
            ],
        );
        assert_eq!(s.answer(), "สรุป: ไฟล์นี้คือ README");
        assert_eq!(s.session.as_deref(), Some("g1"));
    }

    #[test]
    fn antigravity_finds_its_conversation() {
        let s = feed_all(
            Provider::Antigravity,
            &[
                r#"{"event":"init","init":{"conversation_id":"c-7"}}"#,
                r#"{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"ได้เลย"}}"#,
                r#"{"event":"result","result":{"status":"SUCCESS","response":"ทำเสร็จแล้ว","conversation_id":"c-7"}}"#,
            ],
        );
        assert_eq!(s.session.as_deref(), Some("c-7"));
        assert_eq!(s.answer(), "ทำเสร็จแล้ว");
    }

    #[test]
    fn agy_skips_its_own_check_only_where_marshmori_is_the_gate() {
        for mode in [Mode::Ask, Mode::Edits, Mode::Auto] {
            assert!(agy_skips_own_check(mode, true), "{mode:?}: the island's card is the gate");
            assert!(!agy_skips_own_check(mode, false), "{mode:?}: no hooks, agy keeps its own check");
        }
        assert!(!agy_skips_own_check(Mode::Plan, true), "a plan never runs without agy's check");
        // The flag isn't part of the plain arguments: run() adds it only after checking the hooks.
        for mode in [Mode::Ask, Mode::Edits, Mode::Auto, Mode::Plan] {
            assert!(!args_for(Provider::Antigravity, mode, Resume::New, &[]).iter().any(|a| a == AGY_SKIP_OWN_CHECK));
        }
    }

    #[test]
    fn agy_declining_on_its_own_is_noticed() {
        // As agy 1.3.5 prints it in print mode, without --dangerously-skip-permissions.
        let declined = r#"{"event":"step_update","step_update":{"conversation_id":"e6","step_index":5,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo probe"},"error":{"type":"TOOL_ERROR","message":"permission check failed for command \"echo probe\": user denied permission to run command:\necho probe"}}}}"#;
        assert!(feed_all(Provider::Antigravity, &[declined]).own_check_declined);
        let fine = r#"{"event":"step_update","step_update":{"step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"}}}}"#;
        assert!(!feed_all(Provider::Antigravity, &[fine]).own_check_declined);
    }

    #[test]
    fn shell_wrappers_are_peeled_off() {
        assert_eq!(unwrap_shell("bash -lc 'npm run build'"), "npm run build");
        assert_eq!(unwrap_shell("git status"), "git status");
    }
}
