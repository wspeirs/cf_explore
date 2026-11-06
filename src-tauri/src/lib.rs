use anyhow::Context;
use tauri::Manager;

static DEBUG: std::sync::LazyLock<bool> =
    std::sync::LazyLock::new(|| std::env::args().any(|a| a == "--debug"));

/// True when launched with `--debug`.
pub fn debug_enabled() -> bool {
    *DEBUG
}

#[macro_export]
macro_rules! log_call {
    ($($a:tt)*) => {
        if $crate::debug_enabled() {
            eprintln!("[cf_explore] API call: {}", format_args!($($a)*));
        }
    };
}

pub mod error;
pub mod settings;
pub mod state;
pub mod sql_guard;
pub mod d1;
pub mod r2;
mod commands;
mod menu;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(menu::on_event)
        .invoke_handler(tauri::generate_handler![
            commands::load_settings,
            commands::save_settings,
            commands::d1_list_databases,
            commands::d1_load_schema,
            commands::d1_query,
            commands::r2_list_buckets,
            commands::r2_list_objects,
            commands::r2_get_range,
            commands::r2_download
        ])
        .setup(|app| {
            app.manage(state::AppState::new()?);
            let menu = menu::build(app.handle())?;
            app.set_menu(menu).context("Failed to install the menu")?;

            let cfg = app.config().app.windows.iter().find(|w| w.label == "main").cloned()
                .context("tauri.conf.json has no window labelled `main`")?;
            tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)
                .context("Invalid `main` window config")?
                .enable_clipboard_access()
                .build()
                .context("Failed to create the main window")?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
