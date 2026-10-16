// What happens to one hook event, from the relay to the island and back.

use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::agents::{self, Agent, Event, Kind, Question, ToolKind};
use crate::approvals::{self, ApprovalView, Decision, Reply, Shape};
use crate::gate;
use crate::sessions::State;
use crate::{island, paths, roam, AppState};

/// How long the island has to confirm it is showing a card.
const ACK_TIMEOUT: Duration = Duration::from_millis(1500);

pub fn emit_sessions(app: &AppHandle) {
    let state = app.state::<AppState>();
    let list = state.sessions.lock().unwrap().snapshot();
    let _ = app.emit_to(island::LABEL, "sessions", list);
}

pub fn emit_approvals(app: &AppHandle) {
    let state = app.state::<AppState>();
    let list = state.approvals.snapshot();
    // Mamori, if it is out with a card, goes home once that card is answered.
    if state.roam.is_active() {
        let _ = app.emit_to(roam::LABEL, "approvals", list.clone());
    }
    let _ = app.emit_to(island::LABEL, "approvals", list);
}

fn emit_history(app: &AppHandle, item: crate::sessions::HistoryItem) {
    let _ = app.emit("history", item);
}

fn log(app: &AppHandle, ev: &Event, kind: &str, text: &str) {
    let state = app.state::<AppState>();
    let project = crate::sessions::project_name(&ev.cwd);
    let item = state.sessions.lock().unwrap().log(ev.agent, &project, kind, text);
    emit_history(app, item);
}

fn set_session(app: &AppHandle, key: &str, state_value: State, activity: impl Into<String>) {
    let state = app.state::<AppState>();
    state.sessions.lock().unwrap().set_state(key, state_value, activity);
    emit_sessions(app);
}

/// Handles one event; the returned text (if any) is printed by the relay for the agent.
pub fn handle_hook(app: &AppHandle, agent: &str, event: &str, body: &[u8]) -> Option<String> {
    let agent = Agent::parse(agent)?;
    let payload: Value = serde_json::from_slice(body).ok()?;
    let ev = agents::normalize(agent, event, &payload);
    // The hooks have this one: the transcript watcher (watch.rs) leaves it to them.
    {
        let state = app.state::<AppState>();
        let mut hooked = state.hooked.lock().unwrap();
        hooked.insert(ev.session_key(), paths::now_ms());
        if hooked.len() > 400 {
            let cutoff = paths::now_ms().saturating_sub(24 * 3600 * 1000);
            hooked.retain(|_, at| *at > cutoff);
        }
    }
    process(app, ev)
}

