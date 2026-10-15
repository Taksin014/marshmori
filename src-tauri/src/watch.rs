// Seeing agents at work without hooks: the transcripts they write as they go.
//
// Hooks are how Mamori hears about a session (and the only way it can answer an
// approval), but they only fire where they are connected and supported: Antigravity's
// IDE doesn't run hooks yet, Codex asks you to trust them first, and a session that was
// started before anything was connected has none. Every agent writes down what it is
// doing as it goes, though:
//
//   Claude Code   ~/.claude/projects/<folder>/<session>.jsonl          a JSON object a line
//   Codex         ~/.codex/sessions/<y>/<m>/<d>/rollout-…-<id>.jsonl   a JSON object a line
//   Antigravity   ~/.gemini/antigravity*/conversations/<id>.*          (only that it changes)
//
// A thread looks at them every second and a half and turns what is new into the same
// events the hooks send, for the sessions no hook has reported (those stay with the
// hooks). It only ever reports what it reads: it never answers for an agent.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agents::{self, Agent, Event, Kind};
use crate::{log, paths, pipeline, AppState};

const POLL: Duration = Duration::from_millis(1500);
/// A transcript that hasn't changed for this long isn't a session at work.
const LIVE_FOR: Duration = Duration::from_secs(10 * 60);
/// The first look at a transcript reads only this much of its end.
const TAIL: u64 = 96 * 1024;
/// At most this much new text a look; more than that skips ahead to the end.
const MAX_READ: u64 = 512 * 1024;
/// An answer with nothing after it for this long is the end of the turn (when the agent
/// didn't say so itself). Long enough to sit out a pause for thought between a remark
/// and the next step: a "done" that isn't would bring Mamori out for nothing.
const SETTLE: Duration = Duration::from_secs(12);
/// Antigravity: when its conversation stops changing this long, it is waiting for you.
const QUIET: Duration = Duration::from_secs(25);
/// The event name the pipeline sees for everything from here (never a hook's name, so
/// nothing from here can open an approval card).
pub const NAME: &str = "Transcript";

/// What one transcript line says happened.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Session { id: Option<String>, cwd: Option<String> },
    Prompt(String),
    ToolStart { id: String, name: String, input: Value },
    ToolEnd { id: String, failed: bool },
    /// The agent said something (the answer, if nothing comes after it).
    Said(String),
    /// The turn is over (Codex says so; Claude Code's message ends with end_turn).
    TurnDone(Option<String>),
    Interrupted,
}

// ── Reading lines ───────────────────────────────────────────────────────────────

fn text(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(str::to_string)
}

/// A prompt the user typed — not Claude Code's own notes in the transcript (slash
/// commands, their output, reminders it adds), which come wrapped in tags.
fn prompt_step(out: &mut Vec<Step>, raw: &str) {
    let t = raw.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("Caveat:") {
        return;
    }
    if t.starts_with("[Request interrupted") {
        out.push(Step::Interrupted);
    } else {
        out.push(Step::Prompt(t.to_string()));
    }
}

