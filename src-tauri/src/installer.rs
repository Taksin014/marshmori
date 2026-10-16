// Installs and removes Marshmori's hooks in each agent's own config file.
//
// The rules, same for all three files:
// * read the file strictly: a file we can't parse is reported, never overwritten;
// * keep everything that isn't ours exactly as it was (other tools' hooks too);
// * take a dated backup before writing, then write atomically;
// * uninstall removes our entries and nothing else.
//
// How each agent runs the command on Windows decides how we write it:
// * Claude Code: exec form (`command` + `args`), spawned directly, no shell.
// * Codex: `%COMSPEC% /C "<command>"`, so a quoted path is fine.
// * Antigravity: undocumented, so the path is written so that cmd, PowerShell and
//   bash all read it the same way (forward slashes, no quotes when possible).

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::agents::Agent;
use crate::paths;

/// What our hook commands contain: the relay's name.
const MARKERS: &[&str] = &["marshmori-hook"];

/// PreToolUse waits as long as a permission prompt: in an IDE's panel and in Mamori's
/// own tasks it is where the island asks (see gate.rs). Everywhere else the relay
/// answers it at once.
const CLAUDE_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("SessionEnd", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 600),
    ("PostToolUse", 10),
    ("PostToolUseFailure", 10),
    ("PermissionRequest", 600),
    ("Notification", 10),
    ("Stop", 10),
    ("StopFailure", 10),
    ("SubagentStart", 10),
    ("SubagentStop", 10),
];

const CODEX_EVENTS: &[(&str, u64)] = &[
    ("SessionStart", 10),
    ("UserPromptSubmit", 10),
    ("PreToolUse", 10),
    ("PostToolUse", 10),
    ("PermissionRequest", 600),
    ("Stop", 10),
    ("SessionEnd", 2),
];

/// (event, timeout, is a tool event that takes a matcher group)
const ANTIGRAVITY_EVENTS: &[(&str, u64, bool)] = &[
    ("PreInvocation", 10, false),
    ("PreToolUse", 600, true),
    ("PostToolUse", 10, true),
    ("PostInvocation", 10, false),
    ("Stop", 10, false),
];

/// Key of our group inside Antigravity's hooks.json.
const ANTIGRAVITY_GROUP: &str = "marshmori";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub agent: Agent,
    pub label: String,
    /// The agent's config folder exists, so it is probably installed.
    pub detected: bool,
    pub installed: bool,
    /// Our entries point at the relay where it is now.
    pub up_to_date: bool,
    pub config_path: String,
    pub relay_path: String,
    pub relay_ready: bool,
    pub note: String,
    pub error: Option<String>,
}

pub fn config_path(agent: Agent) -> PathBuf {
    let home = paths::home_dir();
    match agent {
        Agent::Claude => std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"))
            .join("settings.json"),
        Agent::Codex => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("hooks.json"),
        Agent::Antigravity => home.join(".gemini").join("config").join("hooks.json"),
    }
}

fn detected(agent: Agent) -> bool {
    let path = config_path(agent);
    match agent {
        Agent::Antigravity => paths::home_dir().join(".gemini").is_dir(),
        _ => path.parent().map(Path::is_dir).unwrap_or(false),
    }
}

fn note(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "เปิด session ใหม่ของ Claude Code หลังติดตั้ง",
        Agent::Codex => "เปิด Codex แล้วพิมพ์ /hooks เพื่อกด Trust ครั้งแรก",
        Agent::Antigravity => "รีสตาร์ท Antigravity หนึ่งครั้งหลังติดตั้ง",
    }
}

// ── Reading and writing ─────────────────────────────────────────────────────────

fn parse_config(bytes: &[u8], label: &str) -> Result<Value, String> {
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    match serde_json::from_slice::<Value>(text) {
        Ok(v) if v.is_object() => Ok(v),
        Ok(_) => Err(format!("{label} ไม่ใช่ JSON object — Marshmori จะไม่แตะไฟล์นี้")),
        Err(err) => Err(format!("{label} อ่านไม่ได้ ({err}) — แก้ไฟล์ก่อนแล้วลองใหม่ Marshmori จะไม่เขียนทับ")),
    }
}