pub fn process(app: &AppHandle, ev: Event) -> Option<String> {
    let state = app.state::<AppState>();
    let agent = ev.agent;

    // Claude Code asks the user something (AskUserQuestion). Its answer can only go in
    // at PreToolUse; a PermissionRequest for it (the island didn't take it) is left to
    // Claude Code's own question, unless the island already answered that very call.
    let questions = (agent == Agent::Claude && ev.tool.as_ref().map(|t| t.kind == ToolKind::Question).unwrap_or(false))
        .then(|| agents::questions(&ev.input))
        .flatten();
    let asks_question = questions.is_some() && ev.name == "PreToolUse";

    // A task Mamori runs with Antigravity: agy skips its own permission check there
    // (tasks.rs), so the task's mode alone decides here what needs a card.
    let task_gate = match (&ev.task, agent, ev.kind) {
        (Some(task), Agent::Antigravity, Kind::ToolStart) if ev.name == "PreToolUse" => Some(antigravity_task_gate(app, task, &ev)),
        _ => None,
    };

    let needs_decision = match ev.kind {
        Kind::Permission if questions.is_some() => false,
        Kind::Permission => true,
        _ if task_gate.is_some() => task_gate == Some(gate::TaskGate::Ask),
        Kind::ToolStart if agent == Agent::Antigravity && ev.name == "PreToolUse" => {
            state.settings.lock().unwrap().antigravity_approvals && ev.tool.as_ref().map(|t| t.kind == ToolKind::Command).unwrap_or(false)
        }
        // Claude Code in an IDE's panel or in a background task: PermissionRequest never
        // comes, so ask here — when Claude Code would have asked (see gate.rs).
        Kind::ToolStart if gate::asks_at_pre_tool_use(&ev) => {
            let project = ev.project_dir.clone().unwrap_or_else(|| ev.cwd.clone());
            gate::claude_would_ask(&ev, &gate::Rules::load(&project))
        }
        _ => false,
    };

    // The agent moved on, so a card still open for it is stale: the whole session's
    // when the turn ends or a new one starts, just that call's when a tool ran.
    match ev.kind {
        Kind::ToolEnd | Kind::ToolFailed => state.approvals.cancel_tool(&ev.session_key(), ev.tool_use_id.as_deref()),
        Kind::Stop | Kind::StopFailure | Kind::Prompt | Kind::SessionEnd | Kind::Interrupt => {
            // Antigravity's "Prompt" is PreInvocation, which comes between its own steps.
            if !(agent == Agent::Antigravity && ev.kind == Kind::Prompt) {
                state.approvals.cancel_session(&ev.session_key());
            }
        }
        _ => {}
    }

    let line = state.sessions.lock().unwrap().apply(&ev);
    emit_sessions(app);
    if let Some(item) = line {
        emit_history(app, item);
    }
    if let Some(task) = &ev.task {
        crate::tasks::link(app, task, &ev.session_key());
    }
    if matches!(ev.kind, Kind::Stop | Kind::StopFailure) {
        crate::notify::session_finished(app, &ev);
    }

    if let (Some(list), true) = (questions.clone(), asks_question) {
        return question(app, ev, list);
    }
    if ev.kind == Kind::Permission && questions.is_some() {
        return state.approvals.recall_answer(ev.tool_use_id.as_deref()).map(|input| approvals::answer_permission_json(&input));
    }
    if task_gate == Some(gate::TaskGate::Refuse) {
        let what = ev.tool.as_ref().map(|t| t.summary.clone()).unwrap_or_default();
        log(app, &ev, "approval", &format!("ไม่อนุญาต (งานนี้ให้วางแผนอย่างเดียว): {what}"));
        return Some(approvals::antigravity_deny(PLAN_ONLY));
    }
    if needs_decision {
        return permission(app, ev);
    }
    // Antigravity wants a JSON object back for every event (at PreToolUse one with a
    // decision: `{}` there is a deny).
    (agent == Agent::Antigravity).then(|| approvals::antigravity_no_decision(&ev.name))
}

/// What agy reads when a plan-only task tries to change something.
const PLAN_ONLY: &str = "This task only plans (Marshmori): look around and write the plan, without changing files or running commands.";

/// The gate for one of an Antigravity task's tool calls (gate.rs), from the task's mode and
/// folder. A task Marshmori doesn't know (any more) gets the strictest mode that still works.
fn antigravity_task_gate(app: &AppHandle, task: &str, ev: &Event) -> gate::TaskGate {
    let (mode, folder) = crate::tasks::gate_of(app, task).unwrap_or((crate::tasks::Mode::Ask, String::new()));
    match &ev.tool {
        Some(tool) => gate::antigravity_task_gate(mode, tool, &[folder.as_str()]),
        None if mode == crate::tasks::Mode::Plan => gate::TaskGate::Refuse,
        None => gate::TaskGate::Ask,
    }
}

