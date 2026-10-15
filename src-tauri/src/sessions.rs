// Every running agent session, what it is doing right now, and today's history.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;

use crate::agents::{basename, short, Agent, Event, Kind, ToolKind};
use crate::paths::now_ms;

const MAX_SESSIONS: usize = 30;
const MAX_HISTORY: usize = 300;
const HISTORY_TTL_MS: u64 = 24 * 3600 * 1000;
/// A finished or idle session disappears after this long without news.
const QUIET_TTL_MS: u64 = 45 * 60 * 1000;
/// A "working" session that went silent this long probably crashed.
const STALE_WORK_MS: u64 = 15 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Idle,
    Thinking,
    Working,
    Approval,
    Waiting,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub key: String,
    pub agent: Agent,
    pub agent_label: String,
    pub session_id: String,
    pub project: String,
    pub cwd: String,
    pub state: State,
    pub activity: String,
    pub detail: Option<String>,
    pub prompt: Option<String>,
    pub tool_count: u32,
    pub started_at: u64,
    pub updated_at: u64,
    pub state_since: u64,
    /// Mamori started this session itself: the id of its task (see tasks.rs).
    pub task: Option<String>,
    /// "Allow for this round" was pressed: everything this session asks is allowed
    /// until the user's next prompt (or the end of the turn).
    pub allow_all: bool,
    /// Where the agent's own prompts show up when it isn't a terminal: "VS Code",
    /// "แอป Claude"…
    pub surface: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: u64,
    pub at: u64,
    pub agent: Agent,
    pub agent_label: String,
    pub project: String,
    /// prompt | tool | approval | done | error | info
    pub kind: String,
    pub text: String,
}

pub fn project_name(cwd: &str) -> String {
    let name = basename(cwd);
    if name.is_empty() {
        "ไม่ทราบโฟลเดอร์".into()
    } else {
        name.to_string()
    }
}

#[derive(Default)]
pub struct Sessions {
    map: HashMap<String, Session>,
    history: VecDeque<HistoryItem>,
    next_history: u64,
}

impl Sessions {
    pub fn new() -> Self {
        Self::default()
    }

    fn set(session: &mut Session, state: State, activity: impl Into<String>, now: u64) {
        if session.state != state {
            session.state_since = now;
        }
        session.state = state;
        session.activity = activity.into();
    }

