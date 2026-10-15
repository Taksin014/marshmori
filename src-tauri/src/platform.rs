// The Win32 bits the island needs. On other systems these do nothing, so the app
// still builds and runs there for development.

#[cfg(windows)]
mod imp {
    use std::path::Path;

    use tauri::WebviewWindow;
    use windows::core::{BOOL, HSTRING};
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::Storage::FileSystem::GetShortPathNameW;
    use windows::Win32::System::Ole::RevokeDragDrop;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, IsZoomed, SetWindowLongPtrW, SetWindowPos,
        GWL_EXSTYLE, GWL_STYLE, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, WS_CAPTION,
        WS_EX_TOOLWINDOW,
    };

    /// Tauri may link a different `windows` crate version than ours, so the handle
    /// is carried over as a raw pointer.
    fn hwnd_of(win: &WebviewWindow) -> Option<HWND> {
        let raw = win.hwnd().ok()?.0 as isize;
        (raw != 0).then(|| HWND(raw as *mut _))
    }

    /// WS_EX_TOOLWINDOW keeps an overlay out of Alt-Tab.
    ///
    /// Not stealing focus is tao's job (the windows are built with `focusable(false)`,
    /// which it turns into WS_EX_NOACTIVATE). tao rewrites the whole extended style
    /// whenever one of its own flags changes (click-through, show, hide…), which drops
    /// this bit, so it is put back after each of those: see `island::restyle_soon`.
    pub fn keep_out_of_alt_tab(win: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(win) else { return };
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let want = ex | WS_EX_TOOLWINDOW.0 as isize;
            if want != ex {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
            }
        }
    }

    /// Brings an always-on-top window to the very top of the always-on-top band
    /// without activating it (tao only does this when the flag itself changes).
    /// Asynchronous, so it can be called from any thread without waiting on the UI.
    pub fn raise_topmost(win: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(win) else { return };
        unsafe {
            let _ = SetWindowPos(
                hwnd,
                Some(HWND_TOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_ASYNCWINDOWPOS,
            );
        }
    }

    /// The window in front right now (an id only good for noticing that it changed).
    pub fn foreground_id() -> isize {
        unsafe { GetForegroundWindow().0 as isize }
    }

    /// True while the left mouse button is held: the only hint that a file drag
    /// may be on its way before it reaches the window.
    pub fn left_button_down() -> bool {
        unsafe { (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0 }
    }

    /// WebView2 registers its own drop target on its inner render window and, with
    /// no HTML drop handler, refuses every file. Revoking it lets the drop reach the
    /// target wry put on the parent, which is the one that feeds Tauri's drag events.
    /// Cheap and idempotent, so it is re-run whenever a drag may be starting.
    pub fn unblock_webview_drops(win: &WebviewWindow) {
        let Some(hwnd) = hwnd_of(win) else { return };
        unsafe {
            let _ = EnumChildWindows(Some(hwnd), Some(revoke_render_widget), LPARAM(0));
        }
    }

    unsafe extern "system" fn revoke_render_widget(hwnd: HWND, _: LPARAM) -> BOOL {
        let mut name = [0u16; 64];
        let len = unsafe { GetClassNameW(hwnd, &mut name) };
        if len > 0 && String::from_utf16_lossy(&name[..len as usize]) == "Chrome_RenderWidgetHostHWND" {
            let _ = unsafe { RevokeDragDrop(hwnd) };
        }
        true.into()
    }

    /// A game, a video or a slideshow covers the whole display the island is on
    /// (frameless and over every pixel of it).
    pub fn foreground_is_fullscreen(island: &WebviewWindow) -> bool {
        let Some(own) = hwnd_of(island) else { return false };
        unsafe {
            let fg = GetForegroundWindow();
            if fg.0.is_null() || fg == own {
                return false;
            }
            let mut name = [0u16; 64];
            let len = GetClassNameW(fg, &mut name);
            if len > 0 {
                let class = String::from_utf16_lossy(&name[..len as usize]);
                if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd") {
                    return false;
                }
            }
            // A maximized window keeps its title bar: it may fill a display that has no
            // taskbar (a second screen, an auto-hiding taskbar) and still not be a
            // fullscreen game or video. Only a window without a frame counts.
            if IsZoomed(fg).as_bool() {
                return false;
            }
            let style = GetWindowLongPtrW(fg, GWL_STYLE) as u32;
            if style & WS_CAPTION.0 == WS_CAPTION.0 {
                return false;
            }
            let monitor = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
            if monitor != MonitorFromWindow(own, MONITOR_DEFAULTTONEAREST) {
                return false;
            }
            let mut rect = RECT::default();
            if GetWindowRect(fg, &mut rect).is_err() {
                return false;
            }
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return false;
            }
            let m = info.rcMonitor;
            rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
        }
    }

    /// Everything a background task starts (the agent, the shells and builds it runs), in
    /// a Windows job: it can all be stopped at once, and it all goes with the job when
    /// the task is over or Marshmori itself goes away, so nothing is left running unseen.
    pub struct KillGroup(Option<isize>);

    impl KillGroup {
        pub fn new() -> Self {
            use windows::core::PCWSTR;
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::JobObjects::{
                CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };
            unsafe {
                let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else { return KillGroup(None) };
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if set.is_err() {
                    let _ = CloseHandle(job);
                    return KillGroup(None);
                }
                KillGroup(Some(job.0 as isize))
            }
        }

        /// Puts a process (and so whatever it starts from now on) in the group.
        pub fn add(&self, child: &std::process::Child) {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::System::JobObjects::AssignProcessToJobObject;
            if let Some(job) = self.0 {
                unsafe {
                    let _ = AssignProcessToJobObject(HANDLE(job as *mut _), HANDLE(child.as_raw_handle() as *mut _));
                }
            }
        }

        /// Stops everything in the group.
        pub fn kill(&self) {
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::System::JobObjects::TerminateJobObject;
            if let Some(job) = self.0 {
                unsafe {
                    let _ = TerminateJobObject(HANDLE(job as *mut _), 1);
                }
            }
        }
    }

    impl Drop for KillGroup {
        fn drop(&mut self) {
            use windows::Win32::Foundation::{CloseHandle, HANDLE};
            if let Some(job) = self.0 {
                unsafe {
                    let _ = CloseHandle(HANDLE(job as *mut _));
                }
            }
        }
    }

    /// Up to 0.3 this app was AIMoji, and it may still be set to start with Windows:
    /// that entry goes, so the old app doesn't come back at the next sign-in.
    pub fn remove_legacy_autostart() -> bool {
        remove_run_value("AIMoji")
    }

    /// Takes "start with Windows" out (the uninstaller asks for this).
    pub fn remove_autostart_entry() -> bool {
        remove_run_value("Marshmori")
    }

    fn remove_run_value(name: &str) -> bool {
        use windows::core::w;
        use windows::Win32::System::Registry::{RegDeleteKeyValueW, HKEY_CURRENT_USER};
        let name = HSTRING::from(name);
        unsafe {
            // Task Manager's on/off switch for it, if it was ever flipped.
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run"), &name);
            RegDeleteKeyValueW(HKEY_CURRENT_USER, w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run"), &name).is_ok()
        }
    }

    /// The two places Explorer looks for the verb: on a folder, and on a folder's
    /// empty space (right-click inside it).
    const FOLDER_MENU_KEYS: [&str; 2] = [
        "Software\\Classes\\Directory\\shell\\Marshmori",
        "Software\\Classes\\Directory\\Background\\shell\\Marshmori",
    ];

    fn reg_key(path: &str) -> Option<windows::Win32::System::Registry::HKEY> {
        use windows::core::PCWSTR;
        use windows::Win32::System::Registry::{RegCreateKeyExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE};
        let mut key = HKEY::default();
        let sub = HSTRING::from(path);
        let r = unsafe { RegCreateKeyExW(HKEY_CURRENT_USER, &sub, None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut key, None) };
        r.is_ok().then_some(key)
    }

    fn reg_string(key: windows::Win32::System::Registry::HKEY, name: Option<&str>, value: &str) -> bool {
        use windows::core::PCWSTR;
        use windows::Win32::System::Registry::{RegSetValueExW, REG_SZ};
        let wide: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
        let bytes: Vec<u8> = wide.iter().flat_map(|u| u.to_le_bytes()).collect();
        let name = name.map(HSTRING::from);
        let pname = name.as_ref().map(|n| PCWSTR(n.as_ptr())).unwrap_or(PCWSTR::null());
        unsafe { RegSetValueExW(key, pname, None, REG_SZ, Some(&bytes)).is_ok() }
    }

    /// "สั่งงาน Mamori ที่นี่" in Explorer's menu on folders (this user only); `on: false`
    /// takes it out again. Explorer starts `<exe> --task-folder "<folder>"`.
    pub fn set_folder_menu(on: bool, exe: &Path, label: &str) -> Result<(), String> {
        use windows::Win32::System::Registry::{RegCloseKey, RegDeleteTreeW, HKEY_CURRENT_USER};
        let exe = exe.display().to_string();
        for path in FOLDER_MENU_KEYS {
            unsafe {
                let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(path));
            }
            if !on {
                continue;
            }
            let key = reg_key(path).ok_or("เขียน registry ไม่ได้")?;
            let ok = reg_string(key, None, label) && reg_string(key, Some("Icon"), &format!("\"{exe}\",0"));
            unsafe {
                let _ = RegCloseKey(key);
            }
            let cmd = reg_key(&format!("{path}\\command")).ok_or("เขียน registry ไม่ได้")?;
            let ok2 = reg_string(cmd, None, &format!("\"{exe}\" --task-folder \"%V\""));
            unsafe {
                let _ = RegCloseKey(cmd);
            }
            if !(ok && ok2) {
                return Err("เขียน registry ไม่ได้".into());
            }
        }
        Ok(())
    }

    /// The 8.3 form of a path (no spaces), when the volume keeps short names.
    pub fn short_path(path: &Path) -> Option<String> {
        let wide = HSTRING::from(path.as_os_str());
        unsafe {
            let needed = GetShortPathNameW(&wide, None);
            if needed == 0 {
                return None;
            }
            let mut buf = vec![0u16; needed as usize];
            let len = GetShortPathNameW(&wide, Some(&mut buf));
            if len == 0 || len as usize >= buf.len() {
                return None;
            }
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::WebviewWindow;

    pub fn keep_out_of_alt_tab(_win: &WebviewWindow) {}
    pub fn raise_topmost(_win: &WebviewWindow) {}
    pub fn foreground_id() -> isize {
        0
    }
    pub fn left_button_down() -> bool {
        false
    }
    pub fn unblock_webview_drops(_win: &WebviewWindow) {}
    pub fn foreground_is_fullscreen(_island: &WebviewWindow) -> bool {
        false
    }
    pub fn remove_legacy_autostart() -> bool {
        false
    }

    pub fn remove_autostart_entry() -> bool {
        false
    }

    /// Explorer's folder menu is a Windows thing.
    pub fn set_folder_menu(_on: bool, _exe: &std::path::Path, _label: &str) -> Result<(), String> {
        Ok(())
    }

    /// Elsewhere a task runs in a process group of its own (chat.rs), which is how it
    /// is stopped; nothing to keep here.
    pub struct KillGroup;

    impl KillGroup {
        pub fn new() -> Self {
            KillGroup
        }
        pub fn add(&self, _child: &std::process::Child) {}
        pub fn kill(&self) {}
    }
}

pub use imp::*;