fn permission(app: &AppHandle, ev: Event) -> Option<String> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let key = ev.session_key();
    let shape = Shape::of(ev.agent, &ev.name);
    let tool = ev
        .tool
        .clone()
        .unwrap_or_else(|| agents::describe("unknown", &Value::Null));

    // Already answered at PreToolUse, and Claude Code asks again for the same call.
    if shape == Shape::PermissionRequest {
        if let Some(decision) = state.approvals.recall(ev.tool_use_id.as_deref()) {
            return approvals::response_json(shape, Some(decision));
        }
    }

    // "Allow for this round" is on for this session.
    if state.sessions.lock().unwrap().allows_all(&key) {
        set_session(app, &key, State::Working, tool.summary.clone());
        log(app, &ev, "approval", &format!("อนุญาตอัตโนมัติ (ทั้งรอบนี้): {}", tool.summary));
        state.approvals.remember(ev.tool_use_id.as_deref(), Decision::Allow);
        return approvals::response_json(shape, Some(Decision::Allow));
    }

    let (task_id, surface) = {
        let sessions = state.sessions.lock().unwrap();
        let s = sessions.get(&key);
        (ev.task.clone().or_else(|| s.and_then(|s| s.task.clone())), s.and_then(|s| s.surface.clone()))
    };
    let where_else = match ev.agent {
        Agent::Antigravity => "Antigravity".to_string(),
        _ => surface.unwrap_or_else(|| "terminal".into()),
    };
    // Mamori started this one in the background: the island is the only place to answer,
    // whatever the "ask at Mamori" setting says, and no answer means no.
    let background = task_id.is_some();
    // A plan-only task stays a plan: it doesn't get to switch to changing things.
    if background && tool.name == "ExitPlanMode" && task_id.as_deref().and_then(|id| crate::tasks::mode_of(app, id)) == Some(crate::tasks::Mode::Plan) {
        log(app, &ev, "approval", "แผนเสร็จแล้ว (งานนี้ให้วางแผนอย่างเดียว)");
        return approvals::response_json(shape, Some(Decision::Deny));
    }
    if background && !island::is_visible(app) {
        set_session(app, &key, State::Thinking, format!("ไม่ได้รับอนุญาต: {} (ซ่อนแถบไว้อยู่)", tool.summary));
        log(app, &ev, "approval", &format!("ไม่อนุญาต (ซ่อนแถบไว้อยู่): {}", tool.summary));
        return approvals::response_json(shape, Some(Decision::Deny));
    }
    if (!settings.approvals && !background) || !island::is_visible(app) {
        set_session(app, &key, State::Approval, format!("รออนุมัติใน {where_else}"));
        crate::notify::approval_elsewhere(app, &ev, &tool);
        return approvals::response_json(shape, None);
    }

    let now = paths::now_ms();
    let timeout = settings.approval_timeout;
    let elsewhere = match ev.agent {
        _ if background => None,
        Agent::Antigravity => Some("ให้ Antigravity ถามเอง".to_string()),
        _ => Some(format!("ตอบใน {where_else} แทน")),
    };
    let view = ApprovalView {
        id: state.approvals.next_id(),
        agent: ev.agent,
        agent_label: ev.agent.label().to_string(),
        session_key: key.clone(),
        project: crate::sessions::project_name(&ev.cwd),
        cwd: ev.cwd.clone(),
        tool: tool.name.clone(),
        tool_kind: tool.kind,
        title: tool.summary.clone(),
        target: tool.target.clone(),
        detail: tool.detail.clone(),
        always_label: approvals::always_label(ev.agent),
        elsewhere,
        created_at: now,
        expires_at: now + timeout * 1000,
        background,
        questions: None,
        tool_use_id: ev.tool_use_id.clone(),
    };
    set_session(app, &key, State::Approval, format!("รออนุมัติ: {}", tool.summary));

    let handle = app.clone();
    let decision = state
        .approvals
        .wait(view, ACK_TIMEOUT, Duration::from_secs(timeout), move || {
            emit_approvals(&handle);
            crate::shortcuts::sync(&handle);
        })
        .and_then(Reply::decision);
    if let Some(d) = decision {
        state.approvals.remember(ev.tool_use_id.as_deref(), d);
    }

    match decision {
        Some(Decision::Allow) => {
            set_session(app, &key, State::Working, tool.summary.clone());
            log(app, &ev, "approval", &format!("อนุญาต: {}", tool.summary));
        }
        Some(Decision::Always) => {
            state.sessions.lock().unwrap().set_allow_all(&key, true);
            set_session(app, &key, State::Working, tool.summary.clone());
            log(app, &ev, "approval", &format!("อนุญาตทั้งรอบนี้: {}", tool.summary));
            // Anything else this session is already asking about goes through too.
            state.approvals.decide_session(&key, Decision::Allow);
        }
        Some(Decision::Deny) => {
            set_session(app, &key, State::Thinking, format!("ไม่อนุญาต: {}", tool.summary));
            log(app, &ev, "approval", &format!("ไม่อนุญาต: {}", tool.summary));
        }
        Some(Decision::Terminal) | None if background => {
            // Nobody answered (or the card couldn't be shown): a background task has no
            // terminal to ask in instead, so it's a no.
            set_session(app, &key, State::Thinking, format!("ไม่ได้รับอนุญาต: {}", tool.summary));
            log(app, &ev, "approval", &format!("ไม่มีใครตอบ เลยไม่อนุญาต: {}", tool.summary));
            return approvals::response_json(shape, Some(Decision::Deny));
        }
        Some(Decision::Terminal) | None => {
            let still_there = state.sessions.lock().unwrap().get(&key).map(|s| s.state == State::Approval).unwrap_or(false);
            if still_there {
                set_session(app, &key, State::Approval, format!("รออนุมัติใน {where_else}"));
            }
        }
    }
    approvals::response_json(shape, decision)
}

