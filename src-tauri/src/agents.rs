// One vocabulary for three agents.
//
// Claude Code and Codex send the same field names (session_id, cwd, tool_name,
// tool_input…); Antigravity has its own (conversationId, workspacePaths, toolCall)
// and no event name in the payload, so the relay passes it as --event.
// Everything after this file works on `Event` only.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Claude,
    Codex,
    Antigravity,
}

impl Agent {
    pub const ALL: [Agent; 3] = [Agent::Claude, Agent::Codex, Agent::Antigravity];

    pub fn parse(s: &str) -> Option<Agent> {
        match s.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" => Some(Agent::Claude),
            "codex" => Some(Agent::Codex),
            "antigravity" | "agy" => Some(Agent::Antigravity),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Agent::Claude => "claude",
            Agent::Codex => "codex",
            Agent::Antigravity => "antigravity",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Agent::Claude => "Claude Code",
            Agent::Codex => "Codex",
            Agent::Antigravity => "Antigravity",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    SessionStart,
    Prompt,
    ToolStart,
    ToolEnd,
    ToolFailed,
    Permission,
    Notification,
    Stop,
    StopFailure,
    SessionEnd,
    SubagentStart,
    SubagentStop,
    Compact,
    Interrupt,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    Command,
    Edit,
    Read,
    Search,
    Web,
    Agent,
    Plan,
    Mcp,
    /// The agent asks the user something and waits (Claude Code's AskUserQuestion).
    Question,
    Other,
}

/// One choice of a question, as the agent wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
}

/// One question of Claude Code's AskUserQuestion (it asks one to four at a time).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    /// The full question; the answer is filed under exactly this text.
    pub question: String,
    /// A very short label for it ("Auth method").
    #[serde(default)]
    pub header: String,
    pub options: Vec<QuestionOption>,
    #[serde(default)]
    pub multi_select: bool,
}

