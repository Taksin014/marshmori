//! marshmori-hook — the relay that Claude Code, Codex and Antigravity run on hook events.
//!
//! It reads the hook JSON on stdin and hands it to Marshmori over HTTP on 127.0.0.1.
//! The port and a per-launch token come from `%APPDATA%\Marshmori\endpoint.json`,
//! which Marshmori rewrites every time it starts.
//!
//! The one rule: never get in the agent's way.
//! * Marshmori is not running → exit 0 at once with no output (Antigravity gets `{}`),
//!   and the agent carries on as if nothing was installed.
//! * Started by Marshmori's own chat (MARSHMORI_INTERNAL is set) → the same, so the
//!   side chat never reports on itself.
//! * Every step runs under a deadline, so a stuck app cannot wedge a session.
//! * Only permission prompts wait for an answer. No answer means no output, and the
//!   agent asks in its own UI exactly as it would without Marshmori. In an IDE's panel
//!   (CLAUDE_CODE_ENTRYPOINT) and in Mamori's own tasks, Claude Code never sends
//!   PermissionRequest, so there its PreToolUse waits too: Marshmori answers at once
//!   unless that call is one Claude Code would have asked about. A question to the user
//!   (AskUserQuestion) waits at PreToolUse everywhere: that's the only place its answer
//!   can go in.
//! * Started by Mamori as a task from the island (MARSHMORI_TASK is set) → the event
//!   goes in as usual, tagged with that task's id so the island knows whose it is.
//!
//! Usage: `marshmori-hook --agent <claude|codex|antigravity> --event <EventName>`

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use serde_json::Value;

/// Budget for reaching Marshmori. Beyond this the agent wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
/// Whole budget for an event nobody waits on.
const FIRE_AND_FORGET: Duration = Duration::from_secs(3);
/// How long a permission card may stay on screen when endpoint.json doesn't say.
const DEFAULT_WAIT_SECS: u64 = 110;
const MAX_WAIT_SECS: u64 = 590;
const MAX_STDIN: u64 = 16 * 1024 * 1024;
/// Longest string forwarded for any one field. The island shows far less.
const MAX_FIELD_LEN: usize = 4_000;
/// Fields that can be huge and that Marshmori never shows.
const DROPPED_FIELDS: &[&str] = &["tool_response", "transcript_path", "transcriptPath", "artifactDirectoryPath"];

#[derive(Debug, PartialEq)]
struct Args {
    agent: String,
    event: String,
}

fn parse_args(args: impl Iterator<Item = String>) -> Args {
    let mut agent = String::new();
    let mut event = String::new();
    let mut it = args;
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--agent" => agent = it.next().unwrap_or_default(),
            "--event" => event = it.next().unwrap_or_default(),
            other if !other.starts_with('-') && event.is_empty() => event = other.to_string(),
            _ => {}
        }
    }
    Args { agent: clean(&agent), event: clean(&event) }
}

/// Only `[A-Za-z0-9_-]`, 40 characters at most: these go into a URL.
fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect()
}

/// Where Marshmori keeps endpoint.json. Must match `paths::data_dir()` in the app.
fn data_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("MARSHMORI_DATA_DIR") {
        return Some(PathBuf::from(dir));
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("AppData").join("Roaming")))?;
        Some(base.join("Marshmori"))
    }
    #[cfg(not(windows))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share")))?;
        Some(base.join("marshmori"))
    }
}

struct Endpoint {
    port: u16,
    token: String,
    wait_secs: u64,
}

fn parse_endpoint(bytes: &[u8]) -> Option<Endpoint> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    let token = v.get("token")?.as_str()?.to_string();
    if port == 0 || token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let wait_secs = v
        .get("waitSecs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_WAIT_SECS)
        .clamp(5, MAX_WAIT_SECS);
    Some(Endpoint { port, token, wait_secs })
}

fn read_endpoint() -> Option<Endpoint> {
    let bytes = std::fs::read(data_dir()?.join("endpoint.json")).ok()?;
    parse_endpoint(&bytes)
}

/// Claude Code front ends whose own permission prompt never reaches PermissionRequest.
/// Must match `gate::is_ide` in the app.
fn is_ide(entry: &str) -> bool {
    let e = entry.to_ascii_lowercase();
    matches!(e.as_str(), "claude-vscode" | "claude-desktop" | "local-agent")
        || e.contains("vscode")
        || e.contains("jetbrains")
        || e.contains("cursor")
        || e.contains("windsurf")
}

