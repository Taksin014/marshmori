// Permission prompts answered from the island — for all three agents.
//
// The server thread that received the hook blocks in `wait()` until the island
// answers, the user presses a shortcut, or time runs out. The island first has to
// acknowledge that it is actually showing the card; if it doesn't within a moment
// (hidden, busy), we give up at once and the agent asks in its own UI instead.
//
// A card can come from three kinds of hook, each answered in its own words (`Shape`):
// Claude Code's and Codex's PermissionRequest, Claude Code's PreToolUse (in an IDE's
// panel and in Mamori's own background tasks, where PermissionRequest never fires —
// see gate.rs), and Antigravity's PreToolUse.
//
// A card can also be a question (Claude Code's AskUserQuestion, asked at PreToolUse
// everywhere): it is answered with the chosen options (`Reply::Answers`), which go
// back to Claude Code in `updatedInput` (`answer_json`), never with a bare yes.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::agents::{Agent, Question, ToolKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Allow this, and everything else the same session asks until the user's next
    /// prompt (see `Sessions::grant`).
    Always,
    Deny,
    /// Let the agent ask in its own UI.
    Terminal,
}

impl Decision {
    pub fn parse(s: &str) -> Option<Decision> {
        match s {
            "allow" => Some(Decision::Allow),
            "always" => Some(Decision::Always),
            "deny" => Some(Decision::Deny),
            "terminal" | "skip" => Some(Decision::Terminal),
            _ => None,
        }
    }
}

/// Which hook is waiting for the answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// Claude Code's and Codex's PermissionRequest.
    PermissionRequest,
    /// Claude Code's PreToolUse, answered with permissionDecision.
    PreToolUse,
    /// Antigravity's PreToolUse: `{"decision": …}`.
    Antigravity,
}

impl Shape {
    pub fn of(agent: Agent, event_name: &str) -> Shape {
        match (agent, event_name) {
            (Agent::Antigravity, _) => Shape::Antigravity,
            (_, "PreToolUse") => Shape::PreToolUse,
            _ => Shape::PermissionRequest,
        }
    }
}

/// A question's answers: its text → the chosen label (several joined by ", "), or
/// what the user typed.
pub type Answers = serde_json::Map<String, serde_json::Value>;

#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Decision(Decision),
    Answers(Answers),
}

impl Reply {
    /// The yes/no of an approval card (a question card never gets one).
    pub fn decision(self) -> Option<Decision> {
        match self {
            Reply::Decision(d) => Some(d),
            Reply::Answers(_) => None,
        }
    }
}

enum Msg {
    Ack,
    Reply(Reply),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalView {
    pub id: u64,
    pub agent: Agent,
    pub agent_label: String,
    pub session_key: String,
    pub project: String,
    pub cwd: String,
    pub tool: String,
    pub tool_kind: ToolKind,
    pub title: String,
    pub target: Option<String>,
    pub detail: Option<String>,
    /// What "allow for this round" covers, for the button's tooltip.
    pub always_label: String,
    /// The link that hands the question back to the agent's own prompt ("ตอบใน VS Code
    /// แทน"). None for a background task: there is nowhere else to answer.
    pub elsewhere: Option<String>,
    pub created_at: u64,
    pub expires_at: u64,
    /// A task Mamori runs in the background: there is no terminal to answer in.
    pub background: bool,
    /// Set when the agent asks the user something (the card shows its choices instead
    /// of allow/deny).
    pub questions: Option<Vec<Question>>,
    /// The tool call the card is about (when the agent says), so the card goes away
    /// when that very call runs or fails, and not when another one does.
    #[serde(skip)]
    pub tool_use_id: Option<String>,
}

struct Pending {
    view: ApprovalView,
    tx: mpsc::Sender<Msg>,
}

/// How long an answer given at PreToolUse still answers that call's PermissionRequest.
const REMEMBER_FOR: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct Approvals {
    next: AtomicU64,
    pending: Mutex<Vec<Pending>>,
    /// Answers by tool call: if Claude Code still asks after PreToolUse said yes (some
    /// versions do), its PermissionRequest gets the same answer without a second card.
    answered: Mutex<VecDeque<(String, Decision, Instant)>>,
    /// Questions answered at PreToolUse, by tool call: the input with the answers in it.
    answered_questions: Mutex<VecDeque<(String, serde_json::Value, Instant)>>,
}

impl Approvals {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn next_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn snapshot(&self) -> Vec<ApprovalView> {
        self.pending.lock().unwrap().iter().map(|p| p.view.clone()).collect()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.lock().unwrap().is_empty()
    }