fn read_config(path: &Path) -> Result<Value, String> {
    match std::fs::read(path) {
        Ok(bytes) => parse_config(&bytes, &path.display().to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(err) => Err(format!("อ่าน {} ไม่ได้: {err}", path.display())),
    }
}

fn write_config(path: &Path, value: &Value) -> Result<Option<PathBuf>, String> {
    let backup = if path.exists() {
        let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let backup = path.with_file_name(format!("{file}.marshmori-backup-{}", paths::stamp()));
        std::fs::copy(path, &backup).map_err(|e| format!("สำรองไฟล์ไม่สำเร็จ: {e}"))?;
        Some(backup)
    } else {
        None
    };
    let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    text.push('\n');
    paths::write_atomic(path, text.as_bytes()).map_err(|e| format!("เขียน {} ไม่สำเร็จ: {e}", path.display()))?;
    Ok(backup)
}

// ── Commands as each agent wants them ───────────────────────────────────────────

fn forward_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(unix)]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn codex_command(relay: &Path, event: &str) -> String {
    #[cfg(windows)]
    let exe = format!("\"{}\"", relay.display());
    #[cfg(unix)]
    let exe = sh_quote(&relay.to_string_lossy());
    format!("{exe} --agent codex --event {event}")
}

/// A path every shell reads as one word: forward slashes, quoted only if it must be.
fn portable_exe(relay: &Path) -> String {
    let plain = forward_slashes(relay);
    if !plain.contains(' ') && !plain.contains('\'') && !plain.contains('"') {
        return plain;
    }
    #[cfg(windows)]
    if let Some(short) = crate::platform::short_path(relay) {
        let short = short.replace('\\', "/");
        if !short.contains(' ') {
            return short;
        }
    }
    format!("\"{plain}\"")
}

/// Every way we may have written the relay path into a config.
fn relay_spellings(relay: &Path) -> Vec<String> {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut forms = vec![forward_slashes(relay), relay.to_string_lossy().into_owned()];
    #[cfg(windows)]
    if let Some(short) = crate::platform::short_path(relay) {
        forms.push(short.replace('\\', "/"));
    }
    forms
}

fn antigravity_command(relay: &Path, event: &str) -> String {
    format!("{} --agent antigravity --event {event}", portable_exe(relay))
}

fn is_ours(handler: &Value) -> bool {
    handler.get("command").and_then(Value::as_str).map(|c| MARKERS.iter().any(|m| c.contains(m))).unwrap_or(false)
}

/// A matcher group `{ "matcher"?, "hooks": [...] }` with at least one of our handlers,
/// or (Antigravity lifecycle events) one of our handlers on its own.
fn entry_is_ours(entry: &Value) -> bool {
    is_ours(entry)
        || entry
            .get("hooks")
            .and_then(Value::as_array)
            .map(|hooks| hooks.iter().any(is_ours))
            .unwrap_or(false)
}

fn merge_event_lists(hooks: &mut Map<String, Value>, events: &[(&str, u64)], make: impl Fn(&str, u64) -> Value) {
    for (event, timeout) in events {
        let mut list = hooks.get(*event).and_then(Value::as_array).cloned().unwrap_or_default();
        list.retain(|e| !entry_is_ours(e));
        list.push(json!({ "hooks": [make(event, *timeout)] }));
        hooks.insert((*event).to_string(), Value::Array(list));
    }
}

fn strip_event_lists(hooks: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (event, value) in hooks {
        match value.as_array() {
            Some(list) => {
                let kept: Vec<Value> = list.iter().filter(|e| !entry_is_ours(e)).cloned().collect();
                if !kept.is_empty() {
                    out.insert(event.clone(), Value::Array(kept));
                }
            }
            None => {
                out.insert(event.clone(), value.clone());
            }
        }
    }
    out
}