/// Claude Code asks the user something: the island shows the question with its choices,
/// and the answer goes back in `updatedInput`, so Claude Code carries on right away.
/// No answer (or "answer there instead") prints nothing and Claude Code asks in its own
/// UI; a background task has nowhere else to ask, so it goes on without one.
fn question(app: &AppHandle, ev: Event, questions: Vec<Question>) -> Option<String> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let key = ev.session_key();
    let summary = ev.tool.as_ref().map(|t| t.summary.clone()).unwrap_or_else(|| "ถามคุณ".into());
    let (task_id, surface) = {
        let sessions = state.sessions.lock().unwrap();
        let s = sessions.get(&key);
        (ev.task.clone().or_else(|| s.and_then(|s| s.task.clone())), s.and_then(|s| s.surface.clone()))
    };
    let background = task_id.is_some();
    let where_else = surface.unwrap_or_else(|| "terminal".into());
    let skip = |why: &str| {
        set_session(app, &key, State::Thinking, format!("ข้ามคำถาม: {}", agents::short(&questions[0].question, 40)));
        log(app, &ev, "approval", &format!("{why}: {}", agents::short(&questions[0].question, 60)));
        Some(approvals::skip_question_json())
    };

    if !island::is_visible(app) || (!settings.approvals && !background) {
        if background {
            return skip("ข้ามคำถาม (ซ่อนแถบไว้อยู่)");
        }
        set_session(app, &key, State::Approval, format!("รอคุณตอบใน {where_else}"));
        crate::notify::question_elsewhere(app, &ev, &questions[0]);
        return None;
    }

    let now = paths::now_ms();
    let timeout = settings.approval_timeout;
    let view = ApprovalView {
        id: state.approvals.next_id(),
        agent: ev.agent,
        agent_label: ev.agent.label().to_string(),
        session_key: key.clone(),
        project: crate::sessions::project_name(&ev.cwd),
        cwd: ev.cwd.clone(),
        tool: ev.tool.as_ref().map(|t| t.name.clone()).unwrap_or_default(),
        tool_kind: ToolKind::Question,
        title: summary.clone(),
        target: None,
        detail: None,
        always_label: String::new(),
        elsewhere: (!background).then(|| format!("ตอบใน {where_else} แทน")),
        created_at: now,
        expires_at: now + timeout * 1000,
        background,
        questions: Some(questions.clone()),
        tool_use_id: ev.tool_use_id.clone(),
    };
    set_session(app, &key, State::Approval, summary);

    let handle = app.clone();
    let reply = state.approvals.wait(view, ACK_TIMEOUT, Duration::from_secs(timeout), move || {
        emit_approvals(&handle);
        crate::shortcuts::sync(&handle);
    });
    match reply {
        Some(Reply::Answers(answers)) => {
            let text = answers.values().filter_map(Value::as_str).collect::<Vec<_>>().join(" · ");
            set_session(app, &key, State::Working, format!("ได้คำตอบแล้ว: {}", agents::short(&text, 40)));
            log(app, &ev, "approval", &format!("ตอบคำถาม: {}", agents::short(&text, 80)));
            state.approvals.remember_answer(ev.tool_use_id.as_deref(), &ev.input, &answers);
            Some(approvals::answer_json(&ev.input, &answers))
        }
        Some(Reply::Decision(Decision::Deny)) => skip("ข้ามคำถาม"),
        _ if background => skip("ไม่มีใครตอบ เลยข้ามคำถาม"),
        _ => {
            let still_there = state.sessions.lock().unwrap().get(&key).map(|s| s.state == State::Approval).unwrap_or(false);
            if still_there {
                set_session(app, &key, State::Approval, format!("รอคุณตอบใน {where_else}"));
            }
            None
        }
    }
}