    pub fn first_id(&self) -> Option<u64> {
        self.pending.lock().unwrap().first().map(|p| p.view.id)
    }

    /// The first card a yes/no answers (the shortcuts skip questions).
    pub fn first_approval_id(&self) -> Option<u64> {
        self.pending.lock().unwrap().iter().find(|p| p.view.questions.is_none()).map(|p| p.view.id)
    }

    /// Shows `view` and blocks until it is answered. `changed` runs whenever the
    /// list of pending cards changes (to tell the island).
    pub fn wait(&self, view: ApprovalView, ack_timeout: Duration, timeout: Duration, changed: impl Fn()) -> Option<Reply> {
        let id = view.id;
        let question = view.questions.is_some();
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().push(Pending { view, tx });
        changed();

        let start = Instant::now();
        let deadline = start + timeout;
        let ack_deadline = start + ack_timeout;
        let mut acked = false;
        let result = loop {
            let limit = if acked { deadline } else { ack_deadline.min(deadline) };
            let now = Instant::now();
            if now >= limit {
                break None;
            }
            match rx.recv_timeout(limit - now) {
                Ok(Msg::Ack) => acked = true,
                // A yes can't answer a question ("allow for this round" passing by, a
                // shortcut): it waits for its choices.
                Ok(Msg::Reply(Reply::Decision(Decision::Allow | Decision::Always))) if question => {}
                Ok(Msg::Reply(r)) => break Some(r),
                Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => break None,
            }
        };

        self.pending.lock().unwrap().retain(|p| p.view.id != id);
        changed();
        result
    }

    fn send(&self, id: u64, msg: Msg) -> bool {
        let pending = self.pending.lock().unwrap();
        match pending.iter().find(|p| p.view.id == id) {
            Some(p) => p.tx.send(msg).is_ok(),
            None => false,
        }
    }

    pub fn ack(&self, id: u64) -> bool {
        self.send(id, Msg::Ack)
    }

    pub fn decide(&self, id: u64, decision: Decision) -> bool {
        self.send(id, Msg::Reply(Reply::Decision(decision)))
    }

    /// Answers a question card. Every one of its questions needs an answer, and only
    /// to questions it asked.
    pub fn answer(&self, id: u64, answers: Answers) -> bool {
        let pending = self.pending.lock().unwrap();
        let Some(p) = pending.iter().find(|p| p.view.id == id) else { return false };
        let Some(questions) = &p.view.questions else { return false };
        let complete = questions.iter().all(|q| answers.get(&q.question).and_then(|a| a.as_str()).map(|a| !a.trim().is_empty()).unwrap_or(false))
            && answers.keys().all(|k| questions.iter().any(|q| &q.question == k));
        complete && p.tx.send(Msg::Reply(Reply::Answers(answers))).is_ok()
    }

    /// The agent moved on (the turn ended, a new prompt came): drop its cards.
    pub fn cancel_session(&self, session_key: &str) {
        let pending = self.pending.lock().unwrap();
        for p in pending.iter().filter(|p| p.view.session_key == session_key) {
            let _ = p.tx.send(Msg::Reply(Reply::Decision(Decision::Terminal)));
        }
    }

    /// A tool ran or failed: drop the card about that call (it was answered in the
    /// agent's own prompt). Without an id, every card of the session goes.
    pub fn cancel_tool(&self, session_key: &str, tool_use_id: Option<&str>) {
        let Some(id) = tool_use_id else { return self.cancel_session(session_key) };
        let pending = self.pending.lock().unwrap();
        for p in pending.iter().filter(|p| p.view.session_key == session_key) {
            if p.view.tool_use_id.as_deref().map(|own| own == id).unwrap_or(true) {
                let _ = p.tx.send(Msg::Reply(Reply::Decision(Decision::Terminal)));
            }
        }
    }

