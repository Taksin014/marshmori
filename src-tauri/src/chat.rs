// Chat with Mamori through the coding agents the user already has: Claude Code,
// Codex, Antigravity (agy) and Gemini CLI, each run as its own command-line tool and
// signed in the way it already is. No API keys: a message here counts against that
// tool's plan exactly like typing it in the tool's own window.
//
// How a message goes out:
// * The prompt only ever travels on stdin, never on the command line.
// * The tool runs in Marshmori's own chat folder with read-only tools (it may read the
//   files you attached, nothing else), with no console window.
// * MARSHMORI_INTERNAL=1 tells Marshmori's hook relay to stand aside (and Claude Code is
//   also told to skip hooks), so a side chat never shows up as a session or asks for
//   approvals.
// * Each turn is a fresh run that gets the recent conversation as a transcript.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::files::{self, Staged};
use crate::{island, log, paths, AppState};

/// Longest a reply may take, and longest the tool may stay silent.
const MAX_RUN: Duration = Duration::from_secs(6 * 60);
const MAX_SILENCE: Duration = Duration::from_secs(150);
/// How much of the conversation goes back in with every turn.
const MAX_TURNS: usize = 16;
const MAX_TRANSCRIPT_CHARS: usize = 14_000;
/// Status checks (`claude auth status`…) are slow-ish: remembered this long.
const STATUS_TTL: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Claude,
    Codex,
    Antigravity,
    Gemini,
}

impl Provider {
    /// Also the order "auto" tries them in.
    pub const ALL: [Provider; 4] = [Provider::Claude, Provider::Codex, Provider::Antigravity, Provider::Gemini];

    pub fn id(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Antigravity => "antigravity",
            Provider::Gemini => "gemini",
        }
    }

    pub fn parse(s: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|p| p.id() == s)
    }

    pub fn label(self) -> &'static str {
        match self {
            Provider::Claude => "Claude Code",
            Provider::Codex => "Codex",
            Provider::Antigravity => "Antigravity",
            Provider::Gemini => "Gemini CLI",
        }
    }

    /// The command the user types.
    pub fn program(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Antigravity => "agy",
            Provider::Gemini => "gemini",
        }
    }

    fn account(self) -> &'static str {
        match self {
            Provider::Claude => "บัญชี Claude",
            Provider::Codex => "บัญชี ChatGPT",
            Provider::Antigravity | Provider::Gemini => "บัญชี Google",
        }
    }
}

// ── Finding the tools ───────────────────────────────────────────────────────────

/// Folders installers commonly use but that may be missing from PATH (an app started
/// at login keeps the PATH it was given then).
fn extra_dirs(program: &str) -> Vec<PathBuf> {
    let home = paths::home_dir();
    let mut dirs = vec![home.join(".local").join("bin")];
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            dirs.push(appdata.join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join("Microsoft").join("WinGet").join("Links"));
            dirs.push(local.join("pnpm"));
            dirs.push(local.join("Programs").join(program));
            dirs.push(local.join("Programs").join(program).join("bin"));
            dirs.push(local.join(program));
            dirs.push(local.join(program).join("bin"));
        }
        dirs.push(home.join("scoop").join("shims"));
        dirs.push(home.join(".bun").join("bin"));
        if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
            dirs.push(pf.join("nodejs"));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = program;
        dirs.push(home.join(".npm-global").join("bin"));
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    dirs
}

pub fn find_program(program: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    let exts: &[&str] = &[".exe", ".cmd", ".bat"];
    #[cfg(not(windows))]
    let exts: &[&str] = &[""];
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend(extra_dirs(program));
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for ext in exts {
            let candidate = dir.join(format!("{program}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// A command with no console window, that Marshmori's hooks ignore (AIMoji's old relay
/// too, should an agent still have it).
fn command(program: &Path) -> Command {
    let mut c = quiet_command(program);
    c.env("MARSHMORI_INTERNAL", "1").env("AIMOJI_INTERNAL", "1");
    c
}

/// A command with no console window and no colours, in a process group of its own.
/// Its hooks do report to Marshmori (tasks Mamori runs show up like any session).
pub(crate) fn quiet_command(program: &Path) -> Command {
    let mut c = Command::new(program);
    c.env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so a cancel stops everything it started.
        c.process_group(0);
    }
    c
}

/// Stops a run and whatever it started (node, its helpers…).
pub(crate) fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = command(Path::new("taskkill"))
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // "--" so the negative number (the whole process group) isn't read as an option.
        let _ = Command::new("kill").args(["-TERM", "--", &format!("-{pid}")]).stderr(Stdio::null()).status();
    }
}

/// Runs a short command and returns its exit code and output (stdout + stderr).
fn run_quick(program: &Path, args: &[&str], timeout: Duration) -> Option<(i32, String)> {
    let mut child = command(program)
        .args(args)
        .current_dir(chat_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let out = child.stdout.take().map(drain);
    let err = child.stderr.take().map(drain);
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) if start.elapsed() > timeout => {
                kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return None,
        }
    };
    let mut text = out.and_then(|h| h.join().ok()).unwrap_or_default();
    text.push('\n');
    text.push_str(&err.and_then(|h| h.join().ok()).unwrap_or_default());
    Some((code, text))
}

/// Reads a pipe to the end (a tool that writes to a pipe nobody reads stalls or
/// fails) and keeps the last 256 KB, which is where an error message is.
pub(crate) fn drain<R: Read + Send + 'static>(mut r: R) -> std::thread::JoinHandle<String> {
    const KEEP: usize = 256 * 1024;
    std::thread::spawn(move || {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match r.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > 2 * KEEP {
                        buf.drain(..buf.len() - KEEP);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        if buf.len() > KEEP {
            buf.drain(..buf.len() - KEEP);
        }
        String::from_utf8_lossy(&buf).into_owned()
    })
}

