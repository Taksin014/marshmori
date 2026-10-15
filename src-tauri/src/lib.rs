// Marshmori ("Mamori") lives at the top of your screen and keeps an eye on
// Claude Code, Codex and Antigravity: what they're doing, when they need you, and a
// quick chat through their own signed-in CLIs. When something needs you, it holds on
// to the island and stretches its neck over to your mouse pointer.

mod agents;
mod approvals;
mod chat;
mod demo;
mod files;
mod gate;
mod installer;
mod island;
mod log;
mod notify;
mod paths;
mod pipeline;
mod platform;
mod roam;
mod server;
mod sessions;
mod settings;
mod shortcuts;
mod tasks;
mod tray;
mod watch;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use crate::approvals::{ApprovalView, Decision};
use crate::sessions::{HistoryItem, Session, Sessions};
use crate::settings::Settings;

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub sessions: Mutex<Sessions>,
    pub approvals: approvals::Approvals,
    pub island: Arc<island::IslandState>,
    pub roam: Arc<roam::RoamState>,
    pub chat: chat::ChatState,
    pub tasks: tasks::TaskState,
    pub endpoint: Mutex<Option<server::Endpoint>>,
    /// A folder or files a launch asked to open, until the island takes them.
    pub pending_open: Mutex<Option<OpenRequest>>,
    /// Sessions a hook reported (key → when): the transcript watcher leaves them alone.
    pub hooked: Mutex<std::collections::HashMap<String, u64>>,
}

pub const SETTINGS_LABEL: &str = "settings";

/// WebView2 runs every window of an app in one browser environment, and refuses to
/// open a window whose browser arguments differ from the first one's. So every
/// window uses exactly these (the island's are in tauri.conf.json: keep them equal).
/// Autoplay lets Mamori's little sounds play without a click first.
/// The same for every window (WebView2 runs one browser per app and refuses a second
/// set of arguments). Besides Tauri's defaults: never treat our windows as hidden or in
/// the background — the island is never the focused window, and Chromium would
/// otherwise throttle its animation frames and timers and make everything stutter.
pub const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required";

/// Opens (or brings back) the settings window, optionally on a given tab.
pub fn open_settings(app: &AppHandle, tab: Option<&str>) {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        if let Some(tab) = tab {
            let _ = app.emit_to(SETTINGS_LABEL, "settings-tab", tab.to_string());
        }
        return;
    }
    let url = match tab {
        Some(tab) => format!("settings.html#{tab}"),
        None => "settings.html".to_string(),
    };
    let built = WebviewWindowBuilder::new(app, SETTINGS_LABEL, WebviewUrl::App(url.into()))
        .title("Marshmori — ตั้งค่า")
        .inner_size(900.0, 680.0)
        .min_inner_size(760.0, 540.0)
        .center()
        .additional_browser_args(BROWSER_ARGS)
        .build();
    if let Err(err) = built {
        log::line(format!("could not open settings: {err}"));
    }
}

// ── Commands for the island ─────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    sessions: Vec<Session>,
    approvals: Vec<ApprovalView>,
    settings: Settings,
    visible: bool,
}

#[tauri::command]
fn island_snapshot(app: AppHandle, state: tauri::State<'_, AppState>) -> Snapshot {
    Snapshot {
        sessions: state.sessions.lock().unwrap().snapshot(),
        approvals: state.approvals.snapshot(),
        settings: state.settings.lock().unwrap().clone(),
        visible: island::is_visible(&app),
    }
}

#[tauri::command]
fn island_set_hit_rects(state: tauri::State<'_, AppState>, rects: Vec<island::Rect>) {
    state.island.set_rects(rects);
}

#[tauri::command]
fn island_set_interactive(app: AppHandle, on: bool, focus: Option<bool>) {
    island::set_interactive(&app, on, focus.unwrap_or(true));
}

#[tauri::command]
fn island_hide(app: AppHandle) {
    island::set_user_hidden(&app, true);
}

#[tauri::command]
fn approval_ack(state: tauri::State<'_, AppState>, id: u64) -> bool {
    state.approvals.ack(id)
}

#[tauri::command]
fn approval_decide(app: AppHandle, id: u64, decision: String) -> Result<bool, String> {
    let decision = Decision::parse(&decision).ok_or("unknown decision")?;
    Ok(pipeline::decide(&app, id, decision))
}