fn hooks_object(root: &Value, label: &str) -> Result<Map<String, Value>, String> {
    match root.get("hooks") {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(map)) => Ok(map.clone()),
        Some(_) => Err(format!("{label}: \"hooks\" มีรูปแบบที่ไม่รู้จัก — Marshmori จะไม่แตะไฟล์นี้")),
    }
}

// ── Merging (pure, tested) ──────────────────────────────────────────────────────

pub fn merged(agent: Agent, existing: &Value, relay: &Path) -> Result<Value, String> {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    match agent {
        Agent::Claude => {
            let mut hooks = hooks_object(existing, "settings.json")?;
            let exe = forward_slashes(relay);
            merge_event_lists(&mut hooks, CLAUDE_EVENTS, |event, timeout| {
                json!({
                    "type": "command",
                    "command": exe,
                    "args": ["--agent", "claude", "--event", event],
                    "timeout": timeout,
                })
            });
            root.insert("hooks".into(), Value::Object(hooks));
        }
        Agent::Codex => {
            let mut hooks = hooks_object(existing, "hooks.json")?;
            merge_event_lists(&mut hooks, CODEX_EVENTS, |event, timeout| {
                json!({ "type": "command", "command": codex_command(relay, event), "timeout": timeout })
            });
            root.insert("hooks".into(), Value::Object(hooks));
        }
        Agent::Antigravity => {
            let mut group = Map::new();
            for (event, timeout, tool_event) in ANTIGRAVITY_EVENTS {
                let handler = json!({ "type": "command", "command": antigravity_command(relay, event), "timeout": timeout });
                let entry = if *tool_event { json!([{ "matcher": "*", "hooks": [handler] }]) } else { json!([handler]) };
                group.insert((*event).to_string(), entry);
            }
            root.insert(ANTIGRAVITY_GROUP.into(), Value::Object(group));
        }
    }
    Ok(Value::Object(root))
}

pub fn without_ours(agent: Agent, existing: &Value) -> Value {
    let mut root = existing.as_object().cloned().unwrap_or_default();
    match agent {
        Agent::Claude | Agent::Codex => {
            if let Some(Value::Object(hooks)) = root.get("hooks") {
                let kept = strip_event_lists(hooks);
                if kept.is_empty() && agent == Agent::Claude {
                    root.remove("hooks");
                } else {
                    root.insert("hooks".into(), Value::Object(kept));
                }
            }
        }
        Agent::Antigravity => {
            root.remove(ANTIGRAVITY_GROUP);
        }
    }
    Value::Object(root)
}

/// Our handlers as (event, timeout), as they are in the agent's config.
fn our_handlers(agent: Agent, root: &Value) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let groups: Vec<&Map<String, Value>> = match agent {
        Agent::Antigravity => root.get(ANTIGRAVITY_GROUP).and_then(Value::as_object).into_iter().collect(),
        _ => root.get("hooks").and_then(Value::as_object).into_iter().collect(),
    };
    for events in groups {
        for (event, list) in events.iter().filter_map(|(k, v)| v.as_array().map(|a| (k, a))) {
            for entry in list {
                let handlers: Vec<&Value> = if is_ours(entry) {
                    vec![entry]
                } else {
                    entry.get("hooks").and_then(Value::as_array).map(|h| h.iter().filter(|h| is_ours(h)).collect()).unwrap_or_default()
                };
                for h in handlers {
                    out.push((event.clone(), h.get("timeout").and_then(Value::as_u64).unwrap_or(0)));
                }
            }
        }
    }
    out
}