    /// Answers every card of a session at once ("allow for this round").
    pub fn decide_session(&self, session_key: &str, decision: Decision) {
        let pending = self.pending.lock().unwrap();
        for p in pending.iter().filter(|p| p.view.session_key == session_key) {
            let _ = p.tx.send(Msg::Reply(Reply::Decision(decision)));
        }
    }

    pub fn remember(&self, tool_use_id: Option<&str>, decision: Decision) {
        let Some(id) = tool_use_id.filter(|id| !id.is_empty()) else { return };
        if !matches!(decision, Decision::Allow | Decision::Always | Decision::Deny) {
            return;
        }
        let mut list = self.answered.lock().unwrap();
        list.retain(|(_, _, at)| at.elapsed() < REMEMBER_FOR);
        list.push_back((id.to_string(), decision, Instant::now()));
        while list.len() > 200 {
            list.pop_front();
        }
    }

    pub fn remember_answer(&self, tool_use_id: Option<&str>, input: &serde_json::Value, answers: &Answers) {
        let Some(id) = tool_use_id.filter(|id| !id.is_empty()) else { return };
        let mut list = self.answered_questions.lock().unwrap();
        list.retain(|(_, _, at)| at.elapsed() < REMEMBER_FOR);
        list.push_back((id.to_string(), with_answers(input, answers), Instant::now()));
        while list.len() > 50 {
            list.pop_front();
        }
    }

    /// The answered input of a question already answered at PreToolUse.
    pub fn recall_answer(&self, tool_use_id: Option<&str>) -> Option<serde_json::Value> {
        let id = tool_use_id?;
        let list = self.answered_questions.lock().unwrap();
        list.iter().rev().find(|(own, _, at)| own == id && at.elapsed() < REMEMBER_FOR).map(|(_, v, _)| v.clone())
    }

    pub fn recall(&self, tool_use_id: Option<&str>) -> Option<Decision> {
        let id = tool_use_id?;
        let list = self.answered.lock().unwrap();
        list.iter().rev().find(|(own, _, at)| own == id && at.elapsed() < REMEMBER_FOR).map(|(_, d, _)| *d)
    }
}

const DENY_MESSAGE: &str = "The user denied this action in Marshmori.";
const ALLOW_REASON: &str = "Allowed in Marshmori.";

/// What the relay prints for the agent. `None` prints nothing, which every agent
/// reads as "no decision" and handles with its own prompt.
pub fn response_json(shape: Shape, decision: Option<Decision>) -> Option<String> {
    let allow = matches!(decision, Some(Decision::Allow) | Some(Decision::Always));
    let deny = decision == Some(Decision::Deny);
    match shape {
        Shape::PermissionRequest => {
            if allow {
                Some(serde_json::json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}).to_string())
            } else if deny {
                Some(
                    serde_json::json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "deny", "message": DENY_MESSAGE}}})
                        .to_string(),
                )
            } else {
                None
            }
        }
        // Never "ask": some versions of the VS Code extension take it as a yes.
        Shape::PreToolUse => {
            if allow {
                Some(
                    serde_json::json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": ALLOW_REASON}})
                        .to_string(),
                )
            } else if deny {
                Some(
                    serde_json::json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": DENY_MESSAGE}})
                        .to_string(),
                )
            } else {
                None
            }
        }
        Shape::Antigravity => Some(if allow {
            serde_json::json!({"decision": "allow"}).to_string()
        } else if deny {
            serde_json::json!({"decision": "deny", "reason": DENY_MESSAGE}).to_string()
        } else {
            "{}".to_string()
        }),
    }
}

const SKIP_REASON: &str = "The user skipped this question in Marshmori. Carry on with your best judgment, and say which choice you made.";
const ANSWER_REASON: &str = "Answered in Marshmori.";

/// The question's own input with the answers added: `updatedInput` replaces the whole
/// input, so everything else goes back as it came.
fn with_answers(input: &serde_json::Value, answers: &Answers) -> serde_json::Value {
    let mut updated = match input {
        serde_json::Value::Object(map) => map.clone(),
        _ => serde_json::Map::new(),
    };
    updated.insert("answers".into(), serde_json::Value::Object(answers.clone()));
    serde_json::Value::Object(updated)
}

