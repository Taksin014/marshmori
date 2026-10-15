// Ctrl+Alt+Y / Ctrl+Alt+N answer the front approval card from anywhere (questions
// need their own choices, so the keys pass them by).
// They are registered only while a card is waiting, so they never sit on those
// keys the rest of the time.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::approvals::Decision;
use crate::AppState;

static REGISTERED: AtomicBool = AtomicBool::new(false);

fn allow_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyY)
}

fn deny_key() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN)
}

fn answer_front(app: &AppHandle, decision: Decision) {
    let state = app.state::<AppState>();
    if let Some(id) = state.approvals.first_approval_id() {
        crate::pipeline::decide(app, id, decision);
    }
}

/// Registers or unregisters to match "a card is waiting and shortcuts are on".
pub fn sync(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(state) = handle.try_state::<AppState>() else { return };
        let want = state.settings.lock().unwrap().shortcuts && state.approvals.first_approval_id().is_some();
        if want == REGISTERED.load(Ordering::Relaxed) {
            return;
        }
        let gs = handle.global_shortcut();
        if want {
            let a = gs.on_shortcut(allow_key(), |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    answer_front(app, Decision::Allow);
                }
            });
            let d = gs.on_shortcut(deny_key(), |app, _shortcut, event| {
                if event.state() == ShortcutState::Pressed {
                    answer_front(app, Decision::Deny);
                }
            });
            if a.is_err() || d.is_err() {
                crate::log::line("Ctrl+Alt+Y / Ctrl+Alt+N are taken by another app");
            }
            REGISTERED.store(true, Ordering::Relaxed);
        } else {
            let _ = gs.unregister(allow_key());
            let _ = gs.unregister(deny_key());
            REGISTERED.store(false, Ordering::Relaxed);
        }
    });
}