/// Every event we install is there with today's timeout.
fn spec_current(agent: Agent, root: &Value) -> bool {
    let have = our_handlers(agent, root);
    let want: Vec<(&str, u64)> = match agent {
        Agent::Claude => CLAUDE_EVENTS.to_vec(),
        Agent::Codex => CODEX_EVENTS.to_vec(),
        Agent::Antigravity => ANTIGRAVITY_EVENTS.iter().map(|(e, t, _)| (*e, *t)).collect(),
    };
    want.iter().all(|(e, t)| have.iter().any(|(he, ht)| he == e && ht == t))
}

fn our_commands(agent: Agent, root: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let mut collect = |entry: &Value| {
        if is_ours(entry) {
            out.push(entry["command"].as_str().unwrap_or_default().to_string());
        }
        if let Some(list) = entry.get("hooks").and_then(Value::as_array) {
            for h in list.iter().filter(|h| is_ours(h)) {
                out.push(h["command"].as_str().unwrap_or_default().to_string());
            }
        }
    };
    let groups: Vec<&Map<String, Value>> = match agent {
        Agent::Antigravity => root.get(ANTIGRAVITY_GROUP).and_then(Value::as_object).into_iter().collect(),
        _ => root.get("hooks").and_then(Value::as_object).into_iter().collect(),
    };
    for events in groups {
        for list in events.values().filter_map(Value::as_array) {
            list.iter().for_each(&mut collect);
        }
    }
    out
}

/// Brings our entries up to date where they are installed but out of date (the relay
/// moved, or a new version waits longer on an event). Codex is only touched when its
/// relay path is wrong: it asks the user to trust changed hooks again.
pub fn upgrade_outdated() -> Vec<Agent> {
    let relay = paths::relay_path();
    if !relay.exists() {
        return Vec::new();
    }
    let forms = relay_spellings(&relay);
    let mut done = Vec::new();
    for agent in Agent::ALL {
        let Ok(root) = read_config(&config_path(agent)) else { continue };
        let commands = our_commands(agent, &root);
        if commands.is_empty() {
            continue;
        }
        let path_ok = commands.iter().all(|c| forms.iter().any(|f| c.contains(f.as_str())));
        let spec_ok = spec_current(agent, &root);
        if path_ok && (spec_ok || agent == Agent::Codex) {
            continue;
        }
        match install(agent) {
            Ok(_) => {
                crate::log::line(format!("updated {}'s hooks", agent.id()));
                done.push(agent);
            }
            Err(err) => crate::log::line(format!("could not update {}'s hooks: {err}", agent.id())),
        }
    }
    done
}

/// Connects every agent that is on this computer and not connected yet (first run,
/// "connect them all"). Returns (agent, result) for each one it tried.
pub fn install_detected() -> Vec<(Agent, Result<String, String>)> {
    Agent::ALL
        .iter()
        .filter(|a| {
            let st = status(**a);
            st.detected && !(st.installed && st.up_to_date) && st.error.is_none()
        })
        .map(|a| (*a, install(*a)))
        .collect()
}

/// Like `install_detected`, leaving out the agents in `off` (ids the user disconnected).
pub fn install_detected_except(off: &[String]) -> Vec<(Agent, Result<String, String>)> {
    Agent::ALL
        .iter()
        .filter(|a| !off.iter().any(|o| o == a.id()))
        .filter(|a| {
            let st = status(**a);
            st.detected && !st.installed && st.error.is_none() && st.relay_ready
        })
        .map(|a| (*a, install(*a)))
        .collect()
}

// ── Public API ──────────────────────────────────────────────────────────────────

pub fn status(agent: Agent) -> HookStatus {
    let path = config_path(agent);
    let relay = paths::relay_path();
    let (installed, up_to_date, error) = match read_config(&path) {
        Ok(root) => {
            let commands = our_commands(agent, &root);
            let forms = relay_spellings(&relay);
            let current = commands.iter().all(|c| forms.iter().any(|f| c.contains(f.as_str()))) && spec_current(agent, &root);
            (!commands.is_empty(), !commands.is_empty() && current, None)
        }
        Err(err) => (false, false, Some(err)),
    };
    HookStatus {
        agent,
        label: agent.label().to_string(),
        detected: detected(agent),
        installed,
        up_to_date,
        config_path: path.display().to_string(),
        relay_ready: relay.exists(),
        relay_path: relay.display().to_string(),
        note: note(agent).to_string(),
        error,
    }
}