    /// Applies one hook event. Returns the history line it produced, if any.
    pub fn apply(&mut self, ev: &Event) -> Option<HistoryItem> {
        let key = ev.session_key();
        let now = now_ms();

        if ev.kind == Kind::SessionEnd {
            let removed = self.map.remove(&key)?;
            return Some(self.log(ev.agent, &removed.project, "info", "ปิด session แล้ว"));
        }

        if !self.map.contains_key(&key) && self.map.len() >= MAX_SESSIONS {
            if let Some(oldest) = self.map.values().min_by_key(|s| s.updated_at).map(|s| s.key.clone()) {
                self.map.remove(&oldest);
            }
        }
        let session = self.map.entry(key.clone()).or_insert_with(|| Session {
            key: key.clone(),
            agent: ev.agent,
            agent_label: ev.agent.label().to_string(),
            session_id: ev.session_id.clone(),
            project: project_name(&ev.cwd),
            cwd: ev.cwd.clone(),
            state: State::Idle,
            activity: "พร้อมทำงาน".into(),
            detail: None,
            prompt: None,
            tool_count: 0,
            started_at: now,
            updated_at: now,
            state_since: now,
            task: None,
            allow_all: false,
            surface: None,
        });
        if ev.task.is_some() && session.task != ev.task {
            session.task = ev.task.clone();
        }
        if let Some(entry) = ev.entry.as_deref().filter(|e| crate::gate::is_ide(e)) {
            session.surface = Some(crate::gate::surface_label(entry).to_string());
        }
        // A new prompt (or the end of the turn) ends "allow for this round". Antigravity
        // has no prompt event of its own (PreInvocation comes before every model call),
        // so for it the round ends when it stops.
        let new_round = match ev.kind {
            Kind::Prompt => ev.agent != Agent::Antigravity,
            Kind::Stop | Kind::StopFailure | Kind::Interrupt => true,
            _ => false,
        };
        if new_round {
            session.allow_all = false;
        }
        if !ev.cwd.is_empty() && session.cwd != ev.cwd {
            session.cwd = ev.cwd.clone();
            session.project = project_name(&ev.cwd);
        }
        session.updated_at = now;
        let project = session.project.clone();

        let mut line: Option<(&str, String)> = None;
        match ev.kind {
            Kind::SessionStart => {
                let resumed = matches!(ev.text.as_deref(), Some("resume") | Some("fork"));
                Self::set(session, State::Idle, if resumed { "กลับมาทำต่อ" } else { "พร้อมทำงาน" }, now);
                line = Some(("info", if resumed { "กลับมาทำ session เดิมต่อ".into() } else { "เริ่ม session ใหม่".into() }));
            }
            Kind::Prompt => {
                session.prompt = ev.text.clone();
                session.detail = None;
                let activity = match &ev.text {
                    Some(p) => format!("กำลังคิด: {}", short(p, 60)),
                    None => "กำลังคิด…".into(),
                };
                Self::set(session, State::Thinking, activity, now);
                line = Some(("prompt", ev.text.as_deref().map(|p| short(p, 90)).unwrap_or_else(|| "เริ่มงานใหม่".into())));
            }
            Kind::ToolStart => {
                session.tool_count += 1;
                if let Some(tool) = &ev.tool {
                    session.detail = tool.target.clone();
                    Self::set(session, State::Working, tool.summary.clone(), now);
                    if matches!(tool.kind, ToolKind::Command | ToolKind::Edit) {
                        line = Some(("tool", tool.summary.clone()));
                    }
                } else {
                    Self::set(session, State::Working, "กำลังทำงาน", now);
                }
            }
            Kind::ToolEnd => {
                if session.state != State::Working {
                    let activity = ev.tool.as_ref().map(|t| t.summary.clone()).unwrap_or_else(|| "กำลังทำงาน".into());
                    Self::set(session, State::Working, activity, now);
                }
            }
            Kind::ToolFailed => {
                let what = ev.tool.as_ref().map(|t| t.summary.clone()).unwrap_or_else(|| "เครื่องมือ".into());
                Self::set(session, State::Working, format!("ไม่สำเร็จ: {what}"), now);
            }
            Kind::Permission => {
                let what = ev.tool.as_ref().map(|t| t.summary.clone()).unwrap_or_else(|| "ใช้เครื่องมือ".into());
                session.detail = ev.tool.as_ref().and_then(|t| t.target.clone());
                Self::set(session, State::Approval, format!("รออนุมัติ: {what}"), now);
            }
            Kind::Notification => match ev.notification_type.as_deref() {
                Some("idle_prompt") | Some("agent_needs_input") | Some("elicitation_dialog") => {
                    Self::set(session, State::Waiting, "รอคำสั่งจากคุณ", now);
                }
                Some("permission_prompt") => {
                    if session.state != State::Approval {
                        let place = session.surface.clone().unwrap_or_else(|| "terminal".into());
                        Self::set(session, State::Approval, format!("รออนุมัติใน {place}"), now);
                    }
                }
                Some("agent_completed") => Self::set(session, State::Done, "เสร็จแล้ว", now),
                _ => {}
            },
            Kind::Stop => {
                session.detail = ev.text.as_deref().map(|t| short(t, 140));
                Self::set(session, State::Done, "เสร็จแล้ว", now);
                let text = match &ev.text {
                    Some(t) => format!("เสร็จแล้ว — {}", short(t, 80)),
                    None => "เสร็จแล้ว".into(),
                };
                line = Some(("done", text));
            }
            Kind::StopFailure => {
                let why = ev.text.as_deref().map(|t| short(t, 60)).unwrap_or_else(|| "ไม่ทราบสาเหตุ".into());
                Self::set(session, State::Error, format!("มีปัญหา: {why}"), now);
                line = Some(("error", format!("มีปัญหา: {why}")));
            }
            Kind::Interrupt => Self::set(session, State::Idle, "หยุดแล้ว", now),
            Kind::SubagentStart => Self::set(session, State::Working, "ผู้ช่วยเริ่มงาน", now),
            Kind::SubagentStop => {}
            Kind::Compact => Self::set(session, State::Thinking, "กำลังสรุปบทสนทนา", now),
            Kind::SessionEnd | Kind::Other => {}
        }
        let agent = ev.agent;
        line.map(|(kind, text)| self.log(agent, &project, kind, &text))
    }