/// The questions in an AskUserQuestion call, or None when it doesn't look like one.
pub fn questions(input: &Value) -> Option<Vec<Question>> {
    let list = input.get("questions")?.as_array()?;
    let text = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let out: Vec<Question> = list
        .iter()
        .filter_map(|q| {
            let question = q.get("question").and_then(Value::as_str)?.to_string();
            let options = q
                .get("options")
                .and_then(Value::as_array)
                .map(|o| {
                    o.iter()
                        .filter_map(|o| {
                            let label = text(o, "label");
                            (!label.is_empty()).then(|| QuestionOption { label, description: text(o, "description") })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let multi_select = q.get("multiSelect").or_else(|| q.get("multi_select")).and_then(Value::as_bool).unwrap_or(false);
            (!question.trim().is_empty()).then(|| Question { question, header: text(q, "header"), options, multi_select })
        })
        .collect();
    (!out.is_empty()).then_some(out)
}

#[derive(Debug, Clone)]
pub struct Tool {
    /// Exactly as the agent names it (Bash, apply_patch, run_command…).
    pub name: String,
    pub kind: ToolKind,
    /// Short Thai text for the ticker: "รัน npm test", "แก้ไข main.rs".
    pub summary: String,
    /// The command line, or the file(s) touched.
    pub target: Option<String>,
    /// A longer preview for the approval card (diff, patch, file start).
    pub detail: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Event {
    pub agent: Agent,
    pub kind: Kind,
    /// The agent's own event name.
    pub name: String,
    pub session_id: String,
    pub cwd: String,
    pub tool: Option<Tool>,
    /// Prompt, notification message, last answer or error, depending on the kind.
    pub text: Option<String>,
    pub notification_type: Option<String>,
    /// Set when Mamori started this session itself (a task from the island): the relay
    /// passes the task's id along (MARSHMORI_TASK).
    pub task: Option<String>,
    /// The agent's id for this one tool call, which ties a permission prompt to the
    /// PreToolUse that came before it (and a card to the tool that ran).
    pub tool_use_id: Option<String>,
    /// "default", "acceptEdits", "plan"… as the agent reports it.
    pub permission_mode: Option<String>,
    /// Where Claude Code runs, from the relay (CLAUDE_CODE_ENTRYPOINT): "cli",
    /// "claude-vscode", "claude-desktop"…
    pub entry: Option<String>,
    /// The folder Claude Code was started in (CLAUDE_PROJECT_DIR, from the relay).
    pub project_dir: Option<String>,
    /// The tool's arguments as the agent sent them (long strings already cut by the relay).
    pub input: Value,
}

impl Event {
    pub fn session_key(&self) -> String {
        format!("{}:{}", self.agent.id(), self.session_id)
    }
}

pub fn normalize(agent: Agent, event_hint: &str, payload: &Value) -> Event {
    match agent {
        Agent::Antigravity => antigravity(event_hint, payload),
        _ => claude_like(agent, event_hint, payload),
    }
}

fn s(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(text) if !text.trim().is_empty() => Some(text.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn claude_like(agent: Agent, hint: &str, p: &Value) -> Event {
    let name = s(p, "hook_event_name").unwrap_or_else(|| hint.to_string());
    let kind = match name.as_str() {
        "SessionStart" => Kind::SessionStart,
        "UserPromptSubmit" => Kind::Prompt,
        "PreToolUse" => Kind::ToolStart,
        "PostToolUse" | "PostToolBatch" => Kind::ToolEnd,
        "PostToolUseFailure" => Kind::ToolFailed,
        "PermissionRequest" => Kind::Permission,
        "Notification" => Kind::Notification,
        "Stop" => Kind::Stop,
        "StopFailure" => Kind::StopFailure,
        "SessionEnd" => Kind::SessionEnd,
        "SubagentStart" => Kind::SubagentStart,
        "SubagentStop" => Kind::SubagentStop,
        "PreCompact" | "PostCompact" => Kind::Compact,
        "Interrupt" => Kind::Interrupt,
        _ => Kind::Other,
    };
    let tool = p
        .get("tool_name")
        .and_then(Value::as_str)
        .map(|n| describe(n, p.get("tool_input").unwrap_or(&Value::Null)));
    let error = s(p, "error").or_else(|| s(p, "error_message")).or_else(|| s(p, "error_type"));
    let text = match kind {
        Kind::Prompt => s(p, "prompt"),
        Kind::Notification => s(p, "message"),
        Kind::Stop => s(p, "last_assistant_message"),
        Kind::StopFailure | Kind::ToolFailed => error.or_else(|| s(p, "reason")),
        Kind::SessionEnd => s(p, "reason"),
        Kind::SessionStart => s(p, "source"),
        Kind::SubagentStart | Kind::SubagentStop => s(p, "agent_type"),
        _ => None,
    };
    Event {
        agent,
        kind,
        name,
        session_id: s(p, "session_id").unwrap_or_else(|| "default".into()),
        cwd: s(p, "cwd").map(|c| uri_to_path(&c)).unwrap_or_default(),
        tool,
        text,
        notification_type: s(p, "notification_type"),
        task: task_id(p),
        tool_use_id: s(p, "tool_use_id").map(|id| short_id(&id)),
        permission_mode: s(p, "permission_mode").map(|m| short_id(&m)),
        entry: s(p, "marshmori_entry").map(|e| short_id(&e)).filter(|e| !e.is_empty()),
        project_dir: s(p, "marshmori_project").filter(|d| d.len() < 1024 && !d.chars().any(char::is_control)),
        input: p.get("tool_input").cloned().unwrap_or(Value::Null),
    }
}

/// Ids and names the relay passes along: `[A-Za-z0-9_.:-]`, 80 characters at most.
fn short_id(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':')).take(80).collect()
}

/// The task id the relay added, if it looks like one of ours.
fn task_id(p: &Value) -> Option<String> {
    let id = p.get("marshmori_task")?.as_str()?;
    let ok = !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then(|| id.to_string())
}

fn antigravity(hint: &str, p: &Value) -> Event {
    let error = s(p, "error");
    let kind = match hint {
        "PreInvocation" => Kind::Prompt,
        "PreToolUse" => Kind::ToolStart,
        "PostToolUse" if error.is_some() => Kind::ToolFailed,
        "PostToolUse" | "PostInvocation" => Kind::ToolEnd,
        "Stop" => {
            let reason = s(p, "terminationReason").unwrap_or_default().to_ascii_lowercase();
            if error.is_some() || reason.contains("error") || reason.contains("fail") {
                Kind::StopFailure
            } else if reason.contains("cancel") || reason.contains("interrupt") || reason.contains("abort") {
                Kind::Interrupt
            } else {
                Kind::Stop
            }
        }
        _ => Kind::Other,
    };
    let session_id = s(p, "conversationId")
        .or_else(|| s(p, "conversation_id"))
        .unwrap_or_else(|| "default".into());
    let cwd = p
        .get("workspacePaths")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(Value::as_str)
        .map(uri_to_path)
        .or_else(|| s(p, "cwd").map(|c| uri_to_path(&c)))
        .unwrap_or_default();
    let call = p.get("toolCall");
    let tool = call.and_then(|call| {
        let name = call.get("name")?.as_str()?;
        Some(describe(name, call.get("args").unwrap_or(&Value::Null)))
    });
    let text = match kind {
        Kind::StopFailure | Kind::ToolFailed => error.or_else(|| s(p, "terminationReason")),
        _ => None,
    };
    Event {
        agent: Agent::Antigravity,
        kind,
        name: hint.to_string(),
        session_id,
        cwd,
        tool,
        text,
        notification_type: None,
        task: task_id(p),
        tool_use_id: call.and_then(|c| s(c, "id")).map(|id| short_id(&id)),
        permission_mode: None,
        entry: None,
        project_dir: None,
        input: call.and_then(|c| c.get("args")).cloned().unwrap_or(Value::Null),
    }
}

/// `file:///c%3A/Users/me/app` → `c:/Users/me/app`; anything else is returned as is.
pub fn uri_to_path(s: &str) -> String {
    let Some(rest) = s.strip_prefix("file://") else { return s.to_string() };
    let rest = rest.strip_prefix('/').filter(|r| r.len() > 1 && r.as_bytes().get(1) == Some(&b':') || r.contains("%3A") || r.contains("%3a")).unwrap_or(rest);
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16);
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ── Tools in plain Thai ─────────────────────────────────────────────────────────

/// The last path segment, whatever the separator.
pub fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed)
}

/// First line, whitespace collapsed, at most `max` characters.
pub fn short(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max {
        collapsed
    } else {
        let cut: String = collapsed.chars().take(max.saturating_sub(1)).collect();
        format!("{cut}…")
    }
}

fn clip_lines(text: &str, max_lines: usize, max_chars: usize) -> String {
    let mut out: Vec<&str> = text.lines().take(max_lines).collect();
    let more = text.lines().count() > max_lines;
    if more {
        out.push("…");
    }
    let joined = out.join("\n");
    if joined.chars().count() > max_chars {
        let cut: String = joined.chars().take(max_chars).collect();
        format!("{cut}…")
    } else {
        joined
    }
}

fn field(input: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| match input.get(*k)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect();
            (!parts.is_empty()).then(|| parts.join(" "))
        }
        _ => None,
    })
}