// ── What is installed and signed in ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub program: &'static str,
    pub installed: bool,
    pub path: Option<String>,
    /// Some(true) signed in, Some(false) not, None: the tool can't tell us.
    pub signed_in: Option<bool>,
    /// One line for the settings window.
    pub detail: String,
    /// Uses an API key, so every message is billed (worth knowing).
    pub billed: bool,
}

fn status_of(p: Provider) -> ProviderStatus {
    let path = find_program(p.program());
    let mut s = ProviderStatus {
        id: p.id(),
        label: p.label(),
        program: p.program(),
        installed: path.is_some(),
        path: path.as_ref().map(|x| x.display().to_string()),
        signed_in: None,
        detail: String::new(),
        billed: false,
    };
    let Some(path) = path else {
        s.detail = format!("ยังไม่พบในเครื่องนี้ — ติดตั้งแล้วเปิด {} ใน terminal เพื่อล็อกอินหนึ่งครั้ง", p.program());
        return s;
    };
    match p {
        Provider::Claude => match run_quick(&path, &["auth", "status"], Duration::from_secs(12)) {
            Some((code, out)) => {
                let info = out.find('{').and_then(|i| serde_json::from_str::<Value>(out[i..].trim()).ok().or_else(|| first_json(&out[i..])));
                let logged = info.as_ref().and_then(|v| v["loggedIn"].as_bool()).unwrap_or(code == 0);
                let method = info.as_ref().and_then(|v| v["authMethod"].as_str()).unwrap_or("").to_string();
                let email = info.as_ref().and_then(|v| v["email"].as_str().or(v["account"]["email"].as_str())).map(str::to_string);
                if out.contains("unknown command") || out.contains("Unknown command") {
                    s.detail = "ติดตั้งแล้ว (เวอร์ชันนี้บอกสถานะล็อกอินไม่ได้)".into();
                } else if logged {
                    s.signed_in = Some(true);
                    s.billed = matches!(method.as_str(), "api_key" | "api_key_helper");
                    s.detail = if s.billed {
                        "ล็อกอินด้วย API key — ข้อความจะถูกคิดเงินตามการใช้งาน".into()
                    } else {
                        match email {
                            Some(e) => format!("ใช้แพ็กเกจ Claude ที่ล็อกอินไว้ ({e})"),
                            None => "ใช้แพ็กเกจ Claude ที่ล็อกอินไว้".into(),
                        }
                    };
                } else {
                    s.signed_in = Some(false);
                    s.detail = "ยังไม่ได้ล็อกอิน — เปิด terminal แล้วพิมพ์ claude เพื่อล็อกอิน".into();
                }
            }
            None => s.detail = "ติดตั้งแล้ว (เช็กสถานะล็อกอินไม่ทัน)".into(),
        },
        Provider::Codex => match run_quick(&path, &["login", "status"], Duration::from_secs(12)) {
            Some((code, out)) => {
                let lower = out.to_lowercase();
                if code == 0 && lower.contains("logged in") {
                    s.signed_in = Some(true);
                    s.billed = lower.contains("api key");
                    s.detail = if s.billed {
                        "ล็อกอินด้วย API key — ข้อความจะถูกคิดเงินตามการใช้งาน".into()
                    } else {
                        "ใช้แพ็กเกจ ChatGPT ที่ล็อกอินไว้".into()
                    };
                } else if lower.contains("not logged in") || code != 0 {
                    s.signed_in = Some(false);
                    s.detail = "ยังไม่ได้ล็อกอิน — เปิด terminal แล้วพิมพ์ codex login".into();
                } else {
                    s.detail = "ติดตั้งแล้ว".into();
                }
            }
            None => s.detail = "ติดตั้งแล้ว (เช็กสถานะล็อกอินไม่ทัน)".into(),
        },
        Provider::Antigravity | Provider::Gemini => {
            s.detail = format!("ใช้{}ที่ล็อกอินไว้ใน {}", p.account(), p.program());
        }
    }
    s
}

fn first_json(text: &str) -> Option<Value> {
    serde_json::Deserializer::from_str(text).into_iter::<Value>().next()?.ok()
}

/// Every provider, checked in parallel (and remembered for a while).
pub fn providers(app: &AppHandle, refresh: bool) -> Vec<ProviderStatus> {
    let state = app.state::<AppState>();
    if !refresh {
        if let Some((at, list)) = state.chat.status.lock().unwrap().as_ref() {
            if at.elapsed() < STATUS_TTL {
                return list.clone();
            }
        }
    }
    let _ = std::fs::create_dir_all(chat_dir());
    let handles: Vec<_> = Provider::ALL.into_iter().map(|p| std::thread::spawn(move || status_of(p))).collect();
    let list: Vec<ProviderStatus> = handles
        .into_iter()
        .zip(Provider::ALL)
        .map(|(h, p)| h.join().unwrap_or_else(|_| status_of(p)))
        .collect();
    *state.chat.status.lock().unwrap() = Some((Instant::now(), list.clone()));
    list
}

/// The provider a message goes to: the one asked for, else the one in the settings,
/// else the first one installed.
fn resolve(asked: &str, preferred: &str) -> Result<(Provider, PathBuf), String> {
    for want in [asked, preferred] {
        if let Some(p) = Provider::parse(want) {
            return match find_program(p.program()) {
                Some(path) => Ok((p, path)),
                None => Err(format!(
                    "ยังไม่พบ {} ในเครื่องนี้ — ติดตั้งแล้วเปิด {} ใน terminal เพื่อล็อกอินหนึ่งครั้ง หรือเลือกตัวอื่นในตั้งค่า › แชท",
                    p.label(),
                    p.program()
                )),
            };
        }
    }
    Provider::ALL
        .into_iter()
        .find_map(|p| find_program(p.program()).map(|path| (p, path)))
        .ok_or_else(|| "ยังไม่มี Claude Code, Codex, Antigravity หรือ Gemini CLI ในเครื่องนี้ — ติดตั้งตัวใดตัวหนึ่งแล้วล็อกอินใน terminal ก่อน".into())
}

