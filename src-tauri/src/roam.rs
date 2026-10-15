// Mamori's long neck.
//
// When an agent needs you (or has finished, or hit a problem) Mamori keeps hold of
// the island's edge and stretches its neck across the screen until its head is next
// to the mouse pointer. That happens in a second window: a transparent, always-on-top
// overlay over the display the island is on. It only exists while it is useful. It is
// created the first time Mamori reaches out, shown only during a reach, click-through
// everywhere except over Mamori's head and its bubble, hidden as soon as the head is
// back on the island, and closed after a few quiet minutes so it holds no memory
// while unused.
//
// Creating and closing the overlay, and the "page loaded" handshake, all happen on one
// worker thread fed by a channel, so they never race each other and the main thread
// never waits on a lock of ours.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::island::{self, CursorPayload, Rect};
use crate::{log, platform, AppState};

pub const LABEL: &str = "roam";
/// A quiet overlay is closed after this long, to give its memory back.
const CLOSE_AFTER: Duration = Duration::from_secs(300);
/// Margin around Mamori and the bubble that still takes the mouse.
const HIT_MARGIN: f64 = 6.0;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// What Mamori reaches out to say. Built by the island, shown in the bubble.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoamRequest {
    /// "approval", "done" or "error".
    pub kind: String,
    pub title: String,
    pub text: String,
    /// The text is a command or code: shown in a monospace box.
    #[serde(default)]
    pub code: bool,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub approval_id: Option<u64>,
    /// For approvals: when the card appeared and when it gives up (ms since epoch).
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub expires_at: Option<u64>,
    /// What Mamori reaches out with: "head" (on its long neck) or "hand" (a long arm
    /// that taps the pointer).
    #[serde(default)]
    pub reach: Option<String>,
}

/// Sent to the overlay page: everything in the overlay's own CSS pixels.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Go {
    trip: u64,
    request: RoamRequest,
    /// Centre of Mamori's head in the island, where the trip starts and ends.
    nest: Point,
    /// Pixels per head unit in the island.
    nest_scale: f64,
    cursor: Point,
    /// The overlay's size in CSS pixels (a page that hasn't been shown yet may not
    /// know its own size).
    screen: Point,
    color: String,
    /// The island's look, so the bubble matches it.
    look: String,
    sound: bool,
    volume: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NestPayload {
    nest: Point,
    nest_scale: f64,
}

/// Where the overlay sits: the physical top-left of its display and that display's
/// scale, to turn screen pixels into the page's CSS pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    pub scale: f64,
}

impl Frame {
    pub fn local(&self, px: f64, py: f64) -> Point {
        Point { x: (px - self.x as f64) / self.scale, y: (py - self.y as f64) / self.scale }
    }

    /// Converts a point in another window's CSS pixels (origin and scale of that window).
    pub fn from_window(&self, origin: PhysicalPosition<i32>, scale: f64, p: Point) -> Point {
        self.local(origin.x as f64 + p.x * scale, origin.y as f64 + p.y * scale)
    }
}

enum Msg {
    Start { go: Go, frame: Frame, reply: Sender<bool> },
    Ready,
    Shown { trip: u64 },
    Done { trip: u64 },
    Abort,
}

#[derive(Default)]
pub struct RoamState {
    tx: Mutex<Option<Sender<Msg>>>,
    rects: Mutex<Vec<Rect>>,
    frame: Mutex<Option<Frame>>,
    ignoring: AtomicBool,
    /// Mamori is out (or about to be).
    active: AtomicBool,
    trip: AtomicU64,
    last_cursor: Mutex<(f64, f64, bool)>,
}

impl RoamState {
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    fn send(&self, msg: Msg) -> bool {
        match self.tx.lock().unwrap().as_ref() {
            Some(tx) => tx.send(msg).is_ok(),
            None => false,
        }
    }
}

