// Windows notifications, only for when Mamori can't be seen (a fullscreen app, or the
// island hidden from the tray) or when approvals are left to the agent's own UI.

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::agents::{Event, Kind, Tool};
use crate::{island, AppState};

fn enabled(app: &AppHandle) -> bool {
    app.try_state::<AppState>().map(|s| s.settings.lock().unwrap().toasts).unwrap_or(false)
}

fn show(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// After the rename from AIMoji: the agents' hooks were moved to Marshmori's relay.
/// Codex asks you to trust changed hooks again, so say so (this one is always shown).
pub fn hooks_moved(app: &AppHandle, agents: &[crate::agents::Agent]) {
    let names: Vec<&str> = agents.iter().map(|a| a.label()).collect();
    let codex = agents.contains(&crate::agents::Agent::Codex);
    let body = if codex {
        format!("ย้าย hooks ของ {} มาใช้ Marshmori แล้ว — เปิด Codex แล้วพิมพ์ /hooks เพื่อกด Trust อีกครั้ง", names.join(", "))
    } else {
        format!("ย้าย hooks ของ {} มาใช้ Marshmori แล้ว ใช้ได้ทันที", names.join(", "))
    };
    show(app, "AIMoji เปลี่ยนชื่อเป็น Marshmori", &body);
}

/// A new version changed how our hooks are written (0.5: Claude Code's PreToolUse
/// waits for the island in an IDE). Sessions started before keep the old ones.
pub fn hooks_updated(app: &AppHandle, agents: &[crate::agents::Agent]) {
    let names: Vec<&str> = agents.iter().map(|a| a.label()).collect();
    show(
        app,
        "อัปเดตการเชื่อมต่อแล้ว",
        &format!("{} ใช้การเชื่อมต่อแบบใหม่แล้ว — เปิด session ใหม่เพื่อให้กดอนุญาตจาก Mamori ได้ทุกที่ รวมถึงใน VS Code", names.join(", ")),
    );
}

/// Agents found on this computer were connected when Marshmori started.
pub fn hooks_connected(app: &AppHandle, agents: &[crate::agents::Agent]) {
    let names: Vec<&str> = agents.iter().map(|a| a.label()).collect();
    let codex = agents.contains(&crate::agents::Agent::Codex);
    show(
        app,
        "เชื่อมต่อให้แล้ว",
        &format!(
            "{} — งานที่รันใน terminal หรือ IDE จะขึ้นที่ Mamori เอง (เปิด session ใหม่หนึ่งครั้ง{})",
            names.join(", "),
            if codex { ", Codex พิมพ์ /hooks แล้วกด Trust" } else { "" }
        ),
    );
}

pub fn approval_elsewhere(app: &AppHandle, ev: &Event, tool: &Tool) {
    if !enabled(app) {
        return;
    }
    let project = crate::sessions::project_name(&ev.cwd);
    show(
        app,
        &format!("{} ขออนุมัติ", ev.agent.label()),
        &format!("{} · {project}", tool.summary),
    );
}

pub fn session_finished(app: &AppHandle, ev: &Event) {
    if !enabled(app) || island::is_visible(app) {
        return;
    }
    let project = crate::sessions::project_name(&ev.cwd);
    let (title, body) = match ev.kind {
        Kind::StopFailure => (
            format!("{} มีปัญหา", ev.agent.label()),
            ev.text.as_deref().map(|t| crate::agents::short(t, 90)).unwrap_or_else(|| project.clone()),
        ),
        _ => (
            format!("{} ทำงานเสร็จแล้ว", ev.agent.label()),
            ev.text.as_deref().map(|t| crate::agents::short(t, 90)).unwrap_or_else(|| project.clone()),
        ),
    };
    show(app, &title, &body);
}