pub fn status_all() -> Vec<HookStatus> {
    Agent::ALL.iter().map(|a| status(*a)).collect()
}

/// Returns a message for the settings window.
pub fn install(agent: Agent) -> Result<String, String> {
    let relay = paths::relay_path();
    if !relay.exists() {
        return Err(format!("ไม่พบ {} — ลองปิดแล้วเปิด Marshmori ใหม่", relay.display()));
    }
    let path = config_path(agent);
    let current = read_config(&path)?;
    let next = merged(agent, &current, &relay)?;
    let backup = write_config(&path, &next)?;
    crate::log::line(format!("hooks installed for {} in {}", agent.id(), path.display()));
    Ok(match backup {
        Some(b) => format!("ติดตั้งแล้ว (สำรองไฟล์เดิมไว้ที่ {}) · {}", b.display(), note(agent)),
        None => format!("ติดตั้งแล้ว · {}", note(agent)),
    })
}

pub fn uninstall(agent: Agent) -> Result<String, String> {
    let path = config_path(agent);
    if !path.exists() {
        return Ok("ไม่มีอะไรต้องถอน".into());
    }
    let current = read_config(&path)?;
    if our_commands(agent, &current).is_empty() {
        return Ok("ไม่มี hooks ของ Marshmori ในไฟล์นี้".into());
    }
    let next = without_ours(agent, &current);
    let backup = write_config(&path, &next)?;
    crate::log::line(format!("hooks removed for {} in {}", agent.id(), path.display()));
    Ok(match backup {
        Some(b) => format!("ถอนแล้ว (สำรองไฟล์เดิมไว้ที่ {})", b.display()),
        None => "ถอนแล้ว".into(),
    })
}