/// Answers a question card from the island (or Mamori out at the pointer).
pub fn answer(app: &AppHandle, id: u64, answers: approvals::Answers) -> bool {
    app.state::<AppState>().approvals.answer(id, answers)
}

/// Turns "allow for this round" off again for a session (from the island).
pub fn stop_allowing_all(app: &AppHandle, key: &str) -> bool {
    let changed = app.state::<AppState>().sessions.lock().unwrap().set_allow_all(key, false);
    if changed {
        emit_sessions(app);
    }
    changed
}

/// Answers a card from the island or a shortcut.
pub fn decide(app: &AppHandle, id: u64, decision: Decision) -> bool {
    app.state::<AppState>().approvals.decide(id, decision)
}

#[cfg(test)]
mod tests {
    use crate::agents::{normalize, Agent};
    use crate::approvals::{response_json, Decision, Shape};
    use serde_json::json;

    #[test]
    fn antigravity_permission_answers_are_objects() {
        let ev = normalize(Agent::Antigravity, "PreToolUse", &json!({"conversationId":"c","toolCall":{"name":"run_command","args":{"CommandLine":"ls"}}}));
        assert_eq!(ev.tool.as_ref().unwrap().kind, crate::agents::ToolKind::Command);
        assert_eq!(response_json(Shape::Antigravity, Some(Decision::Deny)).unwrap(), r#"{"decision":"deny","reason":"The user denied this action in Marshmori."}"#);
    }

    #[test]
    fn a_plan_only_antigravity_task_is_told_no_with_the_reason() {
        let v: serde_json::Value = serde_json::from_str(&crate::approvals::antigravity_deny(super::PLAN_ONLY)).unwrap();
        assert_eq!(v["decision"], "deny");
        assert!(v["reason"].as_str().unwrap().contains("only plans"), "agy shows the reason to the model, so it writes the plan instead");
    }

    #[test]
    fn antigravity_reads_go_through_without_a_card() {
        // view_file needs no card, and its answer must still carry a decision: agy 1.3.5
        // turned the old `{}` into "tool call denied by pre-tool hook".
        let ev = normalize(Agent::Antigravity, "PreToolUse", &json!({"conversationId":"c","toolCall":{"name":"view_file","args":{"AbsolutePath":"C:/p/package.json"}}}));
        assert_ne!(ev.tool.as_ref().unwrap().kind, crate::agents::ToolKind::Command);
        let answer: serde_json::Value = serde_json::from_str(&crate::approvals::antigravity_no_decision(&ev.name)).unwrap();
        assert_eq!(answer["decision"], "allow");
    }
}