// ── A conversation ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub text: String,
    /// Paths of files attached to this message.
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    /// "auto", or one of claude | codex | antigravity | gemini.
    pub provider: String,
    pub messages: Vec<ChatMessage>,
    /// Files for the last message (older clients).
    #[serde(default)]
    pub attachments: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatEvent {
    pub id: String,
    /// start | delta | done | error | cancelled
    pub kind: &'static str,
    pub text: String,
}

struct Job {
    cancelled: AtomicBool,
    pid: Mutex<Option<u32>>,
}

#[derive(Default)]
pub struct ChatState {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    counter: AtomicU64,
    status: Mutex<Option<(Instant, Vec<ProviderStatus>)>>,
}

pub fn chat_dir() -> PathBuf {
    paths::local_dir().join("chat")
}

fn emit(app: &AppHandle, id: &str, kind: &'static str, text: &str) {
    let _ = app.emit_to(island::LABEL, "chat", ChatEvent { id: id.to_string(), kind, text: text.to_string() });
}

/// Only user/assistant turns with something in them, alternating, starting with the
/// user, and not too many.
fn tidy(messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::new();
    for m in messages {
        if (m.text.trim().is_empty() && m.files.is_empty()) || !(m.role == "user" || m.role == "assistant") {
            continue;
        }
        if out.is_empty() && m.role != "user" {
            continue;
        }
        match out.last_mut() {
            Some(last) if last.role == m.role => {
                last.text.push_str("\n\n");
                last.text.push_str(&m.text);
                last.files.extend(m.files);
            }
            _ => out.push(m),
        }
    }
    let skip = out.len().saturating_sub(MAX_TURNS);
    let mut out: Vec<ChatMessage> = out.into_iter().skip(skip).collect();
    while out.first().map(|m| m.role != "user").unwrap_or(false) {
        out.remove(0);
    }
    out
}

/// The whole prompt: who Mamori is, the conversation so far, and where the files are.
pub fn build_prompt(name: &str, messages: &[ChatMessage], staged: &HashMap<String, Staged>, closing: bool) -> String {
    let mut p = String::new();
    p.push_str(&format!(
        "You are {name} (full name Marshmori), a small marshmallow sprout who lives at the top of the user's screen \
in the Marshmori desktop app and keeps an eye on their coding agents. Right now you are a side chat: answer questions, \
explain things and help think problems through. Do not create, edit or delete files and do not run commands. \
Reply in the language of the user's last message (usually Thai), short and practical, in Markdown with code in fenced blocks.\n"
    ));
    if !staged.is_empty() {
        p.push_str("\nFiles the user attached are in the current folder (paths below); open them if you need to.\n");
    }
    p.push_str("\nConversation:\n");
    // Newest turns win when the transcript is too long.
    let mut blocks: Vec<String> = Vec::new();
    let mut used = 0usize;
    for m in messages.iter().rev() {
        let who = if m.role == "user" { "User".to_string() } else { name.to_string() };
        let mut block = format!("\n[{who}]\n{}\n", m.text.trim());
        let files: Vec<&str> = m.files.iter().filter_map(|f| staged.get(f)).map(|s| s.rel.as_str()).collect();
        if !files.is_empty() {
            block.push_str(&format!("(attached: {})\n", files.join(", ")));
        }
        if used + block.len() > MAX_TRANSCRIPT_CHARS && !blocks.is_empty() {
            break;
        }
        used += block.len();
        blocks.push(block);
    }
    for b in blocks.into_iter().rev() {
        p.push_str(&b);
    }
    if closing {
        p.push_str(&format!("\nReply to the user's last message as {name}.\n"));
    }
    p
}

