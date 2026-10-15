// "ดู Mamori ทำงาน": plays three fake sessions through the real pipeline, so you can
// see the island, the faces and an approval card without starting any agent.

use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::agents::{normalize, Agent};
use crate::pipeline;

fn step(app: &AppHandle, agent: Agent, event: &str, payload: Value, wait_ms: u64) {
    pipeline::process(app, normalize(agent, event, &payload));
    std::thread::sleep(Duration::from_millis(wait_ms));
}

pub fn run(app: &AppHandle) {
    let claude = app.clone();
    std::thread::spawn(move || {
        let base = |extra: Value| {
            let mut v = json!({"session_id": "demo-claude", "cwd": "C:\\demo\\shop"});
            if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) {
                m.extend(e.clone());
            }
            v
        };
        let a = Agent::Claude;
        step(&claude, a, "SessionStart", base(json!({"hook_event_name": "SessionStart", "source": "startup"})), 600);
        step(&claude, a, "UserPromptSubmit", base(json!({"hook_event_name": "UserPromptSubmit", "prompt": "เพิ่มหน้า login ให้หน่อย"})), 2200);
        step(&claude, a, "PreToolUse", base(json!({"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {"file_path": "C:\\demo\\shop\\src\\App.tsx"}})), 1600);
        step(&claude, a, "PreToolUse", base(json!({"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": {"file_path": "C:\\demo\\shop\\src\\Login.tsx", "content": "export function Login() {\n  return <form>…</form>;\n}"}})), 1800);
        // A real approval card: answer it in the island (nothing actually runs).
        step(&claude, a, "PermissionRequest", base(json!({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "npm install zod"}})), 600);
        step(&claude, a, "PostToolUse", base(json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": "npm install zod"}})), 1500);
        step(&claude, a, "Stop", base(json!({"hook_event_name": "Stop", "last_assistant_message": "เพิ่มหน้า login พร้อมตรวจข้อมูลด้วย zod แล้ว"})), 9000);
        step(&claude, a, "SessionEnd", base(json!({"hook_event_name": "SessionEnd", "reason": "other"})), 0);
    });

    let codex = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let base = |extra: Value| {
            let mut v = json!({"session_id": "demo-codex", "cwd": "C:\\demo\\api"});
            if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) {
                m.extend(e.clone());
            }
            v
        };
        let a = Agent::Codex;
        step(&codex, a, "UserPromptSubmit", base(json!({"hook_event_name": "UserPromptSubmit", "prompt": "เขียน test ให้ routes"})), 2600);
        step(&codex, a, "PreToolUse", base(json!({"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "tool_input": {"command": "*** Begin Patch\n*** Add File: tests/routes.test.ts\n+import { app } from '../src/app';\n*** End Patch"}})), 2400);
        step(&codex, a, "PreToolUse", base(json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "npm test"}})), 3200);
        step(&codex, a, "Stop", base(json!({"hook_event_name": "Stop", "last_assistant_message": "เพิ่ม test 6 ตัว ผ่านหมด"})), 12000);
        step(&codex, a, "SessionEnd", base(json!({"hook_event_name": "SessionEnd", "reason": "exit"})), 0);
    });

    let agy = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(3000));
        let base = json!({"conversationId": "demo-agy", "workspacePaths": ["C:\\demo\\landing"]});
        let with = |extra: Value| {
            let mut v = base.clone();
            if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) {
                m.extend(e.clone());
            }
            v
        };
        let a = Agent::Antigravity;
        step(&agy, a, "PreInvocation", with(json!({"invocationNum": 1})), 2400);
        step(&agy, a, "PreToolUse", with(json!({"toolCall": {"name": "view_file", "args": {"AbsolutePath": "C:\\demo\\landing\\index.html"}}})), 1800);
        step(&agy, a, "PreToolUse", with(json!({"toolCall": {"name": "replace_file_content", "args": {"TargetFile": "C:\\demo\\landing\\index.html", "TargetContent": "<h1>Hello</h1>", "ReplacementContent": "<h1>สวัสดี</h1>"}}})), 2200);
        step(&agy, a, "Stop", with(json!({"terminationReason": "completed", "fullyIdle": true})), 0);
    });
}