/// Answers a question card: question text → chosen label(s) or what the user typed.
#[tauri::command]
fn approval_answer(app: AppHandle, id: u64, answers: approvals::Answers) -> bool {
    pipeline::answer(&app, id, answers)
}

/// Turns "allow for this round" off for a session before its round ends.
#[tauri::command]
fn session_allow_all_off(app: AppHandle, key: String) -> bool {
    pipeline::stop_allowing_all(&app, &key)
}

#[tauri::command]
fn history_list(state: tauri::State<'_, AppState>) -> Vec<HistoryItem> {
    state.sessions.lock().unwrap().history()
}

#[tauri::command]
fn session_dismiss(app: AppHandle, state: tauri::State<'_, AppState>, key: String) {
    state.sessions.lock().unwrap().remove(&key);
    pipeline::emit_sessions(&app);
}

#[tauri::command]
fn chat_send(app: AppHandle, request: chat::ChatRequest) -> Result<String, String> {
    chat::send(&app, request)
}

#[tauri::command]
fn chat_cancel(app: AppHandle, id: String) {
    chat::cancel(&app, &id);
}

/// Which agent CLIs are installed and signed in (the chat goes through them).
#[tauri::command]
async fn chat_providers(app: AppHandle, refresh: Option<bool>) -> Result<Vec<chat::ProviderStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || chat::providers(&app, refresh.unwrap_or(false)))
        .await
        .map_err(|e| e.to_string())
}

/// Opens a session's project folder ("เปิดโฟลเดอร์" on a finished card). Only folders
/// of sessions Marshmori is showing, or of tasks it ran.
#[tauri::command]
fn open_folder(app: AppHandle, state: tauri::State<'_, AppState>, path: String) -> Result<(), String> {
    let known = state.sessions.lock().unwrap().snapshot().iter().any(|s| s.cwd == path) || tasks::knows_folder(&app, &path);
    let dir = std::path::Path::new(&path);
    if !known || !dir.is_dir() {
        return Err("เปิดโฟลเดอร์นี้ไม่ได้".into());
    }
    #[cfg(windows)]
    let opener = "explorer";
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let opener = "xdg-open";
    std::process::Command::new(opener).arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ── Tasks Mamori runs (tasks.rs) ────────────────────────────────────────────────

#[tauri::command]
fn task_list(app: AppHandle) -> tasks::Snapshot {
    tasks::snapshot(&app)
}

#[tauri::command]
fn task_start(app: AppHandle, request: tasks::TaskRequest) -> Result<tasks::Task, String> {
    tasks::start(&app, request)
}

#[tauri::command]
fn task_cancel(app: AppHandle, id: String) {
    tasks::cancel(&app, &id);
}

#[tauri::command]
fn task_dismiss(app: AppHandle, id: String) -> bool {
    tasks::dismiss(&app, &id)
}

/// The system's folder picker (it blocks, so not on the main thread).
#[tauri::command]
async fn task_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || tasks::pick_folder(&app)).await.map_err(|e| e.to_string())
}

/// The system's file picker, for attaching files to a task.
#[tauri::command]
async fn task_pick_files(app: AppHandle, start: Option<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || tasks::pick_files(&app, start.as_deref())).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn files_inspect(paths: Vec<String>) -> Vec<files::FileInfo> {
    files::inspect(&paths)
}

#[tauri::command]
fn demo_run(app: AppHandle) {
    demo::run(&app);
}

// ── Commands for Mamori's trips (roam.rs) ───────────────────────────────────────