/// One line of a Claude Code transcript.
pub fn claude_steps(v: &Value) -> Vec<Step> {
    let mut out = Vec::new();
    // A helper agent's side conversation, or a note Claude Code keeps for itself.
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) || v.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return out;
    }
    let id = text(v.get("sessionId"));
    let cwd = text(v.get("cwd"));
    if id.is_some() || cwd.is_some() {
        out.push(Step::Session { id, cwd });
    }
    let msg = v.get("message");
    let content = msg.and_then(|m| m.get("content"));
    match v.get("type").and_then(Value::as_str) {
        Some("user") => match content {
            Some(Value::String(s)) => prompt_step(&mut out, s),
            Some(Value::Array(blocks)) => {
                for b in blocks {
                    match b.get("type").and_then(Value::as_str) {
                        Some("tool_result") => out.push(Step::ToolEnd {
                            id: text(b.get("tool_use_id")).unwrap_or_default(),
                            failed: b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                        }),
                        Some("text") => {
                            if let Some(s) = b.get("text").and_then(Value::as_str) {
                                prompt_step(&mut out, s);
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        },
        Some("assistant") => {
            if let Some(Value::Array(blocks)) = content {
                for b in blocks {
                    match b.get("type").and_then(Value::as_str) {
                        Some("tool_use") => out.push(Step::ToolStart {
                            id: text(b.get("id")).unwrap_or_default(),
                            name: text(b.get("name")).unwrap_or_else(|| "tool".into()),
                            input: b.get("input").cloned().unwrap_or(Value::Null),
                        }),
                        Some("text") => {
                            if let Some(s) = text(b.get("text")) {
                                out.push(Step::Said(s));
                            }
                        }
                        _ => {}
                    }
                }
            }
            if msg.and_then(|m| m.get("stop_reason")).and_then(Value::as_str) == Some("end_turn") {
                out.push(Step::TurnDone(None));
            }
        }
        _ => {}
    }
    out
}

/// One line of a Codex rollout.
pub fn codex_steps(v: &Value) -> Vec<Step> {
    let mut out = Vec::new();
    let Some(p) = v.get("payload") else { return out };
    match v.get("type").and_then(Value::as_str) {
        Some("session_meta") => out.push(Step::Session { id: text(p.get("id")), cwd: text(p.get("cwd")) }),
        Some("turn_context") => out.push(Step::Session { id: None, cwd: text(p.get("cwd")) }),
        Some("event_msg") => match p.get("type").and_then(Value::as_str) {
            Some("user_message") => {
                if let Some(m) = p.get("message").and_then(Value::as_str) {
                    prompt_step(&mut out, m);
                }
            }
            Some("agent_message") => {
                if let Some(m) = text(p.get("message")) {
                    out.push(Step::Said(m));
                }
            }
            Some("task_complete") => out.push(Step::TurnDone(text(p.get("last_agent_message")))),
            Some("turn_aborted") => out.push(Step::Interrupted),
            _ => {}
        },
        Some("response_item") => {
            let call = || text(p.get("call_id")).or_else(|| text(p.get("id"))).unwrap_or_default();
            match p.get("type").and_then(Value::as_str) {
                Some("function_call") => {
                    let args = p.get("arguments").and_then(Value::as_str).and_then(|a| serde_json::from_str(a).ok()).unwrap_or(Value::Null);
                    out.push(Step::ToolStart { id: call(), name: text(p.get("name")).unwrap_or_else(|| "tool".into()), input: args });
                }
                Some("custom_tool_call") => out.push(Step::ToolStart {
                    id: call(),
                    name: text(p.get("name")).unwrap_or_else(|| "tool".into()),
                    input: json!({ "input": p.get("input").cloned().unwrap_or(Value::Null) }),
                }),
                Some("local_shell_call") => out.push(Step::ToolStart {
                    id: call(),
                    name: "shell".into(),
                    input: json!({ "command": p.pointer("/action/command").cloned().unwrap_or(Value::Null) }),
                }),
                Some("function_call_output") | Some("custom_tool_call_output") => out.push(Step::ToolEnd { id: call(), failed: false }),
                _ => {}
            }
        }
        _ => {}
    }
    out
}

// ── One transcript followed ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Quiet,
    Thinking,
    Working,
    /// It said something and nothing has come after it yet.
    Answered,
    Done,
}

pub struct Transcript {
    agent: Agent,
    pub session_id: String,
    pub cwd: String,
    offset: u64,
    partial: Vec<u8>,
    /// Tool calls started and not finished: id → (name, input).
    open: HashMap<String, (String, Value)>,
    answer: Option<String>,
    phase: Phase,
    grew_at: Instant,
}

impl Transcript {
    pub fn new(agent: Agent, session_id: String) -> Self {
        Self {
            agent,
            session_id,
            cwd: String::new(),
            offset: 0,
            partial: Vec::new(),
            open: HashMap::new(),
            answer: None,
            phase: Phase::Quiet,
            grew_at: Instant::now(),
        }
    }

    fn event(&self, kind: Kind, tool: Option<(&str, &Value)>, text: Option<String>, tool_use_id: Option<String>) -> Event {
        Event {
            agent: self.agent,
            kind,
            name: NAME.to_string(),
            session_id: self.session_id.clone(),
            cwd: self.cwd.clone(),
            tool: tool.map(|(n, i)| agents::describe(n, i)),
            text,
            notification_type: None,
            task: None,
            tool_use_id,
            permission_mode: None,
            entry: None,
            project_dir: None,
            input: tool.map(|(_, i)| i.clone()).unwrap_or(Value::Null),
        }
    }

    /// Takes in what new lines said; returns the events they make.
    pub fn take(&mut self, steps: Vec<Step>) -> Vec<Event> {
        let mut out = Vec::new();
        for step in steps {
            match step {
                Step::Session { id, cwd } => {
                    if let Some(id) = id.filter(|_| self.session_id.is_empty()) {
                        self.session_id = id;
                    }
                    if let Some(cwd) = cwd {
                        self.cwd = cwd;
                    }
                }
                Step::Prompt(p) => {
                    self.open.clear();
                    self.answer = None;
                    self.phase = Phase::Thinking;
                    out.push(self.event(Kind::Prompt, None, Some(p), None));
                }
                Step::ToolStart { id, name, input } => {
                    self.answer = None;
                    self.phase = Phase::Working;
                    out.push(self.event(Kind::ToolStart, Some((&name, &input)), None, Some(id.clone())));
                    self.open.insert(id, (name, input));
                }
                Step::ToolEnd { id, failed } => {
                    if let Some((name, input)) = self.open.remove(&id) {
                        let kind = if failed { Kind::ToolFailed } else { Kind::ToolEnd };
                        out.push(self.event(kind, Some((&name, &input)), None, Some(id)));
                    }
                    self.phase = Phase::Working;
                }
                Step::Said(t) => {
                    self.answer = Some(t);
                    if self.open.is_empty() {
                        self.phase = Phase::Answered;
                    }
                }
                Step::TurnDone(t) => {
                    let said = t.or_else(|| self.answer.take());
                    self.open.clear();
                    self.answer = None;
                    if self.phase != Phase::Done {
                        self.phase = Phase::Done;
                        out.push(self.event(Kind::Stop, None, said, None));
                    }
                }
                Step::Interrupted => {
                    self.open.clear();
                    self.answer = None;
                    self.phase = Phase::Quiet;
                    out.push(self.event(Kind::Interrupt, None, None, None));
                }
            }
        }
        out
    }

    /// Time passing: an answer nothing followed is the end of the turn.
    pub fn settle(&mut self, now: Instant) -> Option<Event> {
        if self.phase == Phase::Answered && self.open.is_empty() && now.duration_since(self.grew_at) >= SETTLE {
            self.phase = Phase::Done;
            let said = self.answer.take();
            return Some(self.event(Kind::Stop, None, said, None));
        }
        None
    }

    /// Where it stands after a first read, as one event (nothing if it isn't at work).
    pub fn current(&self) -> Option<Event> {
        match self.phase {
            Phase::Working => Some(match self.open.iter().next() {
                Some((id, (name, input))) => self.event(Kind::ToolStart, Some((name, input)), None, Some(id.clone())),
                None => self.event(Kind::ToolEnd, None, None, None),
            }),
            Phase::Thinking => Some(self.event(Kind::Prompt, None, None, None)),
            Phase::Answered => Some(self.event(Kind::ToolEnd, None, None, None)),
            Phase::Quiet | Phase::Done => None,
        }
    }

    /// Reads what was added to `path` since last time and turns it into steps.
    fn read(&mut self, path: &Path, len: u64, parse: fn(&Value) -> Vec<Step>) -> Vec<Step> {
        if len < self.offset {
            // Rewritten from the start (compacted): read it again.
            self.offset = 0;
            self.partial.clear();
        }
        if len == self.offset {
            return Vec::new();
        }
        let mut start = self.offset;
        let first = self.offset == 0;
        if first && len > TAIL {
            start = len - TAIL;
        } else if len - start > MAX_READ {
            start = len - MAX_READ;
            self.partial.clear();
        }
        let skip_first_line = start > self.offset || (first && start > 0);
        let Ok(mut f) = File::open(path) else { return Vec::new() };
        if f.seek(SeekFrom::Start(start)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::with_capacity((len - start) as usize);
        if f.take(len - start).read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        self.offset = start + buf.len() as u64;
        self.grew_at = Instant::now();
        let mut data = std::mem::take(&mut self.partial);
        if skip_first_line {
            // Started mid-line: drop the piece before the first full line.
            match buf.iter().position(|&b| b == b'\n') {
                Some(i) => data.extend_from_slice(&buf[i + 1..]),
                None => return Vec::new(),
            }
        } else {
            data.extend_from_slice(&buf);
        }
        let mut steps = Vec::new();
        let complete = data.iter().rposition(|&b| b == b'\n').map(|i| i + 1).unwrap_or(0);
        for line in data[..complete].split(|&b| b == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                steps.extend(parse(&v));
            }
        }
        // A line still being written waits for the rest of it.
        self.partial = data[complete..].to_vec();
        if self.partial.len() > 4 * 1024 * 1024 {
            self.partial.clear();
        }
        steps
    }
}

// ── Where the transcripts are ───────────────────────────────────────────────────

fn claude_root() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| paths::home_dir().join(".claude")).join("projects")
}

fn codex_root() -> PathBuf {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| paths::home_dir().join(".codex")).join("sessions")
}

