// The island window: a borderless, transparent, always-on-top window at the top
// centre of the screen. It never changes size; the island inside it does. A poll
// thread reads the cursor ~30 times a second and makes the window click-through
// everywhere except over the island itself, so the rest of the window never
// swallows a click meant for whatever is underneath. The same thread looks after
// the roam overlay while Mamori is out on the screen (roam.rs).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::{platform, roam};

pub const LABEL: &str = "island";
/// Logical size of the window: room for the biggest view (the open island with its
/// side column, or the chat).
pub const WIDTH: f64 = 720.0;
pub const HEIGHT: f64 = 600.0;
/// Margin around the island that still counts as "on the island".
const HIT_MARGIN: f64 = 10.0;
/// How close a dragged file has to come before the island opens up for it.
const DRAG_MARGIN: f64 = 70.0;

#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64, margin: f64) -> bool {
        self.w > 0.0 && x >= self.x - margin && x <= self.x + self.w + margin && y >= self.y - margin && y <= self.y + self.h + margin
    }
}

#[derive(Clone, Serialize)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
    pub inside: bool,
}

#[derive(Default)]
pub struct IslandState {
    rects: Mutex<Vec<Rect>>,
    ignoring: AtomicBool,
    /// Hidden from the tray menu.
    pub user_hidden: AtomicBool,
    /// Hidden because a fullscreen app is in front.
    pub fullscreen_hidden: AtomicBool,
    /// The chat box has the keyboard: take the mouse everywhere on the island.
    pub interactive: AtomicBool,
}

impl IslandState {
    pub fn set_rects(&self, rects: Vec<Rect>) {
        *self.rects.lock().unwrap() = rects;
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn state(app: &AppHandle) -> Option<Arc<IslandState>> {
    app.try_state::<crate::AppState>().map(|s| s.island.clone())
}

/// Visible and able to show an approval card right now.
pub fn is_visible(app: &AppHandle) -> bool {
    let Some(st) = state(app) else { return false };
    if st.user_hidden.load(Ordering::Relaxed) || st.fullscreen_hidden.load(Ordering::Relaxed) {
        return false;
    }
    window(app).and_then(|w| w.is_visible().ok()).unwrap_or(false)
}

/// Puts the Alt-Tab exclusion back once tao has finished rewriting the window's
/// styles. Queued on the main thread behind the call that changed them.
pub fn restyle_soon(app: &AppHandle, label: &'static str) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(w) = handle.get_webview_window(label) {
            platform::keep_out_of_alt_tab(&w);
        }
    });
}

pub fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64 && x < p.x as f64 + s.width as f64 && y >= p.y as f64 && y < p.y as f64 + s.height as f64
}

fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    if pref == "cursor" {
        if let (Ok(cursor), Ok(monitors)) = (app.cursor_position(), app.available_monitors()) {
            if let Some(m) = monitors.into_iter().find(|m| monitor_contains(m, cursor.x, cursor.y)) {
                return Some(m);
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| app.available_monitors().ok().and_then(|m| m.into_iter().next()))
}

fn monitor_key(app: &AppHandle, pref: &str) -> Option<(i32, i32, u32, u32, u64)> {
    let m = target_monitor(app, pref)?;
    Some((m.position().x, m.position().y, m.size().width, m.size().height, m.scale_factor().to_bits()))
}

/// Top centre of the chosen display.
pub fn place(app: &AppHandle, pref: &str) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };
    let scale = m.scale_factor();
    let pw = (WIDTH * scale).round() as u32;
    let ph = (HEIGHT * scale).round() as u32;
    let x = m.position().x + (m.size().width as i32 - pw as i32) / 2;
    let y = m.position().y;
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // Moving across displays can rescale the window: say the size again.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_always_on_top(true);
    restyle_soon(app, LABEL);
}

fn apply_visibility(app: &AppHandle) {
    let (Some(win), Some(st)) = (window(app), state(app)) else { return };
    let hidden = st.user_hidden.load(Ordering::Relaxed) || st.fullscreen_hidden.load(Ordering::Relaxed);
    if hidden {
        // Mamori can't be out on the screen while its home is hidden.
        roam::abort(app);
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        // Take the mouse again; the next poll tick decides from the cursor.
        st.ignoring.store(false, Ordering::Relaxed);
        let _ = win.set_ignore_cursor_events(false);
    }
    restyle_soon(app, LABEL);
    let _ = app.emit_to(LABEL, "island-visible", !hidden);
}

pub fn set_user_hidden(app: &AppHandle, hidden: bool) {
    if let Some(st) = state(app) {
        st.user_hidden.store(hidden, Ordering::Relaxed);
        apply_visibility(app);
    }
}

pub fn toggle(app: &AppHandle) {
    if let Some(st) = state(app) {
        let hidden = !st.user_hidden.load(Ordering::Relaxed);
        set_user_hidden(app, hidden);
    }
}