/// Events where the agent waits for our answer before going on.
fn waits_for_answer(agent: &str, event: &str, ide: bool, task: bool, question: bool) -> bool {
    event == "PermissionRequest"
        || (agent == "antigravity" && event == "PreToolUse")
        || (agent == "claude" && event == "PreToolUse" && (ide || task || question))
}

/// Claude Code asks the user something (the island shows it with its choices).
fn is_question(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("tool_name").and_then(Value::as_str).map(|n| n == "AskUserQuestion"))
        .unwrap_or(false)
}

/// Where Claude Code runs and which folder it started in (only Claude Code sets these).
struct Origin {
    entry: Option<String>,
    project: Option<String>,
}

impl Origin {
    fn from_env(agent: &str) -> Origin {
        if agent != "claude" {
            return Origin { entry: None, project: None };
        }
        let entry = std::env::var("CLAUDE_CODE_ENTRYPOINT").ok().map(|e| clean(&e)).filter(|e| !e.is_empty());
        let project = std::env::var("CLAUDE_PROJECT_DIR").ok().filter(|p| !p.is_empty() && p.len() < 1024 && !p.chars().any(char::is_control));
        Origin { entry, project }
    }

    fn ide(&self) -> bool {
        self.entry.as_deref().map(is_ide).unwrap_or(false)
    }
}

fn main() {
    let args = parse_args(std::env::args().skip(1));
    let agent = if args.agent.is_empty() { "claude".to_string() } else { args.agent };
    // Antigravity expects a JSON object on stdout; `{}` means "no decision".
    let fallback = (agent == "antigravity").then_some("{}");

    // Marshmori's own side chat runs these agents' CLIs. Their hooks fire there too,
    // and must not report back to Marshmori (the chat would show up as a session, or
    // wait for an approval card). Read what the agent sends, then step aside.
    if std::env::var_os("MARSHMORI_INTERNAL").is_some() || std::env::var_os("AIMOJI_INTERNAL").is_some() {
        let _ = std::io::stdin().take(MAX_STDIN).read_to_end(&mut Vec::new());
        finish(None, fallback)
    }

    let task = std::env::var("MARSHMORI_TASK").ok().map(|t| clean(&t)).filter(|t| !t.is_empty());
    let origin = Origin::from_env(&agent);
    let Some((body, event)) = read_payload(&args.event, task.clone(), &origin) else { finish(None, fallback) };
    let question = agent == "claude" && event == "PreToolUse" && is_question(&body);
    let waits = waits_for_answer(&agent, &event, origin.ide(), task.is_some(), question);
    // A task Mamori runs in the background has no terminal to ask in: when Marshmori
    // can't answer a permission prompt, the answer is no (never "ask someone else",
    // nobody is there). A PreToolUse it can't reach just carries on as usual.
    let prompt = event == "PermissionRequest" || agent == "antigravity";
    let no_answer = if waits && prompt && task.is_some() { Some(deny_json(&agent)) } else { None };
    let Some(endpoint) = read_endpoint() else { finish(no_answer, fallback) };

    let budget = if waits { Duration::from_secs(endpoint.wait_secs + 6) } else { FIRE_AND_FORGET };

    // The worker owns every blocking call; if it overruns, we stop listening and
    // exit, and the socket dies with the process.
    let (tx, rx) = mpsc::channel();
    let (worker_agent, worker_event) = (agent.clone(), event.clone());
    std::thread::spawn(move || {
        let _ = tx.send(talk(&endpoint, &worker_agent, &worker_event, &body, waits));
    });
    let answer = rx.recv_timeout(budget).ok().flatten();
    finish(answer.or(no_answer), fallback)
}

/// "No" in the agent's own words.
fn deny_json(agent: &str) -> String {
    const REASON: &str = "Nobody could approve this in Marshmori, so it was not allowed.";
    match agent {
        "antigravity" => serde_json::json!({"decision": "deny", "reason": REASON}).to_string(),
        _ => serde_json::json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": REASON}}}).to_string(),
    }
}

fn finish(answer: Option<String>, fallback: Option<&str>) -> ! {
    let text = answer
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .or_else(|| fallback.map(str::to_string));
    if let Some(text) = text {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{text}");
        let _ = out.flush();
    }
    std::process::exit(0)
}

/// Reads stdin and returns the JSON to forward plus the event name.
fn read_payload(arg_event: &str, task: Option<String>, origin: &Origin) -> Option<(Vec<u8>, String)> {
    let mut raw = Vec::new();
    std::io::stdin().take(MAX_STDIN).read_to_end(&mut raw).ok()?;
    prepare_payload(&raw, arg_event, std::env::current_dir().ok(), task, origin)
}