/// Claude Code's AskUserQuestion, answered at PreToolUse.
pub fn answer_json(input: &serde_json::Value, answers: &Answers) -> String {
    serde_json::json!({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "permissionDecisionReason": ANSWER_REASON,
        "updatedInput": with_answers(input, answers),
    }})
    .to_string()
}

/// The same answers again, should Claude Code still bring up its prompt for that call.
pub fn answer_permission_json(updated_input: &serde_json::Value) -> String {
    serde_json::json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow", "updatedInput": updated_input}}}).to_string()
}

/// A question nobody can answer in a terminal (a background task): go on without it.
pub fn skip_question_json() -> String {
    serde_json::json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": SKIP_REASON}}).to_string()
}

/// The tooltip of "allow for this round".
pub fn always_label(agent: Agent) -> String {
    format!("อนุญาตทุกอย่างที่ {} ขอในรอบนี้ — สั่งงานครั้งถัดไปจะกลับมาถามใหม่", agent.label())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn view(id: u64) -> ApprovalView {
        ApprovalView {
            id,
            agent: Agent::Codex,
            agent_label: "Codex".into(),
            session_key: "codex:s".into(),
            project: "p".into(),
            cwd: "/p".into(),
            tool: "Bash".into(),
            tool_kind: ToolKind::Command,
            title: "t".into(),
            target: None,
            detail: None,
            always_label: String::new(),
            elsewhere: None,
            created_at: 0,
            expires_at: 0,
            background: false,
            questions: None,
            tool_use_id: None,
        }
    }

    #[test]
    fn the_documented_output_shapes() {
        assert_eq!(
            response_json(Shape::PermissionRequest, Some(Decision::Allow)).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert!(response_json(Shape::PermissionRequest, Some(Decision::Deny)).unwrap().contains(r#""behavior":"deny""#));
        assert!(response_json(Shape::PermissionRequest, None).is_none());
        assert!(response_json(Shape::PermissionRequest, Some(Decision::Terminal)).is_none());
        let pre: serde_json::Value = serde_json::from_str(&response_json(Shape::PreToolUse, Some(Decision::Always)).unwrap()).unwrap();
        assert_eq!(pre["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(pre["hookSpecificOutput"]["permissionDecision"], "allow");
        let pre: serde_json::Value = serde_json::from_str(&response_json(Shape::PreToolUse, Some(Decision::Deny)).unwrap()).unwrap();
        assert_eq!(pre["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(response_json(Shape::PreToolUse, None).is_none(), "no answer: the IDE asks as usual (never 'ask')");
        assert_eq!(response_json(Shape::Antigravity, Some(Decision::Always)).unwrap(), r#"{"decision":"allow"}"#);
        assert_eq!(response_json(Shape::Antigravity, None).unwrap(), "{}");
        assert_eq!(Shape::of(Agent::Claude, "PreToolUse"), Shape::PreToolUse);
        assert_eq!(Shape::of(Agent::Codex, "PermissionRequest"), Shape::PermissionRequest);
        assert_eq!(Shape::of(Agent::Antigravity, "PreToolUse"), Shape::Antigravity);
    }

    #[test]
    fn an_unacknowledged_card_gives_up_fast() {
        let a = Approvals::new();
        let t = Instant::now();
        let d = a.wait(view(1), Duration::from_millis(50), Duration::from_secs(30), || {});
        assert!(d.is_none());
        assert!(t.elapsed() < Duration::from_secs(2));
        assert!(a.is_empty());
    }

    #[test]
    fn an_answer_reaches_the_waiting_thread() {
        let a = Arc::new(Approvals::new());
        let a2 = a.clone();
        let waiter = std::thread::spawn(move || a2.wait(view(7), Duration::from_secs(2), Duration::from_secs(5), || {}));
        while a.first_id().is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(a.ack(7));
        assert!(a.decide(7, Decision::Deny));
        assert_eq!(waiter.join().unwrap(), Some(Reply::Decision(Decision::Deny)));
        assert!(!a.decide(7, Decision::Allow), "a finished card can't be answered twice");
    }

    #[test]
    fn another_tool_finishing_leaves_the_card_alone() {
        let a = Arc::new(Approvals::new());
        let a2 = a.clone();
        let mut v = view(9);
        v.tool_use_id = Some("toolu_bash".into());
        let waiter = std::thread::spawn(move || a2.wait(v, Duration::from_secs(5), Duration::from_secs(5), || {}));
        while a.first_id().is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        a.ack(9);
        a.cancel_tool("codex:s", Some("toolu_read"));
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(a.first_id(), Some(9), "a Read running alongside doesn't take the card away");
        a.cancel_tool("codex:s", Some("toolu_bash"));
        assert_eq!(waiter.join().unwrap(), Some(Reply::Decision(Decision::Terminal)));
    }

    fn ask(id: u64) -> ApprovalView {
        let mut v = view(id);
        v.tool_kind = ToolKind::Question;
        v.questions = crate::agents::questions(&serde_json::json!({"questions": [
            {"question": "Which framework?", "header": "Framework", "options": [{"label": "React", "description": "Component library"}, {"label": "Vue"}], "multiSelect": false},
            {"question": "Which extras?", "header": "Extras", "options": [{"label": "Tests"}, {"label": "Docs"}], "multiSelect": true}
        ]}));
        v
    }

    fn answers(pairs: &[(&str, &str)]) -> Answers {
        pairs.iter().map(|(q, a)| (q.to_string(), serde_json::Value::String(a.to_string()))).collect()
    }

    #[test]
    fn a_question_is_answered_with_its_choices_and_never_a_bare_yes() {
        let a = Arc::new(Approvals::new());
        let a2 = a.clone();
        let waiter = std::thread::spawn(move || a2.wait(ask(3), Duration::from_secs(2), Duration::from_secs(5), || {}));
        while a.first_id().is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
        a.ack(3);
        assert_eq!(a.first_approval_id(), None, "the shortcuts leave questions alone");
        assert!(!a.answer(3, answers(&[("Which framework?", "React")])), "every question needs an answer");
        assert!(!a.answer(3, answers(&[("Which framework?", "React"), ("Which extras?", "Tests"), ("Made up?", "x")])));
        // "Allow for this round" passing by doesn't answer it.
        a.decide_session("codex:s", Decision::Allow);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(a.first_id(), Some(3));
        let given = answers(&[("Which framework?", "React"), ("Which extras?", "Tests, Docs")]);
        assert!(a.answer(3, given.clone()));
        assert_eq!(waiter.join().unwrap(), Some(Reply::Answers(given)));
        assert!(!view(4).questions.is_some());
    }

    #[test]
    fn answers_go_back_in_updated_input_with_the_original_input() {
        let input = serde_json::json!({"questions": [{"question": "Which framework?", "header": "Framework", "options": [{"label": "React", "description": "Component library"}], "multiSelect": false}]});
        let out: serde_json::Value = serde_json::from_str(&answer_json(&input, &answers(&[("Which framework?", "React")]))).unwrap();
        let o = &out["hookSpecificOutput"];
        assert_eq!(o["hookEventName"], "PreToolUse");
        assert_eq!(o["permissionDecision"], "allow");
        assert_eq!(o["updatedInput"]["questions"], input["questions"], "the questions go back as they came");
        assert_eq!(o["updatedInput"]["answers"]["Which framework?"], "React");
        let skip: serde_json::Value = serde_json::from_str(&skip_question_json()).unwrap();
        assert_eq!(skip["hookSpecificOutput"]["permissionDecision"], "deny");

        let a = Approvals::new();
        a.remember_answer(Some("toolu_q"), &input, &answers(&[("Which framework?", "React")]));
        let again: serde_json::Value = serde_json::from_str(&answer_permission_json(&a.recall_answer(Some("toolu_q")).unwrap())).unwrap();
        assert_eq!(again["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert_eq!(again["hookSpecificOutput"]["decision"]["updatedInput"]["answers"]["Which framework?"], "React");
        assert!(a.recall_answer(Some("toolu_other")).is_none());
    }

    #[test]
    fn an_answer_is_remembered_for_the_same_call() {
        let a = Approvals::new();
        a.remember(Some("toolu_1"), Decision::Allow);
        a.remember(Some("toolu_2"), Decision::Terminal);
        assert_eq!(a.recall(Some("toolu_1")), Some(Decision::Allow));
        assert_eq!(a.recall(Some("toolu_2")), None);
        assert_eq!(a.recall(None), None);
    }
}