    pub fn set_state(&mut self, key: &str, state: State, activity: impl Into<String>) {
        let now = now_ms();
        if let Some(session) = self.map.get_mut(key) {
            Self::set(session, state, activity, now);
            session.updated_at = now;
        }
    }

    pub fn remove(&mut self, key: &str) -> bool {
        self.map.remove(key).is_some()
    }

    /// "Allow for this round": on, or off again (true when it changed).
    pub fn set_allow_all(&mut self, key: &str, on: bool) -> bool {
        match self.map.get_mut(key) {
            Some(s) if s.allow_all != on => {
                s.allow_all = on;
                true
            }
            _ => false,
        }
    }

    pub fn allows_all(&self, key: &str) -> bool {
        self.map.get(key).map(|s| s.allow_all).unwrap_or(false)
    }

    pub fn get(&self, key: &str) -> Option<&Session> {
        self.map.get(key)
    }

    /// Newest first.
    pub fn snapshot(&self) -> Vec<Session> {
        let mut list: Vec<Session> = self.map.values().cloned().collect();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        list
    }

    /// Drops quiet sessions and old history. True when something changed.
    pub fn sweep(&mut self) -> bool {
        self.sweep_at(now_ms())
    }

    fn sweep_at(&mut self, now: u64) -> bool {
        let before = self.map.len();
        self.map.retain(|_, s| {
            let quiet = now.saturating_sub(s.updated_at);
            !(quiet > QUIET_TTL_MS && !matches!(s.state, State::Working | State::Thinking | State::Approval))
                && quiet < 3 * QUIET_TTL_MS
        });
        let mut changed = before != self.map.len();
        for s in self.map.values_mut() {
            let quiet = now.saturating_sub(s.updated_at);
            if quiet > STALE_WORK_MS && matches!(s.state, State::Working | State::Thinking | State::Approval) {
                s.state = State::Idle;
                s.state_since = now;
                s.activity = "เงียบไปนาน".into();
                changed = true;
            }
        }
        while self.history.front().map(|h| now.saturating_sub(h.at) > HISTORY_TTL_MS).unwrap_or(false) {
            self.history.pop_front();
        }
        changed
    }

    pub fn log(&mut self, agent: Agent, project: &str, kind: &str, text: &str) -> HistoryItem {
        if let Some(last) = self.history.back() {
            if last.agent == agent && last.project == project && last.kind == kind && last.text == text {
                return last.clone();
            }
        }
        self.next_history += 1;
        let item = HistoryItem {
            id: self.next_history,
            at: now_ms(),
            agent,
            agent_label: agent.label().to_string(),
            project: project.to_string(),
            kind: kind.to_string(),
            text: text.to_string(),
        };
        self.history.push_back(item.clone());
        while self.history.len() > MAX_HISTORY {
            self.history.pop_front();
        }
        item
    }

