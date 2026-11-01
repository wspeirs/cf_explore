use anyhow::Context;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, SubmenuBuilder};
use tauri::Emitter;

pub fn build<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> anyhow::Result<Menu<R>> {
    let file = SubmenuBuilder::new(app, "File")
        .text("file.settings", "Settings...")
        .separator()
        .text("file.exit", "Exit")
        .build()
        .context("Failed to build the File menu")?;

    #[cfg(target_os = "linux")]
    let edit = SubmenuBuilder::new(app, "Edit")
        .text("edit.cut", "Cut")
        .text("edit.copy", "Copy")
        .text("edit.paste", "Paste")
        .build()
        .context("Failed to build the Edit menu")?;

    #[cfg(not(target_os = "linux"))]
    let edit = SubmenuBuilder::new(app, "Edit")
        .cut()
        .copy()
        .paste()
        .build()
        .context("Failed to build the Edit menu")?;

    let help = SubmenuBuilder::new(app, "Help")
        .text("help.about", "About cf_explore")
        .build()
        .context("Failed to build the Help menu")?;

    MenuBuilder::new(app)
        .items(&[&file, &edit, &help])
        .build()
        .context("Failed to build the menu bar")
}

pub fn on_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: MenuEvent) {
    let emit = |payload: &str| {
        if let Err(e) = app
            .emit("menu", payload)
            .context("Failed to deliver the menu event")
        {
            eprintln!("[cf_explore] {e:#}");
        }
    };

    match event.id().as_ref() {
        "file.exit" => app.exit(0),
        "file.settings" => emit("settings"),
        "help.about" => emit("about"),
        "edit.cut" => emit("cut"),
        "edit.copy" => emit("copy"),
        "edit.paste" => emit("paste"),
        _ => (),
    }
}