/// The chat box needs the keyboard: let the island be focused while it is open.
/// Lets the island take the keyboard (chat, tasks) or gives it back. `focus` brings the
/// keyboard here at once; without it the island only becomes clickable, so a page that
/// comes back by itself (after an approval card) doesn't pull you out of your editor.
pub fn set_interactive(app: &AppHandle, on: bool, focus: bool) {
    let (Some(win), Some(st)) = (window(app), state(app)) else { return };
    st.interactive.store(on, Ordering::Relaxed);
    let _ = win.set_focusable(on);
    if on {
        st.ignoring.store(false, Ordering::Relaxed);
        let _ = win.set_ignore_cursor_events(false);
        if focus {
            let _ = win.set_focus();
        }
    }
    restyle_soon(app, LABEL);
}

/// Styles the window once it exists.
pub fn setup(app: &AppHandle, pref: &str) {
    if let Some(win) = window(app) {
        place(app, pref);
        let _ = win.show();
        restyle_soon(app, LABEL);
    }
}

pub fn spawn_poller(app: AppHandle, st: Arc<IslandState>) {
    std::thread::Builder::new()
        .name("marshmori-island".into())
        .spawn(move || {
            let mut last: (f64, f64, bool) = (f64::NAN, f64::NAN, false);
            let mut tick: u64 = 0;
            let mut front: isize = 0;
            let mut was_down = false;
            let mut screen: Option<(i32, i32, u32, u32, u64)> = None;
            loop {
                tick = tick.wrapping_add(1);
                let (pref, hide_fullscreen) = app
                    .try_state::<crate::AppState>()
                    .map(|s| {
                        let s = s.settings.lock().unwrap();
                        (s.screen.clone(), s.hide_in_fullscreen)
                    })
                    .unwrap_or_else(|| ("primary".into(), true));
                let user_hidden = st.user_hidden.load(Ordering::Relaxed);

                // Several times a second: stay above whatever just came to the front.
                // Other always-on-top windows (and some apps when they open) can slide
                // over the island; it puts itself back on top without taking focus.
                if tick % 8 == 0 && !user_hidden && !st.fullscreen_hidden.load(Ordering::Relaxed) {
                    let now_front = platform::foreground_id();
                    if now_front != front || tick % 90 == 0 {
                        front = now_front;
                        if let Some(win) = window(&app) {
                            platform::raise_topmost(&win);
                        }
                        if let Some(win) = roam::window(&app).filter(|_| roam::is_active(&app)) {
                            platform::raise_topmost(&win);
                        }
                    }
                }

                // About once a second: fullscreen apps and display changes.
                let slow_tick = tick % 30 == 0;
                if slow_tick {
                    if let Some(win) = window(&app) {
                        let fullscreen = hide_fullscreen && platform::foreground_is_fullscreen(&win);
                        if fullscreen != st.fullscreen_hidden.load(Ordering::Relaxed) {
                            st.fullscreen_hidden.store(fullscreen, Ordering::Relaxed);
                            apply_visibility(&app);
                        }
                    }
                    if tick % 60 == 0 {
                        let key = monitor_key(&app, &pref);
                        if key.is_some() && key != screen {
                            if screen.is_some() {
                                crate::log::line("display layout changed — moving the island");
                                roam::abort(&app);
                            }
                            screen = key;
                            place(&app, &pref);
                        }
                    }
                }

                let hidden = user_hidden || st.fullscreen_hidden.load(Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(33));
                if hidden {
                    continue;
                }

                let Ok(cursor) = app.cursor_position() else { continue };
                // Mamori out on the screen: its overlay has its own click-through.
                roam::poll(&app, cursor);

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                let scale = win.scale_factor().unwrap_or(1.0);
                let x = (cursor.x - origin.x as f64) / scale;
                let y = (cursor.y - origin.y as f64) / scale;

                let (inside, near) = {
                    let rects = st.rects.lock().unwrap();
                    let within = |margin: f64| rects.iter().any(|r| r.contains(x, y, margin));
                    (within(HIT_MARGIN), within(DRAG_MARGIN))
                };

                // A file being dragged has to be able to find us. Click-through hides
                // the window from Windows' drop-target search, so while the button is
                // held near the island, the window takes the mouse.
                let down = platform::left_button_down();
                if down && !was_down {
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Some(w) = window(&handle) {
                            platform::unblock_webview_drops(&w);
                        }
                    });
                }
                was_down = down;
                let accept = inside || (down && near);
                if st.ignoring.load(Ordering::Relaxed) == accept {
                    st.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                    restyle_soon(&app, LABEL);
                }

                // Written so the NaN start value counts as "moved" (a NaN comparison is false).
                // Repeated about once a second anyway, so a page that (re)loads learns
                // where the pointer is without waiting for it to move.
                let moved = !((x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 && inside == last.2);
                if moved || tick % 30 == 15 {
                    last = (x, y, inside);
                    let _ = app.emit_to(LABEL, "cursor", CursorPayload { x, y, inside });
                }
            }
        })
        .expect("island poll thread");
}