fn roam_state(app: &AppHandle) -> Option<Arc<RoamState>> {
    app.try_state::<AppState>().map(|s| s.roam.clone())
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

// ── The worker ──────────────────────────────────────────────────────────────────

pub fn spawn_worker(app: AppHandle, st: Arc<RoamState>) {
    let (tx, rx) = mpsc::channel();
    *st.tx.lock().unwrap() = Some(tx);
    std::thread::Builder::new()
        .name("marshmori-roam".into())
        .spawn(move || worker(app, st, rx))
        .expect("roam thread");
}

fn worker(app: AppHandle, st: Arc<RoamState>, rx: Receiver<Msg>) {
    let mut loaded = false;
    let mut pending: Option<Go> = None;
    let mut idle_since: Option<Instant> = None;
    let mut trip: u64 = 0;

    loop {
        let wait = match idle_since {
            Some(t) => CLOSE_AFTER.saturating_sub(t.elapsed()).max(Duration::from_millis(10)),
            None => Duration::from_secs(3600),
        };
        match rx.recv_timeout(wait) {
            Ok(Msg::Start { mut go, frame, reply }) => {
                let win = match window(&app) {
                    Some(w) => Ok(w),
                    None => {
                        loaded = false;
                        log::line("roam: opening the overlay");
                        create(&app, &st)
                    }
                };
                let win = match win {
                    Ok(w) => w,
                    Err(err) => {
                        log::line(format!("roam: {err}"));
                        let _ = reply.send(false);
                        continue;
                    }
                };
                place(&win, &frame);
                trip += 1;
                go.trip = trip;
                st.trip.store(trip, Ordering::SeqCst);
                *st.frame.lock().unwrap() = Some(frame);
                st.rects.lock().unwrap().clear();
                *st.last_cursor.lock().unwrap() = (f64::NAN, f64::NAN, false);
                st.active.store(true, Ordering::SeqCst);
                idle_since = None;
                if loaded {
                    let _ = app.emit_to(LABEL, "roam-go", go);
                } else {
                    pending = Some(go);
                }
                let _ = reply.send(true);
            }
            Ok(Msg::Ready) => {
                if !loaded {
                    log::line("roam: overlay ready");
                }
                loaded = true;
                if let Some(go) = pending.take() {
                    if go.trip == trip && st.is_active() {
                        let _ = app.emit_to(LABEL, "roam-go", go);
                    }
                }
            }
            Ok(Msg::Shown { trip: t }) => {
                if t != trip || !st.is_active() {
                    continue;
                }
                if let Some(win) = window(&app) {
                    // The first frame is drawn: show it without taking focus (the window
                    // is not focusable) and above the island, so Mamori climbs out
                    // over it rather than from behind it.
                    #[cfg(windows)]
                    let _ = win.set_ignore_cursor_events(st.ignoring.load(Ordering::SeqCst));
                    let _ = win.show();
                    #[cfg(not(windows))]
                    let _ = win.set_ignore_cursor_events(st.ignoring.load(Ordering::SeqCst));
                    platform::raise_topmost(&win);
                    island::restyle_soon(&app, LABEL);
                }
                let _ = app.emit_to(island::LABEL, "roam-away", t);
            }
            Ok(Msg::Done { trip: t }) => {
                if t != trip || !st.is_active() {
                    continue;
                }
                st.active.store(false, Ordering::SeqCst);
                st.rects.lock().unwrap().clear();
                let _ = app.emit_to(island::LABEL, "roam-home", t);
                // Let the island draw Mamori back in before the overlay goes away.
                std::thread::sleep(Duration::from_millis(80));
                if let Some(win) = window(&app) {
                    let _ = win.hide();
                }
                idle_since = Some(Instant::now());
            }
            Ok(Msg::Abort) => {
                pending = None;
                if !st.active.swap(false, Ordering::SeqCst) {
                    continue;
                }
                st.rects.lock().unwrap().clear();
                let _ = app.emit_to(LABEL, "roam-abort", ());
                if let Some(win) = window(&app) {
                    let _ = win.hide();
                }
                let _ = app.emit_to(island::LABEL, "roam-home", trip);
                idle_since = Some(Instant::now());
            }
            Err(RecvTimeoutError::Timeout) => {
                if idle_since.is_some() && !st.is_active() {
                    if let Some(win) = window(&app) {
                        let _ = win.destroy();
                        // Wait for it to be gone, so the next trip opens a fresh one.
                        let until = Instant::now() + Duration::from_millis(800);
                        while window(&app).is_some() && Instant::now() < until {
                            std::thread::sleep(Duration::from_millis(20));
                        }
                    }
                    loaded = false;
                    pending = None;
                    idle_since = None;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn create(app: &AppHandle, st: &RoamState) -> Result<WebviewWindow, String> {
    let win = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("roam.html".into()))
        .title("Mamori")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .disable_drag_drop_handler()
        // Must match the island's, or WebView2 refuses to start a second environment.
        .additional_browser_args(crate::BROWSER_ARGS)
        .build()
        .map_err(|e| format!("could not open the roam window: {e}"))?;
    st.ignoring.store(true, Ordering::SeqCst);
    // Click-through from the start. (GTK can only do this once the window has been
    // shown, so there it happens in `Shown`.)
    #[cfg(windows)]
    let _ = win.set_ignore_cursor_events(true);
    Ok(win)
}

/// Covers the island's display. One pixel short of the full height, so Windows never
/// takes the overlay for a fullscreen app (that changes how the taskbar behaves).
fn place(win: &WebviewWindow, frame: &Frame) {
    let pos = PhysicalPosition::new(frame.x, frame.y);
    let size = PhysicalSize::new(frame.w.max(1), frame.h.saturating_sub(1).max(1));
    let same = win.outer_position().ok() == Some(pos) && win.inner_size().ok() == Some(size);
    if !same {
        let _ = win.set_size(size);
        let _ = win.set_position(pos);
        // Moving across displays can rescale the window: say the size again.
        let _ = win.set_size(size);
    }
}

// ── What the island and the overlay ask for ─────────────────────────────────────

fn frame_for(app: &AppHandle, island_win: &WebviewWindow) -> Result<Frame, String> {
    let m = island_win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or("no display")?;
    Ok(Frame { x: m.position().x, y: m.position().y, w: m.size().width, h: m.size().height, scale: m.scale_factor() })
}

/// Sends Mamori out. `nest` is the head's centre in the island's CSS pixels.
/// False when it can't go: the pointer is on another display, the island is hidden…
pub fn start(app: &AppHandle, request: RoamRequest, nest: Point, nest_scale: f64) -> Result<bool, String> {
    let st = roam_state(app).ok_or("not ready")?;
    let island_win = island::window(app).ok_or("no island")?;
    if !island::is_visible(app) {
        log::line("roam: skipped, the island is hidden");
        return Ok(false);
    }
    let frame = frame_for(app, &island_win)?;
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let on_display = cursor.x >= frame.x as f64
        && cursor.y >= frame.y as f64
        && cursor.x < frame.x as f64 + frame.w as f64
        && cursor.y < frame.y as f64 + frame.h as f64;
    if !on_display {
        log::line("roam: skipped, the pointer is on another display");
        return Ok(false);
    }
    let origin = island_win.outer_position().map_err(|e| e.to_string())?;
    let island_scale = island_win.scale_factor().unwrap_or(frame.scale);
    let (color, look, sound, volume) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        (s.color.clone(), s.island_look.clone(), s.sound, s.volume)
    };
    let go = Go {
        trip: 0,
        request,
        nest: frame.from_window(origin, island_scale, nest),
        nest_scale: nest_scale * island_scale / frame.scale,
        cursor: frame.local(cursor.x, cursor.y),
        screen: Point { x: frame.w as f64 / frame.scale, y: frame.h.saturating_sub(1) as f64 / frame.scale },
        color,
        look,
        sound,
        volume,
    };
    let (reply_tx, reply_rx) = mpsc::channel();
    if !st.send(Msg::Start { go, frame, reply: reply_tx }) {
        return Ok(false);
    }
    // Creating the overlay the first time takes a moment; after that it's instant.
    Ok(reply_rx.recv_timeout(Duration::from_secs(8)).unwrap_or(false))
}

/// The island moved Mamori's seat (it grew or shrank): tell the overlay.
pub fn set_nest(app: &AppHandle, nest: Point, nest_scale: f64) {
    let Some(st) = roam_state(app) else { return };
    if !st.is_active() {
        return;
    }
    let Some(frame) = *st.frame.lock().unwrap() else { return };
    let Some(island_win) = island::window(app) else { return };
    let Ok(origin) = island_win.outer_position() else { return };
    let island_scale = island_win.scale_factor().unwrap_or(frame.scale);
    let payload = NestPayload { nest: frame.from_window(origin, island_scale, nest), nest_scale: nest_scale * island_scale / frame.scale };
    let _ = app.emit_to(LABEL, "roam-nest", payload);
}

/// Mamori is out on the screen right now.
pub fn is_active(app: &AppHandle) -> bool {
    roam_state(app).is_some_and(|st| st.is_active())
}

pub fn ready(app: &AppHandle) {
    if let Some(st) = roam_state(app) {
        st.send(Msg::Ready);
    }
}

pub fn shown(app: &AppHandle, trip: u64) {
    if let Some(st) = roam_state(app) {
        st.send(Msg::Shown { trip });
    }
}

pub fn done(app: &AppHandle, trip: u64) {
    if let Some(st) = roam_state(app) {
        st.send(Msg::Done { trip });
    }
}

/// Puts Mamori straight back without the walk home: the island is being hidden,
/// the displays changed, a fullscreen app came up.
pub fn abort(app: &AppHandle) {
    if let Some(st) = roam_state(app) {
        if st.is_active() {
            st.send(Msg::Abort);
        }
    }
}

pub fn set_rects(app: &AppHandle, rects: Vec<Rect>) {
    if let Some(st) = roam_state(app) {
        *st.rects.lock().unwrap() = rects;
    }
}

/// Called by the island's poll thread ~30 times a second: click-through for the overlay
/// and the pointer position for Mamori to chase.
pub fn poll(app: &AppHandle, cursor: PhysicalPosition<f64>) {
    let Some(st) = roam_state(app) else { return };
    if !st.is_active() {
        return;
    }
    let Some(frame) = *st.frame.lock().unwrap() else { return };
    let Some(win) = window(app) else { return };
    let p = frame.local(cursor.x, cursor.y);
    let inside = st.rects.lock().unwrap().iter().any(|r| r.contains(p.x, p.y, HIT_MARGIN));
    if st.ignoring.load(Ordering::SeqCst) == inside {
        st.ignoring.store(!inside, Ordering::SeqCst);
        let _ = win.set_ignore_cursor_events(!inside);
        island::restyle_soon(app, LABEL);
    }
    let mut last = st.last_cursor.lock().unwrap();
    if !((p.x - last.0).abs() < 1.0 && (p.y - last.1).abs() < 1.0 && inside == last.2) {
        *last = (p.x, p.y, inside);
        let _ = app.emit_to(LABEL, "cursor", CursorPayload { x: p.x, y: p.y, inside });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_turn_screen_pixels_into_page_pixels() {
        // A 4K display at 150 % to the right of the main one.
        let f = Frame { x: 1920, y: 0, w: 3840, h: 2160, scale: 1.5 };
        assert_eq!(f.local(1920.0, 0.0), Point { x: 0.0, y: 0.0 });
        assert_eq!(f.local(1920.0 + 300.0, 150.0), Point { x: 200.0, y: 100.0 });
        // The island window sits at the top centre of that display.
        let origin = PhysicalPosition::new(1920 + 1440, 0);
        let p = f.from_window(origin, 1.5, Point { x: 100.0, y: 20.0 });
        assert_eq!(p, Point { x: 1060.0, y: 20.0 });
    }

    #[test]
    fn requests_from_the_island_parse() {
        let r: RoamRequest =
            serde_json::from_str(r#"{"kind":"approval","title":"Claude Code ขออนุมัติ","text":"npm install zod","agent":"claude","approvalId":7}"#)
                .unwrap();
        assert_eq!(r.approval_id, Some(7));
        let r: RoamRequest = serde_json::from_str(r#"{"kind":"done","title":"เสร็จแล้ว","text":""}"#).unwrap();
        assert!(r.agent.is_none() && r.approval_id.is_none());
    }
}
