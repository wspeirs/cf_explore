use tauri::{AppHandle, State};
use crate::error::CmdResult;
use crate::settings::{self, Settings};
use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct SettingsStatus {
    pub settings: Option<Settings>,
    pub configured: bool,
    pub r2_configured: bool,
}

#[tauri::command]
pub async fn load_settings<R: tauri::Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> CmdResult<SettingsStatus> {
    let path = settings::settings_path(&app)?;
    let loaded = settings::load(&path)?;
    match loaded {
        None => Ok(SettingsStatus {
            settings: None,
            configured: false,
            r2_configured: false,
        }),
        Some(s) => {
            let norm = settings::normalize(s.clone());
            if settings::validate(&norm).is_ok() {
                let r2 = settings::has_r2(&norm);
                state.configure(norm.clone());
                Ok(SettingsStatus {
                    settings: Some(norm),
                    configured: true,
                    r2_configured: r2,
                })
            } else {
                Ok(SettingsStatus {
                    settings: Some(s),
                    configured: false,
                    r2_configured: false,
                })
            }
        }
    }
}

#[tauri::command]
pub async fn save_settings<R: tauri::Runtime>(app: AppHandle<R>, state: State<'_, AppState>, settings: Settings) -> CmdResult<SettingsStatus> {
    let path = settings::settings_path(&app)?;
    let norm = settings::normalize(settings);
    settings::validate(&norm)?;
    settings::save(&path, &norm)?;
    let r2 = settings::has_r2(&norm);
    state.configure(norm.clone());
    Ok(SettingsStatus {
        settings: Some(norm),
        configured: true,
        r2_configured: r2,
    })
}

#[tauri::command]
pub async fn d1_list_databases(state: State<'_, AppState>) -> CmdResult<Vec<crate::d1::D1Database>> {
    Ok(crate::d1::list_databases(&state.d1_ctx()?).await?)
}

#[tauri::command]
pub async fn d1_load_schema(state: State<'_, AppState>, database_id: String) -> CmdResult<Vec<crate::d1::TableInfo>> {
    Ok(crate::d1::load_schema(&state.d1_ctx()?, &database_id).await?)
}

#[tauri::command]
pub async fn d1_query(state: State<'_, AppState>, database_id: String, sql: String) -> CmdResult<crate::d1::QueryOutcome> {
    Ok(crate::d1::run_query(&state.d1_ctx()?, &database_id, &sql).await?)
}

#[tauri::command]
pub async fn r2_list_buckets(state: State<'_, AppState>) -> CmdResult<Vec<crate::r2::BucketInfo>> {
    Ok(crate::r2::list_buckets(&state.s3()?).await?)
}

#[tauri::command]
pub async fn r2_list_objects(state: State<'_, AppState>, bucket: String, prefix: String, continuation_token: Option<String>) -> CmdResult<crate::r2::ListPage> {
    Ok(crate::r2::list_objects(&state.s3()?, &bucket, &prefix, continuation_token).await?)
}

#[tauri::command]
pub async fn r2_get_range(state: State<'_, AppState>, bucket: String, key: String, start: u64, end: u64) -> CmdResult<tauri::ipc::Response> {
    let bytes = crate::r2::get_range(&state.s3()?, &bucket, &key, start, end).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn r2_download(state: State<'_, AppState>, bucket: String, key: String, dest: String) -> CmdResult<u64> {
    let dest_path = std::path::PathBuf::from(dest);
    Ok(crate::r2::download(&state.s3()?, &bucket, &key, &dest_path).await?)
}