/// Files under `dir` (one level) changed within LIVE_FOR, with their length.
fn recent_files(dir: &Path, ext: &str, now: SystemTime, out: &mut Vec<(PathBuf, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(ext) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let fresh = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).map(|age| age <= LIVE_FOR).unwrap_or(false);
        if fresh {
            out.push((path, meta.len()));
        }
    }
}

fn claude_files(now: SystemTime) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let Ok(projects) = std::fs::read_dir(claude_root()) else { return out };
    for project in projects.flatten() {
        if project.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            recent_files(&project.path(), "jsonl", now, &mut out);
        }
    }
    out
}

/// The rollouts of the last day or so. Codex names its folders by the local date; the
/// days either side of today's UTC date cover that whatever the time zone (and a
/// session that runs past midnight keeps its folder).
fn codex_files(now: SystemTime) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let root = codex_root();
    let today = now.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0).div_euclid(86_400);
    for day in [today - 1, today, today + 1] {
        let (y, m, d) = civil_from_days(day);
        recent_files(&root.join(format!("{y:04}")).join(format!("{m:02}")).join(format!("{d:02}")), "jsonl", now, &mut out);
    }
    out
}

/// Days since 1970-01-01 → (year, month, day) (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Antigravity's conversations (the app, the IDE and the CLI each keep their own
/// folder under ~/.gemini): id → when it last changed.
fn antigravity_activity(now: SystemTime) -> HashMap<String, SystemTime> {
    let mut out: HashMap<String, SystemTime> = HashMap::new();
    let Ok(dirs) = std::fs::read_dir(paths::home_dir().join(".gemini")) else { return out };
    let mut note = |id: String, at: SystemTime| {
        if now.duration_since(at).map(|age| age <= LIVE_FOR).unwrap_or(false) {
            let e = out.entry(id).or_insert(at);
            if at > *e {
                *e = at;
            }
        }
    };
    for dir in dirs.flatten() {
        let name = dir.file_name().to_string_lossy().to_ascii_lowercase();
        if !name.starts_with("antigravity") || !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if let Ok(files) = std::fs::read_dir(dir.path().join("conversations")) {
            for f in files.flatten() {
                let Ok(meta) = f.metadata() else { continue };
                if let (true, Ok(at)) = (meta.is_file(), meta.modified()) {
                    if let Some(id) = f.path().file_stem().and_then(|s| s.to_str()).filter(|s| looks_like_id(s)) {
                        note(id.to_string(), at);
                    }
                }
            }
        }
    }
    out
}

