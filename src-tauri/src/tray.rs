// The tray icon: left click shows or hides Mamori, right click opens the menu.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "แสดง / ซ่อน", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "ตั้งค่า…", true, None::<&str>)?;
    let demo = MenuItem::with_id(app, "demo", "ลองดูเดโม", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "ออกจาก Marshmori", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &demo, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("marshmori")
        .tooltip("Marshmori")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => crate::island::toggle(app),
            "settings" => crate::open_settings(app, None),
            "demo" => crate::demo::run(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::island::toggle(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