#[tauri::command]
async fn roam_start(app: AppHandle, request: roam::RoamRequest, nest: roam::Point, nest_scale: f64) -> Result<bool, String> {
    // The first trip opens the overlay window, which waits on the main thread.
    tauri::async_runtime::spawn_blocking(move || roam::start(&app, request, nest, nest_scale))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn roam_nest(app: AppHandle, nest: roam::Point, nest_scale: f64) {
    roam::set_nest(&app, nest, nest_scale);
}

#[tauri::command]
fn roam_ready(app: AppHandle) {
    roam::ready(&app);
}

#[tauri::command]
fn roam_shown(app: AppHandle, trip: u64) {
    roam::shown(&app, trip);
}

#[tauri::command]
fn roam_done(app: AppHandle, trip: u64) {
    roam::done(&app, trip);
}

#[tauri::command]
fn roam_set_hit_rects(app: AppHandle, rects: Vec<island::Rect>) {
    roam::set_rects(&app, rects);
}

/// "ดูรายละเอียด" or a click on Mamori: the island opens up for it.
#[tauri::command]
fn roam_open(app: AppHandle) {
    let _ = app.emit_to(island::LABEL, "roam-open", ());
}

/// The island wants Mamori back (the card was answered up there, the pointer came home…).
#[tauri::command]
fn roam_recall(app: AppHandle) {
    let _ = app.emit_to(roam::LABEL, "roam-recall", ());
}

/// A line from a page for the log file (why a trip didn't happen, and the like).
#[tauri::command]
fn log_line(text: String) {
    let clean: String = text.chars().filter(|c| !c.is_control()).take(300).collect();
    log::line(format!("page: {clean}"));
}

/// The settings window's "try it" button.
#[tauri::command]
fn roam_test(app: AppHandle) -> Result<(), String> {
    if !island::is_visible(&app) {
        return Err("ตอนนี้แถบด้านบนจอถูกซ่อนอยู่ เรียกกลับมาก่อน (คลิกไอคอนที่ถาดระบบ)".into());
    }
    let _ = app.emit_to(island::LABEL, "roam-test", ());
    Ok(())
}

// ── Commands for the settings window ────────────────────────────────────────────

#[tauri::command]
async fn settings_open(app: AppHandle, tab: Option<String>) {
    open_settings(&app, tab.as_deref());
}

#[tauri::command]
fn settings_get(state: tauri::State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn settings_save(app: AppHandle, state: tauri::State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    let mut next = settings.sanitized();
    let previous = state.settings.lock().unwrap().clone();
    // Kept here, not by the page: which agents you disconnected (a page open from
    // before would otherwise put back an older list).
    next.hooks_off = previous.hooks_off.clone();
    settings::save(&next)?;
    *state.settings.lock().unwrap() = next.clone();

    if previous.autostart != next.autostart {
        let launcher = app.autolaunch();
        let result = if next.autostart { launcher.enable() } else { launcher.disable() };
        if let Err(err) = result {
            log::line(format!("autostart: {err}"));
        }
    }
    if previous.approval_timeout != next.approval_timeout {
        if let Some(ep) = state.endpoint.lock().unwrap().as_ref() {
            let _ = server::write_endpoint(ep, next.approval_timeout);
        }
    }
    if previous.screen != next.screen {
        island::place(&app, &next.screen);
    }
    if previous.folder_menu != next.folder_menu {
        sync_folder_menu(next.folder_menu);
    }
    shortcuts::sync(&app);
    let _ = app.emit("settings", next.clone());
    Ok(next)
}

#[tauri::command]
fn hooks_status() -> Vec<installer::HookStatus> {
    installer::status_all()
}

/// "เริ่มใช้งาน" on the welcome page.
#[tauri::command]
fn settings_close(app: AppHandle) {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = win.close();
    }
}

/// "เชื่อมต่อทั้งหมด": every agent found on this computer that isn't connected yet.
#[tauri::command]
fn hooks_install_all(app: AppHandle) -> Vec<(String, Result<String, String>)> {
    installer::ensure_relay(&app);
    for a in agents::Agent::ALL {
        remember_hooks_off(&app, a, false);
    }
    let results = installer::install_detected().into_iter().map(|(a, r)| (a.id().to_string(), r)).collect();
    let _ = app.emit("hooks", installer::status_all());
    results
}

#[tauri::command]
fn hooks_install(app: AppHandle, agent: String) -> Result<String, String> {
    let agent = agents::Agent::parse(&agent).ok_or("ไม่รู้จัก agent นี้")?;
    installer::ensure_relay(&app);
    remember_hooks_off(&app, agent, false);
    let message = installer::install(agent)?;
    let _ = app.emit("hooks", installer::status_all());
    Ok(message)
}

#[tauri::command]
fn hooks_uninstall(app: AppHandle, agent: String) -> Result<String, String> {
    let agent = agents::Agent::parse(&agent).ok_or("ไม่รู้จัก agent นี้")?;
    let message = installer::uninstall(agent)?;
    // Taken off on purpose: Marshmori won't connect it again by itself.
    remember_hooks_off(&app, agent, true);
    let _ = app.emit("hooks", installer::status_all());
    Ok(message)
}

/// Keeps track of the agents you disconnected (they stay off) or connected again.
fn remember_hooks_off(app: &AppHandle, agent: agents::Agent, off: bool) {
    let state = app.state::<AppState>();
    let saved = {
        let mut s = state.settings.lock().unwrap();
        let id = agent.id().to_string();
        let has = s.hooks_off.contains(&id);
        if off == has {
            return;
        }
        if off {
            s.hooks_off.push(id);
        } else {
            s.hooks_off.retain(|a| a != &id);
        }
        s.clone()
    };
    if let Err(err) = settings::save(&saved) {
        log::line(format!("could not save settings: {err}"));
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    data_dir: String,
    log_file: String,
    relay_path: String,
    port: Option<u16>,
}

#[tauri::command]
fn app_info(state: tauri::State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: paths::data_dir().display().to_string(),
        log_file: paths::log_file().display().to_string(),
        relay_path: paths::relay_path().display().to_string(),
        port: state.endpoint.lock().unwrap().as_ref().map(|e| e.port),
    }
}

#[tauri::command]
fn island_show(app: AppHandle) {
    island::set_user_hidden(&app, false);
}

// ── Opening a folder or files from outside ─────────────────────────────────────

/// What a launch asks for: a folder to work in (Explorer's "สั่งงาน Mamori ที่นี่"),
/// or files and folders dropped on Marshmori's icon.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub folder: Option<String>,
    pub files: Vec<String>,
}