    /// Newest first.
    pub fn history(&self) -> Vec<HistoryItem> {
        self.history.iter().rev().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::normalize;
    use serde_json::json;

    fn ev(agent: Agent, name: &str, extra: serde_json::Value) -> Event {
        let mut p = json!({"hook_event_name": name, "session_id": "s1", "cwd": "C:\\work\\shop", "conversationId": "s1"});
        if let (Some(map), Some(more)) = (p.as_object_mut(), extra.as_object()) {
            for (k, v) in more {
                map.insert(k.clone(), v.clone());
            }
        }
        normalize(agent, name, &p)
    }

    #[test]
    fn a_turn_moves_through_the_states() {
        let mut s = Sessions::new();
        s.apply(&ev(Agent::Claude, "SessionStart", json!({"source": "startup"})));
        assert_eq!(s.snapshot()[0].state, State::Idle);
        assert_eq!(s.snapshot()[0].project, "shop");

        let line = s.apply(&ev(Agent::Claude, "UserPromptSubmit", json!({"prompt": "add a login page"}))).unwrap();
        assert_eq!(line.kind, "prompt");
        assert_eq!(s.snapshot()[0].state, State::Thinking);

        s.apply(&ev(Agent::Claude, "PreToolUse", json!({"tool_name": "Write", "tool_input": {"file_path": "C:\\work\\shop\\login.tsx", "content": "x"}})));
        let now = &s.snapshot()[0];
        assert_eq!(now.state, State::Working);
        assert_eq!(now.activity, "เขียน login.tsx");
        assert_eq!(now.tool_count, 1);

        s.apply(&ev(Agent::Claude, "PermissionRequest", json!({"tool_name": "Bash", "tool_input": {"command": "npm i"}})));
        assert_eq!(s.snapshot()[0].state, State::Approval);

        s.apply(&ev(Agent::Claude, "PostToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "npm i"}})));
        assert_eq!(s.snapshot()[0].state, State::Working);

        let line = s.apply(&ev(Agent::Claude, "Stop", json!({"last_assistant_message": "Done! Login page added."}))).unwrap();
        assert_eq!(line.kind, "done");
        assert_eq!(s.snapshot()[0].state, State::Done);

        s.apply(&ev(Agent::Claude, "SessionEnd", json!({"reason": "other"})));
        assert!(s.snapshot().is_empty());
        assert!(s.history().len() >= 4);
    }

    #[test]
    fn allow_for_this_round_ends_with_the_next_prompt() {
        let mut s = Sessions::new();
        s.apply(&ev(Agent::Claude, "UserPromptSubmit", json!({"prompt": "a", "marshmori_entry": "claude-vscode"})));
        let key = s.snapshot()[0].key.clone();
        assert_eq!(s.snapshot()[0].surface.as_deref(), Some("VS Code"));
        assert!(s.set_allow_all(&key, true));
        s.apply(&ev(Agent::Claude, "PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "npm i"}})));
        s.apply(&ev(Agent::Claude, "PostToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "npm i"}})));
        assert!(s.allows_all(&key), "still the same round");
        s.apply(&ev(Agent::Claude, "UserPromptSubmit", json!({"prompt": "next"})));
        assert!(!s.allows_all(&key), "the next prompt asks again");

        // Antigravity's PreInvocation comes before every model call: only Stop ends its round.
        s.apply(&ev(Agent::Antigravity, "PreInvocation", json!({})));
        let agy = s.snapshot().iter().find(|x| x.agent == Agent::Antigravity).unwrap().key.clone();
        s.set_allow_all(&agy, true);
        s.apply(&ev(Agent::Antigravity, "PreInvocation", json!({})));
        assert!(s.allows_all(&agy));
        s.apply(&ev(Agent::Antigravity, "Stop", json!({})));
        assert!(!s.allows_all(&agy));
    }

    #[test]
    fn sessions_of_different_agents_live_side_by_side() {
        let mut s = Sessions::new();
        s.apply(&ev(Agent::Claude, "UserPromptSubmit", json!({"prompt": "a"})));
        s.apply(&ev(Agent::Codex, "UserPromptSubmit", json!({"prompt": "b"})));
        s.apply(&ev(Agent::Antigravity, "PreInvocation", json!({})));
        assert_eq!(s.snapshot().len(), 3);
    }

    #[test]
    fn quiet_sessions_are_swept_and_stuck_work_is_reset() {
        let mut s = Sessions::new();
        s.apply(&ev(Agent::Codex, "Stop", json!({})));
        s.apply(&ev(Agent::Claude, "PreToolUse", json!({"tool_name": "Bash", "tool_input": {"command": "sleep 1"}})));
        let later = now_ms() + STALE_WORK_MS + 1000;
        assert!(s.sweep_at(later));
        assert_eq!(s.get("claude:s1").unwrap().state, State::Idle);
        let much_later = now_ms() + QUIET_TTL_MS + 1000;
        s.sweep_at(much_later);
        assert!(s.get("codex:s1").is_none());
    }

    #[test]
    fn repeated_history_lines_are_not_duplicated() {
        let mut s = Sessions::new();
        s.log(Agent::Claude, "p", "tool", "รัน ls");
        s.log(Agent::Claude, "p", "tool", "รัน ls");
        assert_eq!(s.history().len(), 1);
    }
}
