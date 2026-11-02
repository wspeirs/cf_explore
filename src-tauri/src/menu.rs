use anyhow::Context;
use tauri::menu::{Menu, MenuBuilder, MenuEvent, SubmenuBuilder};
use tauri::Emitter;

// Menu item ids. `build` creates the items with them and `action_for` dispatches on them, so the
// two sides cannot drift apart.
const FILE_SETTINGS: &str = "file.settings";
const FILE_EXIT: &str = "file.exit";
const EDIT_CUT: &str = "edit.cut";
const EDIT_COPY: &str = "edit.copy";
const EDIT_PASTE: &str = "edit.paste";
const HELP_ABOUT: &str = "help.about";

pub fn build<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> anyhow::Result<Menu<R>> {
    let file = SubmenuBuilder::new(app, "File")
        .text(FILE_SETTINGS, "Settings...")
        .separator()
        .text(FILE_EXIT, "Exit")
        .build()
        .context("Failed to build the File menu")?;

    #[cfg(target_os = "linux")]
    let edit = SubmenuBuilder::new(app, "Edit")
        .text(EDIT_CUT, "Cut")
        .text(EDIT_COPY, "Copy")
        .text(EDIT_PASTE, "Paste")
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
        .text(HELP_ABOUT, "About cf_explore")
        .build()
        .context("Failed to build the Help menu")?;

    MenuBuilder::new(app)
        .items(&[&file, &edit, &help])
        .build()
        .context("Failed to build the menu bar")
}

/// What a clicked menu item does.
#[derive(Debug, PartialEq, Eq)]
enum MenuAction {
    Exit,
    /// Forward this payload to the frontend on the "menu" event (`App.vue` listens for it).
    Emit(&'static str),
}

/// Maps a menu item id to its action; ids we did not create are ignored.
fn action_for(id: &str) -> Option<MenuAction> {
    match id {
        FILE_EXIT => Some(MenuAction::Exit),
        FILE_SETTINGS => Some(MenuAction::Emit("settings")),
        HELP_ABOUT => Some(MenuAction::Emit("about")),
        EDIT_CUT => Some(MenuAction::Emit("cut")),
        EDIT_COPY => Some(MenuAction::Emit("copy")),
        EDIT_PASTE => Some(MenuAction::Emit("paste")),
        _ => None,
    }
}

pub fn on_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: MenuEvent) {
    match action_for(event.id().as_ref()) {
        Some(MenuAction::Exit) => app.exit(0),
        Some(MenuAction::Emit(payload)) => {
            if let Err(e) = app
                .emit("menu", payload)
                .context("Failed to deliver the menu event")
            {
                eprintln!("[cf_explore] {e:#}");
            }
        }
        None => (),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_menu_id_maps_to_the_payload_the_frontend_listens_for() {
        assert_eq!(action_for("file.exit"), Some(MenuAction::Exit));
        assert_eq!(action_for("file.settings"), Some(MenuAction::Emit("settings")));
        assert_eq!(action_for("help.about"), Some(MenuAction::Emit("about")));
        assert_eq!(action_for("edit.cut"), Some(MenuAction::Emit("cut")));
        assert_eq!(action_for("edit.copy"), Some(MenuAction::Emit("copy")));
        assert_eq!(action_for("edit.paste"), Some(MenuAction::Emit("paste")));
    }

    #[test]
    fn unknown_ids_are_ignored() {
        assert_eq!(action_for(""), None);
        assert_eq!(action_for("edit.selectall"), None);
        assert_eq!(action_for("FILE.EXIT"), None);
    }
}