pub fn send(app: &AppHandle, req: ChatRequest) -> Result<String, String> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let (provider, program) = resolve(&req.provider, &settings.chat_provider)?;
    let mut messages = tidy(req.messages);
    if !req.attachments.is_empty() {
        if let Some(last) = messages.last_mut() {
            last.files.extend(req.attachments);
        }
    }
    if messages.last().map(|m| m.role != "user").unwrap_or(true) {
        return Err("ไม่มีข้อความที่จะส่ง".into());
    }
    let dir = chat_dir();
    std::fs::create_dir_all(dir.join("files")).map_err(|e| format!("สร้างโฟลเดอร์แชทไม่ได้: {e}"))?;
    let wanted: Vec<String> = messages.iter().flat_map(|m| m.files.iter().cloned()).collect();
    let staged = files::stage(&wanted, &dir.join("files"))?;
    let id = format!("chat{}", state.chat.counter.fetch_add(1, Ordering::Relaxed) + 1);
    let job = Arc::new(Job { cancelled: AtomicBool::new(false), pid: Mutex::new(None) });
    state.chat.jobs.lock().unwrap().insert(id.clone(), job.clone());

    let name = settings.mascot_name.clone();
    let (app, task_id) = (app.clone(), id.clone());
    std::thread::Builder::new()
        .name(format!("marshmori-{id}"))
        .spawn(move || {
            emit(&app, &task_id, "start", provider.label());
            let piece = |text: &str| emit(&app, &task_id, "delta", text);
            let result = run(&piece, provider, &program, &dir, &name, &messages, &staged, &job);
            if job.cancelled.load(Ordering::Relaxed) {
                emit(&app, &task_id, "cancelled", "");
            } else {
                match result {
                    Ok(()) => emit(&app, &task_id, "done", ""),
                    Err(err) => {
                        log::line(format!("chat ({}): {err}", provider.id()));
                        emit(&app, &task_id, "error", &err);
                    }
                }
            }
            if let Some(state) = app.try_state::<AppState>() {
                state.chat.jobs.lock().unwrap().remove(&task_id);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn cancel(app: &AppHandle, id: &str) {
    let state = app.state::<AppState>();
    let job = state.chat.jobs.lock().unwrap().get(id).cloned();
    if let Some(job) = job {
        job.cancelled.store(true, Ordering::Relaxed);
        if let Some(pid) = *job.pid.lock().unwrap() {
            kill_tree(pid);
        }
    }
}

/// Arguments for a run; `full` = false is the fallback for older versions.
fn args_for(p: Provider, dir: &Path, staged: &HashMap<String, Staged>, full: bool) -> Vec<String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<String>>();
    match p {
        Provider::Claude => {
            if !full {
                return s(&["-p", "--output-format", "stream-json", "--verbose"]);
            }
            let settings = dir.join("claude-settings.json");
            let _ = std::fs::write(&settings, br#"{"disableAllHooks": true}"#);
            let mut a = s(&[
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
                "--no-session-persistence",
                "--tools",
                "Read",
                "--allowedTools",
                "Read",
                "--strict-mcp-config",
                "--max-turns",
                "6",
                "--settings",
            ]);
            a.push(settings.display().to_string());
            a
        }
        Provider::Codex => {
            let mut a = if full {
                s(&["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral"])
            } else {
                s(&["exec", "--json", "--skip-git-repo-check"])
            };
            for f in staged.values().filter(|f| f.kind == files::FileKind::Image) {
                a.push("-i".into());
                a.push(f.rel.clone());
            }
            a.push("-".into());
            a
        }
        Provider::Antigravity => s(&["--input-format", "stream-json", "--output-format", "stream-json"]),
        Provider::Gemini => {
            let mut a = s(&["-p", "Reply to the user's last message in the conversation above."]);
            a.extend(s(&["--output-format", if full { "stream-json" } else { "json" }]));
            a
        }
    }
}

/// What goes in on stdin.
fn stdin_for(p: Provider, name: &str, messages: &[ChatMessage], staged: &HashMap<String, Staged>) -> Vec<u8> {
    match p {
        Provider::Antigravity => {
            let prompt = build_prompt(name, messages, staged, true);
            let mut line = serde_json::to_vec(&json!({"event": "user", "message": {"content": prompt}})).unwrap_or_default();
            line.push(b'\n');
            line
        }
        Provider::Gemini => build_prompt(name, messages, staged, false).into_bytes(),
        _ => build_prompt(name, messages, staged, true).into_bytes(),
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    piece: &dyn Fn(&str),
    p: Provider,
    program: &Path,
    dir: &Path,
    name: &str,
    messages: &[ChatMessage],
    staged: &HashMap<String, Staged>,
    job: &Arc<Job>,
) -> Result<(), String> {
    let input = stdin_for(p, name, messages, staged);
    let mut sent_any = false;
    for full in [true, false] {
        let outcome = run_once(piece, p, program, dir, &args_for(p, dir, staged, full), &input, job, &mut sent_any)?;
        match outcome {
            Outcome::Done => return Ok(()),
            // An older version that doesn't know one of the options: once more, plainly.
            Outcome::BadOption(err) if full && !sent_any && !job.cancelled.load(Ordering::Relaxed) => {
                log::line(format!("chat ({}): retrying without the newer options ({err})", p.id()));
            }
            Outcome::BadOption(err) | Outcome::Failed(err) => return Err(err),
        }
    }
    Err(format!("{} ตอบไม่ได้", p.label()))
}

enum Outcome {
    Done,
    BadOption(String),
    Failed(String),
}

#[allow(clippy::too_many_arguments)]
fn run_once(
    emit_piece: &dyn Fn(&str),
    p: Provider,
    program: &Path,
    dir: &Path,
    args: &[String],
    input: &[u8],
    job: &Arc<Job>,
    sent_any: &mut bool,
) -> Result<Outcome, String> {
    let mut child = command(program)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("เปิด {} ไม่ได้: {e}", p.label()))?;
    *job.pid.lock().unwrap() = Some(child.id());
    if job.cancelled.load(Ordering::Relaxed) {
        kill_tree(child.id());
    }

    // Feed the prompt and close stdin, from its own thread (a big prompt must not
    // block us while the tool is busy writing).
    if let Some(mut stdin) = child.stdin.take() {
        let data = input.to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
            let _ = stdin.flush();
        });
    }
    let err_handle = child.stderr.take().map(drain);

    // A watchdog: too long, or silent for too long, and the run is stopped.
    let last_output = Arc::new(Mutex::new(Instant::now()));
    let finished = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));
    {
        let (last_output, finished, timed_out, pid) = (last_output.clone(), finished.clone(), timed_out.clone(), child.id());
        std::thread::spawn(move || {
            let start = Instant::now();
            while !finished.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(500));
                let silent = last_output.lock().unwrap().elapsed();
                if start.elapsed() > MAX_RUN || silent > MAX_SILENCE {
                    timed_out.store(true, Ordering::Relaxed);
                    kill_tree(pid);
                    break;
                }
            }
        });
    }

    let mut parser = Parser::new(p);
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.split(b'\n') {
            let Ok(line) = line else { break };
            *last_output.lock().unwrap() = Instant::now();
            let line = String::from_utf8_lossy(&line);
            for piece in parser.feed(line.trim()) {
                if !piece.is_empty() {
                    *sent_any = true;
                    emit_piece(&piece);
                }
            }
            if parser.finished && p == Provider::Antigravity {
                // agy may wait for more input lines; the answer is in.
                kill_tree(child.id());
                break;
            }
        }
    }
    let status = child.wait().ok();
    finished.store(true, Ordering::Relaxed);
    let stderr = err_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    for piece in parser.finish() {
        if !piece.is_empty() {
            *sent_any = true;
            emit_piece(&piece);
        }
    }

    if job.cancelled.load(Ordering::Relaxed) {
        return Ok(Outcome::Done);
    }
    if timed_out.load(Ordering::Relaxed) {
        return Ok(Outcome::Failed(format!("{} ใช้เวลานานเกินไป เลยหยุดไว้ก่อน", p.label())));
    }
    if let Some(err) = parser.error.clone() {
        return Ok(Outcome::Failed(friendly_error(p, &err)));
    }
    let ok = status.map(|s| s.success()).unwrap_or(false);
    if parser.got_text && (ok || parser.finished) {
        return Ok(Outcome::Done);
    }
    let lower = stderr.to_lowercase();
    if !parser.got_text
        && (lower.contains("unknown option")
            || lower.contains("unknown argument")
            || lower.contains("unexpected argument")
            || lower.contains("unrecognized")
            || lower.contains("found argument"))
    {
        return Ok(Outcome::BadOption(last_line(&stderr)));
    }
    if ok && !parser.got_text {
        return Ok(Outcome::Failed(format!("{} ไม่ได้ตอบอะไรกลับมา", p.label())));
    }
    let detail = if stderr.trim().is_empty() { parser.raw_tail.clone() } else { stderr };
    Ok(Outcome::Failed(friendly_error(p, &detail)))
}