/// Copies the relay next to our data so hook configs can point at a path that never
/// moves. In an installed app it comes from the bundle's resources; in `tauri dev`
/// it sits in target/release, built by `npm run hook`.
pub fn ensure_relay(app: &AppHandle) {
    let dest = paths::relay_path();
    let Some(dir) = dest.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app.path().resolve(paths::HOOK_EXE, tauri::path::BaseDirectory::Resource) {
        candidates.push(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join(paths::HOOK_EXE));
            candidates.push(parent.join("..").join("release").join(paths::HOOK_EXE));
        }
    }
    let Some(src) = candidates.iter().find(|p| p.is_file()) else {
        crate::log::line(format!(
            "{} not found — hooks can't work. Looked in: {}",
            paths::HOOK_EXE,
            candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ")
        ));
        return;
    };
    let same = match (std::fs::read(src), std::fs::read(&dest)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same {
        return;
    }
    // Written beside and renamed over, so an agent starting the relay right now
    // runs either the old one or the new one, never half a file. On Windows a
    // running relay keeps the old file locked; it is the same relay, so that's fine.
    let tmp = dest.with_extension(format!("new-{}", std::process::id()));
    let result = std::fs::copy(src, &tmp).and_then(|_| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&tmp, &dest)
    });
    match result {
        Ok(()) => crate::log::line(format!("relay installed at {}", dest.display())),
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            crate::log::line(format!("could not install relay: {err}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relay() -> PathBuf {
        PathBuf::from("/home/me/.local/share/marshmori/local/bin/marshmori-hook")
    }

    #[test]
    fn an_older_install_is_out_of_date_until_merged_again() {
        let fresh = merged(Agent::Claude, &json!({}), &relay()).unwrap();
        assert!(spec_current(Agent::Claude, &fresh));
        assert_eq!(fresh["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"], 600, "PreToolUse waits like a prompt now");
        // 0.4 installed PreToolUse with a 10 second timeout.
        let mut old = fresh.clone();
        old["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"] = json!(10);
        assert!(!spec_current(Agent::Claude, &old));
        assert!(spec_current(Agent::Claude, &merged(Agent::Claude, &old, &relay()).unwrap()));
        let agy = merged(Agent::Antigravity, &json!({}), &relay()).unwrap();
        assert!(spec_current(Agent::Antigravity, &agy));
        assert!(!spec_current(Agent::Codex, &json!({})));
    }

    #[test]
    fn claude_merge_keeps_everything_else_and_round_trips() {
        let existing = json!({
            "model": "claude-opus-5-5",
            "env": {"FOO": "1"},
            "hooks": {
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "other-tool.exe"}]}],
                "SomethingElse": [{"hooks": [{"type": "command", "command": "keep-me"}]}]
            }
        });
        let after = merged(Agent::Claude, &existing, &relay()).unwrap();
        assert_eq!(after["model"], "claude-opus-5-5");
        assert_eq!(after["env"]["FOO"], "1");
        let pre = after["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2);
        assert_eq!(pre[1]["hooks"][0]["args"], json!(["--agent", "claude", "--event", "PreToolUse"]));
        assert_eq!(after["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"], 600);
        assert!(after["hooks"]["SomethingElse"].is_array());
        // Installing twice doesn't duplicate.
        let twice = merged(Agent::Claude, &after, &relay()).unwrap();
        assert_eq!(twice["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);
        // And removing ours gives back the original.
        assert_eq!(without_ours(Agent::Claude, &after), existing);
    }

    #[test]
    fn codex_file_keeps_only_known_top_level_keys() {
        let after = merged(Agent::Codex, &json!({}), &relay()).unwrap();
        let keys: Vec<&String> = after.as_object().unwrap().keys().collect();
        assert_eq!(keys, vec!["hooks"]);
        let cmd = after["hooks"]["PermissionRequest"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("marshmori-hook"));
        assert!(cmd.ends_with("--agent codex --event PermissionRequest"));
        assert_eq!(our_commands(Agent::Codex, &after).len(), CODEX_EVENTS.len());
        let removed = without_ours(Agent::Codex, &after);
        assert_eq!(removed, json!({"hooks": {}}));
    }

    #[test]
    fn antigravity_gets_its_own_group() {
        let existing = json!({"my-linter": {"PostToolUse": [{"matcher": "write_to_file", "hooks": [{"command": "./lint.sh"}]}]}});
        let after = merged(Agent::Antigravity, &existing, &relay()).unwrap();
        assert!(after["my-linter"].is_object());
        assert_eq!(after["marshmori"]["PreToolUse"][0]["matcher"], "*");
        assert!(after["marshmori"]["Stop"][0]["command"].as_str().unwrap().ends_with("--agent antigravity --event Stop"));
        assert_eq!(our_commands(Agent::Antigravity, &after).len(), ANTIGRAVITY_EVENTS.len());
        assert_eq!(without_ours(Agent::Antigravity, &after), existing);
    }

    #[test]
    fn unreadable_files_are_refused_not_emptied() {
        assert!(parse_config(b"{ nope", "x").is_err());
        assert!(parse_config(b"[1]", "x").is_err());
        assert_eq!(parse_config(b"  \n", "x").unwrap(), json!({}));
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(br#"{"a":1}"#);
        assert_eq!(parse_config(&bom, "x").unwrap()["a"], 1);
        assert!(merged(Agent::Claude, &json!({"hooks": "weird"}), &relay()).is_err());
    }

    #[test]
    fn paths_with_spaces_are_quoted_for_unknown_shells() {
        assert_eq!(portable_exe(Path::new("/opt/marshmori/bin/marshmori-hook")), "/opt/marshmori/bin/marshmori-hook");
        assert_eq!(portable_exe(Path::new("/home/John Smith/marshmori-hook")), "\"/home/John Smith/marshmori-hook\"");
    }
}