fn prepare_payload(raw: &[u8], arg_event: &str, cwd: Option<PathBuf>, task: Option<String>, origin: &Origin) -> Option<(Vec<u8>, String)> {
    // Some shells hand us a UTF-8 BOM; serde_json refuses it.
    let raw = raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw);
    let mut payload: Value = if raw.iter().all(u8::is_ascii_whitespace) {
        Value::Object(Default::default())
    } else {
        serde_json::from_slice(raw).ok()?
    };
    let map = payload.as_object_mut()?;

    let event = map
        .get("hook_event_name")
        .and_then(Value::as_str)
        .map(clean)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| arg_event.to_string());
    if event.is_empty() {
        return None;
    }
    for field in DROPPED_FIELDS {
        map.remove(*field);
    }
    let cwd_missing = map.get("cwd").and_then(Value::as_str).map(str::is_empty).unwrap_or(true);
    if cwd_missing {
        if let Some(cwd) = cwd {
            map.insert("cwd".into(), Value::String(cwd.to_string_lossy().into_owned()));
        }
    }
    if let Some(task) = task {
        map.insert("marshmori_task".into(), Value::String(task));
    }
    if let Some(entry) = &origin.entry {
        map.insert("marshmori_entry".into(), Value::String(entry.clone()));
    }
    if let Some(project) = &origin.project {
        map.insert("marshmori_project".into(), Value::String(project.clone()));
    }
    truncate_strings(&mut payload);
    Some((serde_json::to_vec(&payload).ok()?, event))
}

/// Caps every string in the payload: one Write can carry a whole file.
fn truncate_strings(value: &mut Value) {
    match value {
        Value::String(s) => {
            if s.len() > MAX_FIELD_LEN {
                let mut end = MAX_FIELD_LEN;
                while end > 0 && !s.is_char_boundary(end) {
                    end -= 1;
                }
                s.truncate(end);
                s.push('…');
            }
        }
        Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Sends the event and, for a permission prompt, waits for the island's answer.
fn talk(ep: &Endpoint, agent: &str, event: &str, body: &[u8], waits: bool) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], ep.port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok()?;
    let _ = stream.set_nodelay(true);
    let read_budget = if waits { Duration::from_secs(ep.wait_secs + 4) } else { FIRE_AND_FORGET };
    let _ = stream.set_read_timeout(Some(read_budget));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));

    let head = format!(
        "POST /hook?agent={}&event={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Marshmori-Token: {}\r\nConnection: close\r\n\r\n",
        clean(agent),
        clean(event),
        ep.port,
        body.len(),
        ep.token
    );
    stream.write_all(head.as_bytes()).ok()?;
    stream.write_all(body).ok()?;
    let _ = stream.flush();

    let mut resp = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                resp.extend_from_slice(&chunk[..n]);
                if resp.len() > 1 << 20 || response_complete(&resp) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    parse_response(&resp)
}