/// Reads a command line (with the program at [0]). Paths must be absolute and there.
fn open_request(argv: &[String]) -> Option<OpenRequest> {
    // Explorer quotes "%V": a drive root comes in as `C:"` (the backslash escaped the quote).
    let clean = |raw: &str| -> Option<String> {
        let mut p = raw.trim().trim_matches('"').to_string();
        if p.len() == 2 && p.ends_with(':') {
            p.push('\\');
        }
        let path = std::path::Path::new(&p);
        (path.is_absolute() && path.exists()).then_some(p)
    };
    let mut req = OpenRequest::default();
    let mut args = argv.iter().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--task-folder" {
            if let Some(p) = args.next().and_then(|a| clean(a)) {
                if std::path::Path::new(&p).is_dir() {
                    req.folder = Some(p);
                }
            }
        } else if !arg.starts_with('-') {
            if let Some(p) = clean(arg) {
                if req.folder.is_none() && std::path::Path::new(&p).is_dir() {
                    req.folder = Some(p);
                } else if req.files.len() < 10 {
                    req.files.push(p);
                }
            }
        }
    }
    (req.folder.is_some() || !req.files.is_empty()).then_some(req)
}

/// Shows the island with the task form open on that folder (now, or once it has loaded).
fn open_from_outside(app: &AppHandle, req: OpenRequest) {
    log::line(format!("opened with {} file(s){}", req.files.len(), if req.folder.is_some() { " and a folder" } else { "" }));
    island::set_user_hidden(app, false);
    *app.state::<AppState>().pending_open.lock().unwrap() = Some(req.clone());
    let _ = app.emit_to(island::LABEL, "open-task", req);
}

/// The island takes what a launch asked for (if it came before the island was ready).
#[tauri::command]
fn island_take_open(state: tauri::State<'_, AppState>) -> Option<OpenRequest> {
    state.pending_open.lock().unwrap().take()
}

fn sync_folder_menu(on: bool) {
    let Ok(exe) = std::env::current_exe() else { return };
    let label = format!("สั่งงาน {} ที่นี่", settings::DEFAULT_NAME);
    if let Err(err) = platform::set_folder_menu(on, &exe, &label) {
        log::line(format!("folder menu: {err}"));
    }
}