/// Files named in an apply_patch body.
pub fn patch_files(patch: &str) -> Vec<String> {
    let mut files = Vec::new();
    for line in patch.lines() {
        for prefix in ["*** Update File: ", "*** Add File: ", "*** Delete File: ", "*** Move to: "] {
            if let Some(f) = line.strip_prefix(prefix) {
                let f = f.trim().to_string();
                if !f.is_empty() && !files.contains(&f) {
                    files.push(f);
                }
            }
        }
    }
    files
}

pub fn describe(name: &str, input: &Value) -> Tool {
    let lname = name.to_ascii_lowercase();
    let tool = |kind: ToolKind, summary: String, target: Option<String>, detail: Option<String>| Tool {
        name: name.to_string(),
        kind,
        summary,
        target,
        detail,
    };

    if let Some(rest) = name.strip_prefix("mcp__") {
        let mut parts = rest.splitn(2, "__");
        let server = parts.next().unwrap_or("mcp").to_string();
        let action = parts.next().unwrap_or(&server).to_string();
        return tool(ToolKind::Mcp, format!("ใช้ {action} ({server})"), None, Some(clip_lines(&input.to_string(), 12, 900)));
    }

    match lname.as_str() {
        "bash" | "powershell" | "shell" | "run_command" | "exec_command" | "local_shell" | "unified_exec"
        | "shell_command" | "run_terminal_cmd" | "execute_command" | "run_shell_command" => {
            let cmd = field(input, &["command", "CommandLine", "cmd", "commandLine", "script"]);
            let summary = match &cmd {
                Some(c) => format!("รัน {}", short(c, 46)),
                None => "รันคำสั่ง".to_string(),
            };
            let detail = cmd.as_deref().map(|c| clip_lines(c, 14, 1200));
            tool(ToolKind::Command, summary, cmd, detail)
        }
        // Antigravity: typing into a command it started, running a notebook.
        "send_command_input" | "notebook_execution" => {
            let summary = if lname == "notebook_execution" { "รันโน้ตบุ๊ก" } else { "พิมพ์ใส่คำสั่งที่รันอยู่" };
            let what = field(input, &["Input", "input", "Text", "text"]);
            tool(ToolKind::Command, summary.to_string(), None, what.map(|w| clip_lines(&w, 14, 1200)))
        }
        "apply_patch" => {
            let patch = field(input, &["command", "patch", "input"]).unwrap_or_default();
            let files = patch_files(&patch);
            let summary = match files.len() {
                0 => "แก้ไขไฟล์".to_string(),
                1 => format!("แก้ไข {}", basename(&files[0])),
                n => format!("แก้ไข {} และอีก {} ไฟล์", basename(&files[0]), n - 1),
            };
            let target = (!files.is_empty()).then(|| files.join(", "));
            tool(ToolKind::Edit, summary, target, (!patch.is_empty()).then(|| clip_lines(&patch, 24, 1600)))
        }
        "edit" | "multiedit" | "str_replace_based_edit_tool" | "str_replace_editor" | "replace_file_content"
        | "multi_replace_file_content" | "edit_file" | "replace" | "sed_file" => {
            let path = field(input, &["file_path", "path", "TargetFile", "target_file", "filePath", "File", "AbsolutePath"]);
            let old = field(input, &["old_string", "TargetContent", "old_str"]);
            let new = field(input, &["new_string", "ReplacementContent", "new_str"]);
            let detail = match (&old, &new) {
                (Some(o), Some(n)) => Some(format!(
                    "{}\n{}",
                    clip_lines(o, 8, 500).lines().map(|l| format!("- {l}")).collect::<Vec<_>>().join("\n"),
                    clip_lines(n, 8, 500).lines().map(|l| format!("+ {l}")).collect::<Vec<_>>().join("\n")
                )),
                _ => input
                    .get("edits")
                    .or_else(|| input.get("ReplacementChunks"))
                    .and_then(Value::as_array)
                    .map(|e| format!("{} จุดในไฟล์นี้", e.len())),
            };
            let summary = path.as_deref().map(|p| format!("แก้ไข {}", basename(p))).unwrap_or_else(|| "แก้ไขไฟล์".into());
            tool(ToolKind::Edit, summary, path, detail)
        }
        "write" | "write_to_file" | "create" | "create_file" | "notebookedit" | "notebook_edit" | "write_file" => {
            let path = field(input, &["file_path", "path", "TargetFile", "notebook_path", "filePath", "File", "AbsolutePath"]);
            let content = field(input, &["content", "CodeContent", "file_text", "new_source"]);
            let summary = path.as_deref().map(|p| format!("เขียน {}", basename(p))).unwrap_or_else(|| "เขียนไฟล์".into());
            tool(ToolKind::Edit, summary, path, content.map(|c| clip_lines(&c, 16, 1200)))
        }
        "read" | "view_file" | "view" | "read_file" | "view_code_item" | "list_dir" | "ls" | "glob"
        | "view_file_outline" | "list_directory" | "read_many_files" => {
            let target = field(input, &["file_path", "path", "AbsolutePath", "DirectoryPath", "pattern", "File", "notebook_path"]);
            let summary = target.as_deref().map(|t| format!("อ่าน {}", short(basename(t), 40))).unwrap_or_else(|| "อ่านไฟล์".into());
            tool(ToolKind::Read, summary, target, None)
        }
        "grep" | "search" | "grep_search" | "find_by_name" | "codebase_search" | "search_files" | "find"
        | "search_file_content" => {
            let q = field(input, &["pattern", "Query", "query", "Pattern", "SearchPattern"]);
            let summary = q.as_deref().map(|q| format!("ค้นหา {}", short(q, 40))).unwrap_or_else(|| "ค้นหาในโปรเจกต์".into());
            tool(ToolKind::Search, summary, q, None)
        }
        "webfetch" | "read_url_content" | "fetch" | "open_url" | "web_fetch" => {
            let url = field(input, &["url", "Url", "URL"]);
            let host = url
                .as_deref()
                .map(|u| u.split("://").nth(1).unwrap_or(u).split('/').next().unwrap_or(u).to_string());
            let summary = host.map(|h| format!("เปิดเว็บ {h}")).unwrap_or_else(|| "เปิดเว็บ".into());
            tool(ToolKind::Web, summary, url, None)
        }
        "websearch" | "search_web" | "web_search" | "google_web_search" => {
            let q = field(input, &["query", "Query", "q"]);
            let summary = q.as_deref().map(|q| format!("ค้นเว็บ: {}", short(q, 36))).unwrap_or_else(|| "ค้นเว็บ".into());
            tool(ToolKind::Web, summary, q, None)
        }
        "task" | "agent" | "spawn_agent" => {
            let what = field(input, &["description", "prompt", "subagent_type"]);
            let summary = what.as_deref().map(|w| format!("ส่งงานให้ผู้ช่วย: {}", short(w, 30))).unwrap_or_else(|| "ส่งงานให้ผู้ช่วย".into());
            tool(ToolKind::Agent, summary, what, None)
        }
        "todowrite" | "update_plan" | "todo_write" | "task_boundary" => tool(ToolKind::Plan, "อัปเดตแผนงาน".into(), None, None),
        "askuserquestion" => {
            let list = questions(input).unwrap_or_default();
            let summary = match list.first() {
                Some(q) => format!("ถามคุณ: {}", short(&q.question, 40)),
                None => "ถามคุณ".to_string(),
            };
            let detail = (!list.is_empty()).then(|| list.iter().map(|q| q.question.trim()).collect::<Vec<_>>().join("\n"));
            tool(ToolKind::Question, summary, None, detail)
        }
        "exitplanmode" => {
            let plan = field(input, &["plan"]);
            tool(ToolKind::Plan, "ขออนุมัติแผนงาน".into(), None, plan.map(|p| clip_lines(&p, 40, 2400)))
        }
        "call_mcp_tool" => {
            let action = field(input, &["ToolName", "tool_name", "name"]).unwrap_or_else(|| "เครื่องมือ".into());
            let server = field(input, &["ServerName", "server_name", "server"]);
            let summary = match server {
                Some(server) => format!("ใช้ {action} ({server})"),
                None => format!("ใช้ {action}"),
            };
            tool(ToolKind::Mcp, summary, None, Some(clip_lines(&input.to_string(), 12, 900)))
        }
        _ if lname.contains("browser") => tool(ToolKind::Web, "ใช้เบราว์เซอร์".into(), None, None),
        _ => {
            let detail = (!input.is_null()).then(|| clip_lines(&input.to_string(), 10, 700));
            tool(ToolKind::Other, format!("ใช้ {}", short(name, 30)), None, detail)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_and_codex_events_map_to_one_vocabulary() {
        let ev = normalize(
            Agent::Claude,
            "",
            &json!({"hook_event_name":"PreToolUse","session_id":"s1","cwd":"C:\\proj\\shop","tool_name":"Bash","tool_input":{"command":"npm test"}}),
        );
        assert_eq!(ev.kind, Kind::ToolStart);
        assert_eq!(ev.session_key(), "claude:s1");
        let tool = ev.tool.unwrap();
        assert_eq!(tool.kind, ToolKind::Command);
        assert_eq!(tool.summary, "รัน npm test");
        assert_eq!(tool.target.as_deref(), Some("npm test"));

        let ev = normalize(Agent::Codex, "PermissionRequest", &json!({"session_id":"x","cwd":"/w","tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** Add File: src/new.ts\n+x\n*** End Patch"}}));
        assert_eq!(ev.kind, Kind::Permission);
        let tool = ev.tool.unwrap();
        assert_eq!(tool.summary, "แก้ไข app.ts และอีก 1 ไฟล์");
        assert_eq!(tool.target.as_deref(), Some("src/app.ts, src/new.ts"));

        let ev = normalize(Agent::Codex, "", &json!({"hook_event_name":"UserPromptSubmit","session_id":"x","prompt":"fix the bug"}));
        assert_eq!(ev.kind, Kind::Prompt);
        assert_eq!(ev.text.as_deref(), Some("fix the bug"));
    }

    #[test]
    fn antigravity_uses_its_own_field_names() {
        let ev = normalize(
            Agent::Antigravity,
            "PreToolUse",
            &json!({"conversationId":"c9","workspacePaths":["file:///c%3A/Users/me/landing"],"toolCall":{"name":"run_command","args":{"CommandLine":"npm run build","Cwd":"c:/Users/me/landing"}}}),
        );
        assert_eq!(ev.kind, Kind::ToolStart);
        assert_eq!(ev.session_key(), "antigravity:c9");
        assert_eq!(ev.cwd, "c:/Users/me/landing");
        assert_eq!(ev.tool.unwrap().summary, "รัน npm run build");

        let ev = normalize(Agent::Antigravity, "Stop", &json!({"conversationId":"c9","terminationReason":"completed"}));
        assert_eq!(ev.kind, Kind::Stop);
        let ev = normalize(Agent::Antigravity, "Stop", &json!({"conversationId":"c9","error":"boom"}));
        assert_eq!(ev.kind, Kind::StopFailure);
        assert_eq!(ev.text.as_deref(), Some("boom"));
        let ev = normalize(Agent::Antigravity, "PostToolUse", &json!({"conversationId":"c9","toolCall":{"name":"view_file","args":{"AbsolutePath":"/a/b/readme.md"}}}));
        assert_eq!(ev.kind, Kind::ToolEnd);
        assert_eq!(ev.tool.unwrap().summary, "อ่าน readme.md");
    }

    #[test]
    fn antigravity_tools_that_change_things_are_not_other() {
        // agy 1.3.5's own tool list: these edit files or run something, so a task's gate must see them.
        for name in ["sed_file", "notebook_edit", "write_to_file", "replace_file_content", "multi_replace_file_content"] {
            assert_eq!(describe(name, &json!({"TargetFile":"C:/p/a.txt"})).kind, ToolKind::Edit, "{name}");
        }
        assert_eq!(describe("sed_file", &json!({"TargetFile":"C:/p/a.txt"})).target.as_deref(), Some("C:/p/a.txt"));
        for name in ["run_command", "send_command_input", "notebook_execution"] {
            assert_eq!(describe(name, &json!({"CommandLine":"npm test"})).kind, ToolKind::Command, "{name}");
        }
        assert_eq!(describe("send_command_input", &json!({"Input":"y"})).target, None, "not a command line of its own");
        for name in ["execute_browser_javascript", "click_browser_pixel", "browser_subagent", "open_browser_url"] {
            assert_eq!(describe(name, &json!({})).kind, ToolKind::Web, "{name}");
        }
        assert_eq!(describe("call_mcp_tool", &json!({"ServerName":"db","ToolName":"query"})).kind, ToolKind::Mcp);
    }

    #[test]
    fn edits_show_a_small_diff() {
        let tool = describe("Edit", &json!({"file_path":"C:\\p\\main.rs","old_string":"let a = 1;","new_string":"let a = 2;"}));
        assert_eq!(tool.summary, "แก้ไข main.rs");
        assert_eq!(tool.detail.as_deref(), Some("- let a = 1;\n+ let a = 2;"));
        let tool = describe("mcp__github__create_issue", &json!({"title":"x"}));
        assert_eq!(tool.summary, "ใช้ create_issue (github)");
        assert_eq!(describe("Bash", &json!({"command":["git","status"]})).target.as_deref(), Some("git status"));
    }

    #[test]
    fn questions_read_like_claude_code_asks_them() {
        let input = json!({"questions": [
            {"question": "Which framework?", "header": "Framework", "options": [{"label": "React", "description": "Component library"}, {"label": " "}, {"label": "Vue"}], "multiSelect": true},
            {"question": "  "}
        ]});
        let list = questions(&input).unwrap();
        assert_eq!(list.len(), 1, "an empty question is left out");
        assert_eq!(list[0].header, "Framework");
        assert!(list[0].multi_select);
        assert_eq!(list[0].options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), ["React", "Vue"]);
        assert_eq!(list[0].options[0].description, "Component library");
        assert!(questions(&json!({"command": "ls"})).is_none());

        let tool = describe("AskUserQuestion", &input);
        assert_eq!(tool.kind, ToolKind::Question);
        assert_eq!(tool.summary, "ถามคุณ: Which framework?");
        let plan = describe("ExitPlanMode", &json!({"plan": "# Plan\n1. Add login"}));
        assert_eq!(plan.summary, "ขออนุมัติแผนงาน");
        assert_eq!(plan.detail.as_deref(), Some("# Plan\n1. Add login"));
    }

    #[test]
    fn helpers() {
        assert_eq!(basename("C:\\a\\b\\c.txt"), "c.txt");
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(short("  hello   world \nnext", 20), "hello world");
        assert_eq!(short("abcdefghij", 5), "abcd…");
        assert_eq!(uri_to_path("file:///home/me/x%20y"), "/home/me/x y");
        assert_eq!(uri_to_path("C:\\plain"), "C:\\plain");
    }
}