pub(crate) fn last_line(text: &str) -> String {
    let line = text.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    line.chars().take(220).collect()
}

/// Turns what a tool printed when it failed into one helpful line.
pub(crate) fn friendly_error(p: Provider, raw: &str) -> String {
    let lower = raw.to_lowercase();
    let login = match p {
        Provider::Claude => "claude",
        Provider::Codex => "codex login",
        Provider::Antigravity => "agy",
        Provider::Gemini => "gemini",
    };
    if ["not logged in", "please run /login", "login required", "authentication", "unauthorized", "401", "invalid api key", "credentials", "sign in", "oauth"]
        .iter()
        .any(|k| lower.contains(k))
    {
        return format!("{} ยังไม่ได้ล็อกอิน (หรือหมดอายุ) — เปิด terminal แล้วพิมพ์ {login} เพื่อล็อกอินอีกครั้ง", p.label());
    }
    if ["rate limit", "rate_limit", "usage limit", "quota", "429", "limit reached", "resource_exhausted"].iter().any(|k| lower.contains(k)) {
        return format!("{} ใช้ครบโควตาของแพ็กเกจช่วงนี้แล้ว — ลองใหม่ทีหลัง หรือเปลี่ยนไปใช้ตัวอื่นในตั้งค่า › แชท", p.label());
    }
    if ["overloaded", "529", "503", "server_error", "unavailable"].iter().any(|k| lower.contains(k)) {
        return format!("ฝั่ง {} ยุ่งอยู่ ลองส่งใหม่อีกครั้ง", p.label());
    }
    if ["network", "enotfound", "econnrefused", "etimedout", "getaddrinfo", "connection"].iter().any(|k| lower.contains(k)) {
        return format!("{} ต่ออินเทอร์เน็ตไม่ได้ ลองใหม่อีกครั้ง", p.label());
    }
    let line = last_line(raw);
    if line.is_empty() {
        format!("{} ตอบไม่ได้", p.label())
    } else {
        format!("{} ตอบไม่ได้: {line}", p.label())
    }
}

// ── Reading what each tool prints ───────────────────────────────────────────────

/// Turns a tool's JSON lines into pieces of the reply.
pub struct Parser {
    p: Provider,
    /// Text already shown for the current message (so whole-message events don't repeat it).
    shown: String,
    streamed: bool,
    pub got_text: bool,
    pub finished: bool,
    pub error: Option<String>,
    /// Non-JSON output, for error messages.
    raw_tail: String,
    /// Gemini's --output-format json fallback prints one object over many lines.
    pending_json: String,
    /// Codex: text shown so far for each message item.
    items: HashMap<String, String>,
}

impl Parser {
    pub fn new(p: Provider) -> Self {
        Parser {
            p,
            shown: String::new(),
            streamed: false,
            got_text: false,
            finished: false,
            error: None,
            raw_tail: String::new(),
            pending_json: String::new(),
            items: HashMap::new(),
        }
    }

    fn text(&mut self, t: &str) -> Vec<String> {
        if t.is_empty() {
            return Vec::new();
        }
        self.got_text = true;
        self.shown.push_str(t);
        vec![t.to_string()]
    }

    /// A whole message: only what wasn't streamed already.
    fn whole(&mut self, t: &str) -> Vec<String> {
        if self.streamed || t.is_empty() {
            return Vec::new();
        }
        let piece = if !self.shown.is_empty() && t.starts_with(&self.shown) { t[self.shown.len()..].to_string() } else if self.shown.is_empty() { t.to_string() } else { format!("\n\n{t}") };
        self.text(&piece)
    }