fn header_end(resp: &[u8]) -> Option<usize> {
    resp.windows(4).position(|w| w == b"\r\n\r\n")
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().skip(1).find_map(|line| {
        let (k, v) = line.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

fn response_complete(resp: &[u8]) -> bool {
    let Some(end) = header_end(resp) else { return false };
    let head = String::from_utf8_lossy(&resp[..end]);
    match header_value(&head, "content-length").and_then(|v| v.parse::<usize>().ok()) {
        Some(len) => resp.len() >= end + 4 + len,
        None => false,
    }
}

/// The body of a 200 response, or nothing.
fn parse_response(resp: &[u8]) -> Option<String> {
    let end = header_end(resp)?;
    let head = String::from_utf8_lossy(&resp[..end]).into_owned();
    let status = head.lines().next()?.split_whitespace().nth(1)?;
    if status != "200" {
        return None;
    }
    let mut body = resp[end + 4..].to_vec();
    if header_value(&head, "transfer-encoding").map(|v| v.eq_ignore_ascii_case("chunked")).unwrap_or(false) {
        body = dechunk(&body)?;
    } else if let Some(len) = header_value(&head, "content-length").and_then(|v| v.parse::<usize>().ok()) {
        body.truncate(len);
    }
    let text = String::from_utf8_lossy(&body).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn dechunk(mut data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = data.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&data[..line_end]).ok()?;
        let size = usize::from_str_radix(size_text.split(';').next()?.trim(), 16).ok()?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        if data.len() < size {
            out.extend_from_slice(data);
            return Some(out);
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or(&[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Args {
        parse_args(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn arguments_accept_flags_and_a_bare_event() {
        assert_eq!(args(&["--agent", "codex", "--event", "Stop"]), Args { agent: "codex".into(), event: "Stop".into() });
        assert_eq!(args(&["PreToolUse"]), Args { agent: "".into(), event: "PreToolUse".into() });
        assert_eq!(args(&["--agent", "x y&z", "Stop"]), Args { agent: "xyz".into(), event: "Stop".into() });
    }

    fn origin() -> Origin {
        Origin { entry: None, project: None }
    }

    #[test]
    fn only_permission_prompts_wait() {
        assert!(waits_for_answer("claude", "PermissionRequest", false, false, false));
        assert!(waits_for_answer("codex", "PermissionRequest", false, false, false));
        assert!(waits_for_answer("antigravity", "PreToolUse", false, false, false));
        assert!(!waits_for_answer("claude", "PreToolUse", false, false, false), "a terminal session asks at PermissionRequest");
        assert!(waits_for_answer("claude", "PreToolUse", true, false, false), "the VS Code panel never sends PermissionRequest");
        assert!(waits_for_answer("claude", "PreToolUse", false, true, false), "nor does claude -p for a task");
        assert!(!waits_for_answer("codex", "PreToolUse", true, true, false));
        assert!(waits_for_answer("claude", "PreToolUse", false, false, true), "a question waits for its answer in a terminal too");
        assert!(is_question(br#"{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[]}}"#));
        assert!(!is_question(br#"{"hook_event_name":"PreToolUse","tool_name":"Bash"}"#));
        assert!(!waits_for_answer("antigravity", "Stop", false, false, false));
        assert!(is_ide("claude-vscode") && is_ide("claude-desktop") && !is_ide("cli") && !is_ide("sdk-cli"));
    }

    #[test]
    fn endpoint_file_is_validated() {
        let ep = parse_endpoint(br#"{"port":4242,"token":"abc123","waitSecs":9999}"#).unwrap();
        assert_eq!(ep.port, 4242);
        assert_eq!(ep.wait_secs, MAX_WAIT_SECS);
        assert!(parse_endpoint(br#"{"port":0,"token":"abc"}"#).is_none());
        assert!(parse_endpoint(br#"{"port":80,"token":"a b"}"#).is_none());
        assert!(parse_endpoint(b"not json").is_none());
    }

    #[test]
    fn payload_takes_the_event_from_json_first_and_drops_heavy_fields() {
        let raw = br#"{"hook_event_name":"PostToolUse","tool_response":{"big":"x"},"cwd":"C:\\p"}"#;
        let (body, event) = prepare_payload(raw, "Ignored", None, None, &origin()).unwrap();
        assert_eq!(event, "PostToolUse");
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert!(v.get("tool_response").is_none());
        assert_eq!(v["cwd"], "C:\\p");
        assert!(v.get("marshmori_task").is_none());

        let (_, event) = prepare_payload(br#"{"conversationId":"c1"}"#, "PreInvocation", Some(PathBuf::from("/w")), None, &origin()).unwrap();
        assert_eq!(event, "PreInvocation");

        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(br#"{"hook_event_name":"Stop"}"#);
        assert_eq!(prepare_payload(&bom, "", None, None, &origin()).unwrap().1, "Stop");
        assert!(prepare_payload(b"{}", "", None, None, &origin()).is_none());
    }

    #[test]
    fn a_background_task_is_denied_when_nobody_can_answer() {
        let v: Value = serde_json::from_str(&deny_json("claude")).unwrap();
        assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "deny");
        let v: Value = serde_json::from_str(&deny_json("antigravity")).unwrap();
        assert_eq!(v["decision"], "deny");
    }

    #[test]
    fn a_task_started_by_mamori_is_tagged() {
        let (body, _) = prepare_payload(br#"{"hook_event_name":"Stop"}"#, "", None, Some("t1791-2".into()), &origin()).unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["marshmori_task"], "t1791-2");
        assert!(v.get("marshmori_entry").is_none());

        let vscode = Origin { entry: Some("claude-vscode".into()), project: Some("C:\\Work\\Shop".into()) };
        let (body, _) = prepare_payload(br#"{"hook_event_name":"PreToolUse"}"#, "", None, None, &vscode).unwrap();
        let v: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["marshmori_entry"], "claude-vscode");
        assert_eq!(v["marshmori_project"], "C:\\Work\\Shop");
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "ก".repeat(3000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn responses_are_parsed_with_length_or_chunks() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"decision\":1}\nextra";
        assert_eq!(parse_response(ok).as_deref(), Some("{\"decision\":1}"));
        assert!(response_complete(ok));
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";
        assert_eq!(parse_response(chunked).as_deref(), Some("hello"));
        assert!(parse_response(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\nno").is_none());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").is_none());
    }
}