/// `Marshmori.exe --uninstall-cleanup`, run by the uninstaller: everything Marshmori
/// put outside its own folder goes (the agents' hooks, the Explorer menu, start-up).
fn uninstall_cleanup() {
    for agent in agents::Agent::ALL {
        match installer::uninstall(agent) {
            Ok(msg) => log::line(format!("uninstall: {}: {msg}", agent.id())),
            Err(err) => log::line(format!("uninstall: {}: {err}", agent.id())),
        }
    }
    sync_folder_menu(false);
    platform::remove_autostart_entry();
}

// ── Start-up ────────────────────────────────────────────────────────────────────

pub fn run() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.iter().any(|a| a == "--uninstall-cleanup") {
        uninstall_cleanup();
        return;
    }
    let launch_request = open_request(&argv);
    // Up to 0.3 the app was called AIMoji: its settings come along the first time.
    let took_over = paths::migrate_from_aimoji();
    let settings = settings::load();
    let first_run = !settings.onboarded;
    let island_state = Arc::new(island::IslandState::default());
    let roam_state = Arc::new(roam::RoamState::default());

    let app = tauri::Builder::default()
        // Must come first: a second launch hands its command line to the first. A folder
        // (Explorer's menu) or files open the task form there; nothing opens the settings.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| match open_request(&argv) {
            Some(req) => open_from_outside(app, req),
            None => open_settings(app, None),
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            settings: Mutex::new(settings),
            sessions: Mutex::new(Sessions::new()),
            approvals: approvals::Approvals::new(),
            island: island_state.clone(),
            roam: roam_state.clone(),
            chat: chat::ChatState::default(),
            tasks: tasks::TaskState::default(),
            endpoint: Mutex::new(None),
            pending_open: Mutex::new(launch_request),
            hooked: Mutex::new(std::collections::HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            island_snapshot,
            island_set_hit_rects,
            island_set_interactive,
            island_hide,
            island_show,
            island_take_open,
            approval_ack,
            approval_decide,
            approval_answer,
            session_allow_all_off,
            history_list,
            session_dismiss,
            chat_send,
            chat_cancel,
            chat_providers,
            open_folder,
            task_list,
            task_start,
            task_cancel,
            task_dismiss,
            task_pick_folder,
            task_pick_files,
            files_inspect,
            demo_run,
            roam_start,
            roam_nest,
            roam_ready,
            roam_shown,
            roam_done,
            roam_set_hit_rects,
            roam_open,
            roam_recall,
            roam_test,
            log_line,
            settings_open,
            settings_close,
            settings_get,
            settings_save,
            hooks_status,
            hooks_install,
            hooks_install_all,
            hooks_uninstall,
            app_info,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            log::line(format!("Marshmori {} starting", env!("CARGO_PKG_VERSION")));
            if took_over {
                log::line("took over AIMoji's settings");
            }

            installer::ensure_relay(&handle);
            // Hooks AIMoji installed now point at Marshmori's relay. Any that couldn't be
            // moved keep working: their old relay still finds us (see server.rs).
            let moved = installer::migrate_legacy();
            server::set_legacy_relays(installer::legacy_left());
            if !moved.is_empty() {
                notify::hooks_moved(&handle, &moved);
            }
            // Hooks an older Marshmori wrote get today's shape (0.5: Claude Code's
            // PreToolUse waits like a prompt, for approvals in an IDE).
            let updated: Vec<_> = installer::upgrade_outdated().into_iter().filter(|a| !moved.contains(a)).collect();
            if !updated.is_empty() {
                notify::hooks_updated(&handle, &updated);
            }
            // Agents on this computer get connected without a trip to the settings, so a
            // session in a terminal or an IDE shows up here by itself (0.6). One you took
            // off yourself stays off.
            let off = handle.state::<AppState>().settings.lock().unwrap().hooks_off.clone();
            let connected: Vec<_> = installer::install_detected_except(&off)
                .into_iter()
                .filter_map(|(a, r)| match r {
                    Ok(_) => Some(a),
                    Err(err) => {
                        log::line(format!("could not connect {}: {err}", a.id()));
                        None
                    }
                })
                .collect();
            if !connected.is_empty() && !first_run {
                notify::hooks_connected(&handle, &connected);
            }
            // AIMoji's "start with Windows" entry goes; Marshmori takes its place when the
            // setting (carried over with the rest) says so.
            if platform::remove_legacy_autostart() {
                log::line("removed AIMoji from start-up");
            }
            let autostart = handle.state::<AppState>().settings.lock().unwrap().autostart;
            if autostart && !handle.autolaunch().is_enabled().unwrap_or(true) {
                if let Err(err) = handle.autolaunch().enable() {
                    log::line(format!("autostart: {err}"));
                }
            }
            // Explorer's "สั่งงาน Mamori ที่นี่" points at this copy of the app (it may have
            // moved with an update).
            let folder_menu = handle.state::<AppState>().settings.lock().unwrap().folder_menu;
            std::thread::spawn(move || sync_folder_menu(folder_menu));
            std::thread::spawn(chat::tidy_old_files);
            tasks::load(&handle);

            let (wait, screen) = {
                let s = handle.state::<AppState>();
                let s = s.settings.lock().unwrap();
                (s.approval_timeout, s.screen.clone())
            };
            match server::start(handle.clone(), wait) {
                Ok(ep) => *handle.state::<AppState>().endpoint.lock().unwrap() = Some(ep),
                Err(err) => log::line(format!("server failed: {err}")),
            }

            island::setup(&handle, &screen);
            roam::spawn_worker(handle.clone(), roam_state.clone());
            island::spawn_poller(handle.clone(), island_state.clone());
            // Sessions no hook reports (an IDE without hooks, one started before they
            // were connected): seen from the transcripts the agents write.
            watch::spawn(handle.clone());
            if let Err(err) = tray::create(&handle) {
                log::line(format!("tray failed: {err}"));
            }

            // Tidy up quiet sessions once a minute.
            let sweeper = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                let changed = sweeper.state::<AppState>().sessions.lock().unwrap().sweep();
                if changed {
                    pipeline::emit_sessions(&sweeper);
                }
            });

            if first_run {
                let state = handle.state::<AppState>();
                let saved = {
                    let mut s = state.settings.lock().unwrap();
                    s.onboarded = true;
                    s.clone()
                };
                let _ = settings::save(&saved);
                open_settings(&handle, Some("welcome"));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Marshmori");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            tasks::stop_all(app);
            if let Some(ep) = app.state::<AppState>().endpoint.lock().unwrap().as_ref() {
                server::remove_endpoint(ep);
            }
        }
        // Closing the settings window must not quit the app: Mamori stays.
        if let RunEvent::ExitRequested { code: None, api, .. } = event {
            api.prevent_exit();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{open_request, OpenRequest};

    #[test]
    fn a_launch_with_a_folder_or_files_opens_the_task_form_there() {
        let dir = std::env::temp_dir().join(format!("marshmori-open-{}", std::process::id()));
        let sub = dir.join("blog");
        std::fs::create_dir_all(&sub).unwrap();
        let file = dir.join("notes.md");
        std::fs::write(&file, "x").unwrap();
        let exe = "marshmori".to_string();
        let folder = sub.display().to_string();

        // Explorer's "สั่งงาน Mamori ที่นี่".
        let req = open_request(&[exe.clone(), "--task-folder".into(), folder.clone()]).unwrap();
        assert_eq!(req, OpenRequest { folder: Some(folder.clone()), files: vec![] });
        // Dropped on the icon: the first folder to work in, the rest as files.
        let req = open_request(&[exe.clone(), file.display().to_string(), folder.clone()]).unwrap();
        assert_eq!(req.folder.as_deref(), Some(folder.as_str()));
        assert_eq!(req.files, vec![file.display().to_string()]);
        // Nothing usable: a plain second launch (it opens the settings instead).
        assert!(open_request(&[exe.clone()]).is_none());
        assert!(open_request(&[exe.clone(), "--task-folder".into(), "relative/path".into()]).is_none());
        assert!(open_request(&[exe.clone(), dir.join("gone").display().to_string()]).is_none());
        // A quoted path keeps working (and a drive root's trailing quote is dropped).
        let req = open_request(&[exe, "--task-folder".into(), format!("\"{folder}\"")]).unwrap();
        assert_eq!(req.folder.as_deref(), Some(folder.as_str()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_window_uses_the_same_browser_arguments() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let island = &conf["app"]["windows"][0];
        assert_eq!(island["label"], "island");
        assert_eq!(island["additionalBrowserArgs"], super::BROWSER_ARGS);
    }
}