    pub fn feed(&mut self, line: &str) -> Vec<String> {
        if line.is_empty() {
            return Vec::new();
        }
        let v: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                if !self.pending_json.is_empty() || line.starts_with('{') {
                    self.pending_json.push_str(line);
                    self.pending_json.push('\n');
                    if let Ok(v) = serde_json::from_str::<Value>(&self.pending_json) {
                        self.pending_json.clear();
                        return self.event(&v);
                    }
                    return Vec::new();
                }
                self.raw_tail.push_str(line);
                self.raw_tail.push('\n');
                if self.raw_tail.len() > 4000 {
                    let cut = self.raw_tail.len() - 4000;
                    let cut = (cut..self.raw_tail.len()).find(|&i| self.raw_tail.is_char_boundary(i)).unwrap_or(0);
                    self.raw_tail.drain(..cut);
                }
                return Vec::new();
            }
        };
        self.event(&v)
    }

    pub fn finish(&mut self) -> Vec<String> {
        if self.pending_json.is_empty() {
            return Vec::new();
        }
        let pending = std::mem::take(&mut self.pending_json);
        match serde_json::from_str::<Value>(&pending) {
            Ok(v) => self.event(&v),
            Err(_) => Vec::new(),
        }
    }

    fn event(&mut self, v: &Value) -> Vec<String> {
        match self.p {
            Provider::Claude => self.claude(v),
            Provider::Codex => self.codex(v),
            Provider::Antigravity => self.antigravity(v),
            Provider::Gemini => self.gemini(v),
        }
    }

    fn claude(&mut self, v: &Value) -> Vec<String> {
        match v["type"].as_str().unwrap_or("") {
            "stream_event" => {
                let e = &v["event"];
                if v["parent_tool_use_id"].is_string() {
                    return Vec::new();
                }
                match e["type"].as_str() {
                    Some("content_block_delta") if e["delta"]["type"] == "text_delta" => {
                        self.streamed = true;
                        let t = e["delta"]["text"].as_str().unwrap_or("").to_string();
                        self.text(&t)
                    }
                    Some("message_start") if self.got_text => {
                        // A new message after a tool call: start a new paragraph.
                        self.text("\n\n")
                    }
                    _ => Vec::new(),
                }
            }
            "assistant" => {
                if v["parent_tool_use_id"].is_string() {
                    return Vec::new();
                }
                let mut t = String::new();
                if let Some(blocks) = v["message"]["content"].as_array() {
                    for b in blocks {
                        if b["type"] == "text" {
                            t.push_str(b["text"].as_str().unwrap_or(""));
                        }
                    }
                }
                if self.streamed {
                    Vec::new()
                } else {
                    let piece = if self.got_text && !t.is_empty() { format!("\n\n{t}") } else { t };
                    self.text(&piece)
                }
            }
            "result" => {
                self.finished = true;
                let text = v["result"].as_str().unwrap_or("");
                if v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().map(|s| s.starts_with("error")).unwrap_or(false) {
                    if !self.got_text {
                        self.error = Some(if text.is_empty() { v["subtype"].as_str().unwrap_or("error").to_string() } else { text.to_string() });
                    }
                    return Vec::new();
                }
                if !self.got_text {
                    return self.text(text);
                }
                Vec::new()
            }
            "system" if v["subtype"] == "api_retry" => {
                let kind = v["error"].as_str().unwrap_or("");
                if matches!(kind, "authentication_failed" | "billing_error" | "oauth_org_not_allowed" | "account_on_hold") && v["attempt"].as_u64().unwrap_or(0) >= 2 {
                    self.error = Some(kind.replace('_', " "));
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    fn codex(&mut self, v: &Value) -> Vec<String> {
        match v["type"].as_str() {
            Some("item.started") | Some("item.updated") | Some("item.completed") if v["item"]["type"] == "agent_message" => {
                // Each message item carries its text so far: show only what is new.
                let id = v["item"]["id"].as_str().unwrap_or("").to_string();
                let t = v["item"]["text"].as_str().unwrap_or("").to_string();
                let before = self.items.get(&id).cloned().unwrap_or_default();
                if !t.starts_with(&before) {
                    return Vec::new();
                }
                let mut piece = String::new();
                if before.is_empty() && t.len() > before.len() && self.got_text {
                    piece.push_str("\n\n");
                }
                piece.push_str(&t[before.len()..]);
                self.items.insert(id, t);
                self.text(&piece)
            }
            Some("turn.completed") => {
                self.finished = true;
                Vec::new()
            }
            Some("turn.failed") => {
                self.finished = true;
                if !self.got_text {
                    self.error = Some(v["error"]["message"].as_str().unwrap_or("turn failed").to_string());
                }
                Vec::new()
            }
            Some("error") => {
                let msg = v["message"].as_str().unwrap_or("");
                // Reconnect notices are not failures; anything else is kept for the end.
                if !msg.to_lowercase().contains("reconnect") && !self.got_text {
                    self.raw_tail.push_str(msg);
                    self.raw_tail.push('\n');
                }
                Vec::new()
            }
            _ => {
                // Older versions: {"msg": {"type": "agent_message", "message": "…"}}.
                let msg = &v["msg"];
                match msg["type"].as_str() {
                    Some("agent_message_delta") => {
                        self.streamed = true;
                        let t = msg["delta"].as_str().unwrap_or("").to_string();
                        self.text(&t)
                    }
                    Some("agent_message") => {
                        let t = msg["message"].as_str().unwrap_or("").to_string();
                        self.whole(&t)
                    }
                    Some("task_complete") => {
                        self.finished = true;
                        Vec::new()
                    }
                    Some("error") => {
                        if !self.got_text {
                            self.error = Some(msg["message"].as_str().unwrap_or("error").to_string());
                        }
                        Vec::new()
                    }
                    _ => Vec::new(),
                }
            }
        }
    }

    fn antigravity(&mut self, v: &Value) -> Vec<String> {
        match v["event"].as_str() {
            Some("step_update") => {
                let s = &v["step_update"];
                let kind = s["step_type"].as_str().unwrap_or("");
                if kind.is_empty() || kind == "agent_response" {
                    if let Some(t) = s["text_delta"].as_str() {
                        self.streamed = true;
                        let t = t.to_string();
                        return self.text(&t);
                    }
                }
                Vec::new()
            }
            Some("result") => {
                self.finished = true;
                let r = &v["result"];
                let status = r["status"].as_str().unwrap_or("SUCCESS");
                if status != "SUCCESS" && !self.got_text {
                    self.error = Some(r["error"].as_str().unwrap_or(status).to_string());
                    return Vec::new();
                }
                let t = r["response"].as_str().unwrap_or("").to_string();
                self.whole(&t)
            }
            _ => {
                if v["status"].as_str() == Some("ERROR") && !self.got_text {
                    self.finished = true;
                    self.error = Some(v["error"].as_str().unwrap_or("error").to_string());
                } else if let Some(t) = v["response"].as_str() {
                    // --output-format json
                    self.finished = true;
                    let t = t.to_string();
                    return self.whole(&t);
                }
                Vec::new()
            }
        }
    }

    fn gemini(&mut self, v: &Value) -> Vec<String> {
        match v["type"].as_str() {
            Some("message") if v["role"] == "assistant" => {
                let t = v["content"].as_str().unwrap_or("").to_string();
                if v["delta"].as_bool().unwrap_or(false) {
                    self.streamed = true;
                    self.text(&t)
                } else {
                    self.whole(&t)
                }
            }
            Some("result") => {
                self.finished = true;
                let status = v["status"].as_str().unwrap_or("success");
                if status != "success" && !self.got_text {
                    self.error = Some(v["error"]["message"].as_str().or(v["error"].as_str()).unwrap_or(status).to_string());
                }
                Vec::new()
            }
            Some("error") => {
                if !self.got_text {
                    let msg = v["message"].as_str().unwrap_or("").to_string();
                    self.raw_tail.push_str(&msg);
                    self.raw_tail.push('\n');
                }
                Vec::new()
            }
            _ => {
                // --output-format json: {"response": "…", "stats": {…}} or {"error": {…}}.
                if let Some(t) = v["response"].as_str() {
                    self.finished = true;
                    let t = t.to_string();
                    return self.whole(&t);
                }
                if v["error"].is_object() && !self.got_text {
                    self.finished = true;
                    self.error = Some(v["error"]["message"].as_str().unwrap_or("error").to_string());
                }
                Vec::new()
            }
        }
    }
}

/// Removes attachment copies older than a day.
pub fn tidy_old_files() {
    let dir = chat_dir().join("files");
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let day = Duration::from_secs(24 * 3600);
    for e in entries.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|age| age > day).unwrap_or(false);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_stream_is_read_to_the_end_and_its_tail_kept() {
        let mut data = vec![b'a'; 700 * 1024];
        data.extend_from_slice(b"\nError: the real reason");
        let text = drain(std::io::Cursor::new(data)).join().unwrap();
        assert!(text.ends_with("Error: the real reason"));
        assert!(text.len() <= 256 * 1024 + 64);
    }

    fn feed_all(p: Provider, lines: &[&str]) -> (String, Parser) {
        let mut parser = Parser::new(p);
        let mut out = String::new();
        for l in lines {
            for piece in parser.feed(l) {
                out.push_str(&piece);
            }
        }
        for piece in parser.finish() {
            out.push_str(&piece);
        }
        (out, parser)
    }

    #[test]
    fn claude_stream_json_with_partial_messages() {
        let (text, p) = feed_all(
            Provider::Claude,
            &[
                r#"{"type":"system","subtype":"init","session_id":"s"}"#,
                r#"{"type":"stream_event","event":{"type":"message_start"}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"สวัส"}}}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ดี"}}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"สวัสดี"}]},"parent_tool_use_id":null}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"สวัสดี"}"#,
            ],
        );
        assert_eq!(text, "สวัสดี");
        assert!(p.finished && p.got_text && p.error.is_none());
    }

    #[test]
    fn claude_without_partial_messages_and_errors() {
        let (text, _) = feed_all(
            Provider::Claude,
            &[
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"result":"Hello"}"#,
            ],
        );
        assert_eq!(text, "Hello");
        let (text, p) = feed_all(Provider::Claude, &[r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#]);
        assert_eq!(text, "");
        assert!(p.error.as_deref().unwrap().contains("login"));
        assert!(friendly_error(Provider::Claude, p.error.as_deref().unwrap()).contains("ล็อกอิน"));
    }

    #[test]
    fn codex_items_and_old_format() {
        let (text, p) = feed_all(
            Provider::Codex,
            &[
                r#"{"type":"thread.started","thread_id":"t"}"#,
                r#"{"type":"turn.started"}"#,
                r#"{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"thinking"}}"#,
                r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"ได้เลย"}}"#,
                r#"{"type":"turn.completed","usage":{"input_tokens":1}}"#,
            ],
        );
        assert_eq!(text, "ได้เลย");
        assert!(p.finished);
        let (text, _) = feed_all(Provider::Codex, &[r#"{"id":"0","msg":{"type":"agent_message","message":"old style"}}"#]);
        assert_eq!(text, "old style");
        let (_, p) = feed_all(Provider::Codex, &[r#"{"type":"turn.failed","error":{"message":"usage limit reached"}}"#]);
        assert!(friendly_error(Provider::Codex, p.error.as_deref().unwrap()).contains("โควตา"));
    }

    #[test]
    fn antigravity_steps_and_result() {
        let (text, p) = feed_all(
            Provider::Antigravity,
            &[
                r#"{"event":"init","conversation_id":"c","init":{"cwd":"/x"}}"#,
                r#"{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"Hi "}}"#,
                r#"{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"there"}}"#,
                r#"{"event":"result","result":{"status":"SUCCESS","response":"Hi there","num_turns":1}}"#,
            ],
        );
        assert_eq!(text, "Hi there");
        assert!(p.finished);
        let (_, p) = feed_all(Provider::Antigravity, &[r#"{"status":"ERROR","error":"authentication required","exit":1}"#]);
        assert!(p.error.is_some());
    }

    #[test]
    fn gemini_stream_and_json() {
        let (text, p) = feed_all(
            Provider::Gemini,
            &[
                r#"{"type":"init","session_id":"s","model":"m"}"#,
                r#"{"type":"message","role":"user","content":"q"}"#,
                r#"{"type":"message","role":"assistant","content":"A","delta":true}"#,
                r#"{"type":"message","role":"assistant","content":"B","delta":true}"#,
                r#"{"type":"result","status":"success"}"#,
            ],
        );
        assert_eq!(text, "AB");
        assert!(p.finished);
        let (text, _) = feed_all(Provider::Gemini, &["{", r#"  "response": "multi-line json","#, r#"  "stats": {}"#, "}"]);
        assert_eq!(text, "multi-line json");
    }

    #[test]
    fn prompts_keep_the_newest_turns_and_name_the_files() {
        let mut staged = HashMap::new();
        staged.insert("C:/x/shot.png".to_string(), Staged { rel: "files/ab12-shot.png".into(), kind: files::FileKind::Image });
        let msgs = vec![
            ChatMessage { role: "user".into(), text: "ดูรูปนี้หน่อย".into(), files: vec!["C:/x/shot.png".into()] },
            ChatMessage { role: "assistant".into(), text: "เห็นแล้ว".into(), files: vec![] },
            ChatMessage { role: "user".into(), text: "สรุปให้หน่อย".into(), files: vec![] },
        ];
        let p = build_prompt("Mamori", &msgs, &staged, true);
        assert!(p.contains("[User]\nดูรูปนี้หน่อย\n(attached: files/ab12-shot.png)"));
        assert!(p.contains("[Mamori]\nเห็นแล้ว"));
        assert!(p.trim_end().ends_with("Reply to the user's last message as Mamori."));
        let long = vec![ChatMessage { role: "user".into(), text: "x".repeat(40_000), files: vec![] }];
        assert!(build_prompt("Mamori", &long, &HashMap::new(), true).len() > 40_000, "the last message is always sent whole");
    }

    #[test]
    fn conversations_are_tidied() {
        let m = |r: &str, t: &str| ChatMessage { role: r.into(), text: t.into(), files: vec![] };
        let out = tidy(vec![m("assistant", "hi"), m("user", "a"), m("user", "b"), m("system", "x"), m("assistant", "c")]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].text, "a\n\nb");
    }

    /// A stand-in CLI: a shell script that checks its stdin and prints canned JSON lines.
    #[cfg(unix)]
    fn fake_cli(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    fn run_fake(p: Provider, program: &Path, dir: &Path) -> (Result<(), String>, String) {
        let out = Mutex::new(String::new());
        let piece = |t: &str| out.lock().unwrap().push_str(t);
        let job = Arc::new(Job { cancelled: AtomicBool::new(false), pid: Mutex::new(None) });
        let msgs = vec![ChatMessage { role: "user".into(), text: "สวัสดี".into(), files: vec![] }];
        let r = run(&piece, p, program, dir, "Mamori", &msgs, &HashMap::new(), &job);
        let text = out.lock().unwrap().clone();
        (r, text)
    }

    #[cfg(unix)]
    #[test]
    fn a_whole_run_through_a_stand_in_cli() {
        let dir = std::env::temp_dir().join(format!("marshmori-chat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The prompt arrives on stdin (and the env tells hooks to stand aside).
        let claude = fake_cli(
            &dir,
            "claude",
            r#"input=$(cat); case "$input" in *"[User]"*"สวัสดี"*) ;; *) echo "no prompt" >&2; exit 3;; esac
[ "$MARSHMORI_INTERNAL" = "1" ] || exit 4
echo '{"type":"system","subtype":"init"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"สวัส"}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ดีครับ"}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"สวัสดีครับ"}'"#,
        );
        let (r, text) = run_fake(Provider::Claude, &claude, &dir);
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(text, "สวัสดีครับ");

        // An older version that rejects a newer option gets a second, plainer run.
        let old = fake_cli(
            &dir,
            "claude-old",
            r#"for a in "$@"; do [ "$a" = "--include-partial-messages" ] && { echo "error: unknown option '--include-partial-messages'" >&2; exit 1; }; done
cat > /dev/null
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'"#,
        );
        let (r, text) = run_fake(Provider::Claude, &old, &dir);
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(text, "ok");

        // Not signed in: a clear message, not a stack trace.
        let out = fake_cli(&dir, "claude-out", r#"cat > /dev/null; echo '{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'; exit 1"#);
        let (r, _) = run_fake(Provider::Claude, &out, &dir);
        assert!(r.unwrap_err().contains("ล็อกอิน"));

        // Codex reads "-" (stdin) and prints items.
        let codex = fake_cli(
            &dir,
            "codex",
            r#"last=""; for a in "$@"; do last="$a"; done; [ "$last" = "-" ] || exit 5
cat > /dev/null
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"ได้เลย"}}'
echo '{"type":"turn.completed"}'"#,
        );
        let (r, text) = run_fake(Provider::Codex, &codex, &dir);
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(text, "ได้เลย");

        // Antigravity gets one stream-json line and may keep waiting: we stop it once the result is in.
        let agy = fake_cli(
            &dir,
            "agy",
            r#"read line; case "$line" in *'"event":"user"'*) ;; *) exit 6;; esac
echo '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"hi"}}'
echo '{"event":"result","result":{"status":"SUCCESS","response":"hi"}}'
sleep 30"#,
        );
        let started = Instant::now();
        let (r, text) = run_fake(Provider::Antigravity, &agy, &dir);
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(text, "hi");
        assert!(started.elapsed() < Duration::from_secs(10));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn options_never_carry_the_prompt() {
        let dir = std::env::temp_dir();
        for p in Provider::ALL {
            for full in [true, false] {
                let args = args_for(p, &dir, &HashMap::new(), full);
                assert!(args.iter().all(|a| !a.contains("Conversation")), "{p:?}");
            }
        }
        assert_eq!(args_for(Provider::Codex, &dir, &HashMap::new(), true).last().unwrap(), "-");
    }
}