fn looks_like_id(s: &str) -> bool {
    s.len() >= 8 && s.len() <= 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Claude Code names a transcript after its session; Codex puts the id at the end of the name.
fn id_from_path(agent: Agent, path: &Path) -> String {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
    match agent {
        Agent::Codex => {
            // rollout-2026-10-14T09-30-00-<uuid>: the last five dash-separated groups.
            let parts: Vec<&str> = stem.split('-').collect();
            if parts.len() >= 5 {
                parts[parts.len() - 5..].join("-")
            } else {
                stem.to_string()
            }
        }
        _ => stem.to_string(),
    }
}

// ── The watcher ─────────────────────────────────────────────────────────────────

/// Sessions Mamori keeps out of this: its own chat and the tasks it runs (they show
/// themselves), and anything a hook already reports.
fn ours(app: &AppHandle, key: &str, cwd: &str) -> bool {
    let state = app.state::<AppState>();
    if state.hooked.lock().unwrap().contains_key(key) {
        return true;
    }
    if !cwd.is_empty() {
        let chat = crate::chat::chat_dir();
        if Path::new(cwd).starts_with(&chat) || cwd.replace('\\', "/").to_ascii_lowercase().starts_with(&chat.display().to_string().replace('\\', "/").to_ascii_lowercase()) {
            return true;
        }
    }
    crate::tasks::has_session(app, key)
}

fn deliver(app: &AppHandle, ev: Event, quietly: bool) {
    if ours(app, &ev.session_key(), &ev.cwd) {
        return;
    }
    let known = app.state::<AppState>().sessions.lock().unwrap().get(&ev.session_key()).is_some();
    if !known {
        log::line(format!("watch: {} session {} in {} (from its transcript)", ev.agent.id(), ev.session_id, crate::sessions::project_name(&ev.cwd)));
    }
    if quietly {
        // Where a session already stood when Mamori first saw it: shown, not announced.
        let state = app.state::<AppState>();
        state.sessions.lock().unwrap().apply(&ev);
        pipeline::emit_sessions(app);
    } else {
        pipeline::process(app, ev);
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("marshmori-watch".into())
        .spawn(move || {
            let mut followed: HashMap<PathBuf, Transcript> = HashMap::new();
            let mut antigravity: HashMap<String, (SystemTime, bool)> = HashMap::new();
            let mut first_round = true;
            let mut round: u64 = 0;
            loop {
                let now_sys = SystemTime::now();
                let now = Instant::now();
                // Looking through every folder is the expensive part: every fourth round.
                // In between, only the transcripts already being followed are looked at.
                let full = round % 4 == 0;
                round = round.wrapping_add(1);
                let known = |agent: Agent| -> Vec<(PathBuf, u64)> {
                    followed
                        .iter()
                        .filter(|(_, t)| t.agent == agent)
                        .filter_map(|(p, _)| std::fs::metadata(p).ok().map(|m| (p.clone(), m.len())))
                        .collect()
                };
                let claude = if full { claude_files(now_sys) } else { known(Agent::Claude) };
                let codex = if full { codex_files(now_sys) } else { known(Agent::Codex) };
                let mut seen: Vec<PathBuf> = Vec::new();
                for (agent, files, parse) in [
                    (Agent::Claude, claude, claude_steps as fn(&Value) -> Vec<Step>),
                    (Agent::Codex, codex, codex_steps as fn(&Value) -> Vec<Step>),
                ] {
                    for (path, len) in files {
                        seen.push(path.clone());
                        let fresh = !followed.contains_key(&path);
                        let t = followed.entry(path.clone()).or_insert_with(|| Transcript::new(agent, id_from_path(agent, &path)));
                        let steps = t.read(&path, len, parse);
                        if fresh {
                            t.take(steps);
                            if let Some(ev) = t.current() {
                                deliver(&app, ev, true);
                            }
                        } else {
                            for ev in t.take(steps) {
                                deliver(&app, ev, false);
                            }
                        }
                        if let Some(ev) = t.settle(now) {
                            deliver(&app, ev, false);
                        }
                    }
                }
                if full {
                    followed.retain(|p, _| seen.contains(p));
                }

                // Antigravity: busy while its conversation keeps changing, then waiting.
                let activity = if full || antigravity.values().any(|(_, busy)| *busy) { antigravity_activity(now_sys) } else { HashMap::new() };
                for (id, at) in activity {
                    let changed = antigravity.get(&id).map(|(was, _)| *was != at).unwrap_or(true);
                    let recent = now_sys.duration_since(at).map(|age| age < QUIET).unwrap_or(false);
                    let busy = antigravity.get(&id).map(|(_, b)| *b).unwrap_or(false);
                    let ev_for = |kind: Kind, note: Option<&str>| Event {
                        agent: Agent::Antigravity,
                        kind,
                        name: NAME.to_string(),
                        session_id: id.clone(),
                        cwd: "Antigravity IDE".into(),
                        tool: None,
                        text: None,
                        notification_type: note.map(str::to_string),
                        task: None,
                        tool_use_id: None,
                        permission_mode: None,
                        entry: None,
                        project_dir: None,
                        input: Value::Null,
                    };
                    if changed && recent && !busy {
                        deliver(&app, ev_for(Kind::ToolStart, None), first_round);
                        antigravity.insert(id, (at, true));
                    } else if busy && !recent {
                        deliver(&app, ev_for(Kind::Notification, Some("agent_needs_input")), false);
                        antigravity.insert(id, (at, false));
                    } else {
                        antigravity.insert(id, (at, busy));
                    }
                }
                first_round = false;
                std::thread::sleep(POLL);
            }
        })
        .map(|_| ())
        .unwrap_or_else(|err| log::line(format!("watch thread failed: {err}")));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(text: &str, parse: fn(&Value) -> Vec<Step>) -> Vec<Step> {
        text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).flat_map(|v| parse(&v)).collect()
    }

    #[test]
    fn a_claude_turn_reads_as_prompt_tool_and_done() {
        let t = r#"{"type":"user","sessionId":"s1","cwd":"C:\\w\\shop","message":{"role":"user","content":"fix the checkout"}}
{"type":"assistant","sessionId":"s1","cwd":"C:\\w\\shop","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}],"stop_reason":"tool_use"}}
{"type":"user","sessionId":"s1","cwd":"C:\\w\\shop","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}
{"type":"assistant","sessionId":"s1","cwd":"C:\\w\\shop","message":{"role":"assistant","content":[{"type":"text","text":"Fixed it."}],"stop_reason":"end_turn"}}"#;
        let mut tr = Transcript::new(Agent::Claude, "s1".into());
        let evs = tr.take(lines(t, claude_steps));
        let kinds: Vec<Kind> = evs.iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec![Kind::Prompt, Kind::ToolStart, Kind::ToolEnd, Kind::Stop]);
        assert_eq!(evs[1].tool.as_ref().unwrap().kind, agents::ToolKind::Command);
        assert_eq!(evs[3].text.as_deref(), Some("Fixed it."));
        assert_eq!(evs[0].cwd, "C:\\w\\shop");
        assert!(evs.iter().all(|e| e.name == NAME && e.session_key() == "claude:s1"));
    }

    #[test]
    fn claude_notes_and_side_conversations_are_not_prompts() {
        let t = r#"{"type":"user","isMeta":true,"message":{"content":"Caveat: the messages below…"}}
{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}
{"type":"user","message":{"content":[{"type":"text","text":"<ide_opened_file>a.ts</ide_opened_file>"},{"type":"text","text":"why is this slow?"}]}}
{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"tool_use","id":"x","name":"Read","input":{}}]}}
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;
        let steps = lines(t, claude_steps);
        assert_eq!(steps, vec![Step::Prompt("why is this slow?".into()), Step::Interrupted]);
    }

    #[test]
    fn an_answer_with_nothing_after_it_ends_the_turn() {
        let mut tr = Transcript::new(Agent::Claude, "s".into());
        tr.take(vec![Step::Prompt("hi".into()), Step::Said("Hello!".into())]);
        assert!(tr.settle(Instant::now()).is_none(), "not yet");
        let later = Instant::now() + SETTLE + Duration::from_millis(10);
        let ev = tr.settle(later).expect("done after a quiet moment");
        assert_eq!(ev.kind, Kind::Stop);
        assert_eq!(ev.text.as_deref(), Some("Hello!"));
        assert!(tr.settle(later).is_none(), "only once");
    }

    #[test]
    fn a_codex_rollout_reads_like_its_hooks() {
        let t = r#"{"timestamp":"t","type":"session_meta","payload":{"id":"0199a-b","cwd":"/home/me/api"}}
{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"<environment_context>x</environment_context>"}}
{"timestamp":"t","type":"event_msg","payload":{"type":"user_message","message":"add tests"}}
{"timestamp":"t","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"cargo\",\"test\"]}","call_id":"c1"}}
{"timestamp":"t","type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}
{"timestamp":"t","type":"event_msg","payload":{"type":"agent_message","message":"Added 3 tests."}}
{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Added 3 tests."}}"#;
        let mut tr = Transcript::new(Agent::Codex, String::new());
        let evs = tr.take(lines(t, codex_steps));
        let kinds: Vec<Kind> = evs.iter().map(|e| e.kind).collect();
        assert_eq!(kinds, vec![Kind::Prompt, Kind::ToolStart, Kind::ToolEnd, Kind::Stop]);
        assert_eq!(tr.session_id, "0199a-b");
        assert_eq!(evs[0].text.as_deref(), Some("add tests"));
        assert_eq!(evs[1].tool.as_ref().unwrap().target.as_deref(), Some("cargo test"));
    }

    #[test]
    fn a_first_read_shows_where_it_stands() {
        let mut tr = Transcript::new(Agent::Claude, "s".into());
        tr.take(vec![Step::Prompt("go".into()), Step::ToolStart { id: "t".into(), name: "Edit".into(), input: json!({"file_path": "a.rs"}) }]);
        assert_eq!(tr.current().map(|e| e.kind), Some(Kind::ToolStart));
        tr.take(vec![Step::ToolEnd { id: "t".into(), failed: false }, Step::TurnDone(Some("done".into()))]);
        assert!(tr.current().is_none(), "a finished turn isn't news");
    }

    #[test]
    fn reads_only_whole_lines_and_follows_the_file() {
        let dir = std::env::temp_dir().join(format!("marshmori-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s9.jsonl");
        std::fs::write(&path, "{\"type\":\"user\",\"message\":{\"content\":\"one\"}}\n{\"type\":\"user\",\"mess").unwrap();
        let mut tr = Transcript::new(Agent::Claude, "s9".into());
        let len = std::fs::metadata(&path).unwrap().len();
        assert_eq!(tr.read(&path, len, claude_steps), vec![Step::Prompt("one".into())]);
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(&mut f, b"age\":{\"content\":\"two\"}}\n").unwrap();
        let len = std::fs::metadata(&path).unwrap().len();
        assert_eq!(tr.read(&path, len, claude_steps), vec![Step::Prompt("two".into())]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_ids_come_from_the_file_name() {
        let p = Path::new("rollout-2026-10-14T09-30-00-0199a1b2-c3d4-e5f6-a7b8-c9d0e1f2a3b4.jsonl");
        assert_eq!(id_from_path(Agent::Codex, p), "0199a1b2-c3d4-e5f6-a7b8-c9d0e1f2a3b4");
        assert_eq!(id_from_path(Agent::Claude, Path::new("abc-123.jsonl")), "abc-123");
    }

    #[test]
    fn dates_from_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_740), (2026, 10, 14));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }
}
