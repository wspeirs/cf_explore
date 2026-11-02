use tauri::{AppHandle, State};
use crate::error::CmdResult;
use crate::settings::{self, Settings};
use crate::state::AppState;

#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct SettingsStatus {
    pub settings: Option<Settings>,
    pub configured: bool,
    pub r2_configured: bool,
}

pub fn decide(loaded: Option<Settings>) -> (SettingsStatus, Option<Settings>) {
    match loaded {
        None => (
            SettingsStatus {
                settings: None,
                configured: false,
                r2_configured: false,
            },
            None,
        ),
        Some(s) => {
            let norm = settings::normalize(s.clone());
            if settings::validate(&norm).is_ok() {
                let r2 = settings::has_r2(&norm);
                (
                    SettingsStatus {
                        settings: Some(norm.clone()),
                        configured: true,
                        r2_configured: r2,
                    },
                    Some(norm),
                )
            } else {
                (
                    SettingsStatus {
                        settings: Some(s),
                        configured: false,
                        r2_configured: false,
                    },
                    None,
                )
            }
        }
    }
}

#[tauri::command]
pub async fn load_settings<R: tauri::Runtime>(app: AppHandle<R>, state: State<'_, AppState>) -> CmdResult<SettingsStatus> {
    let path = settings::settings_path(&app)?;
    let loaded = settings::load(&path)?;
    let (status, to_configure) = decide(loaded);
    if let Some(s) = to_configure {
        state.configure(s);
    }
    Ok(status)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    #[test]
    fn test_decide_none() {
        let (status, to_configure) = decide(None);
        assert_eq!(status.settings, None);
        assert!(!status.configured);
        assert!(!status.r2_configured);
        assert_eq!(to_configure, None);
    }

    #[test]
    fn test_decide_valid_with_whitespace() {
        let raw = Settings {
            account_id: "  0123456789abcdef0123456789abcdef ".to_string(),
            api_token: " t ".to_string(),
            r2_access_key_id: "".to_string(),
            r2_secret_access_key: "".to_string(),
        };
        let (status, to_configure) = decide(Some(raw));
        let expected = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "t".to_string(),
            r2_access_key_id: "".to_string(),
            r2_secret_access_key: "".to_string(),
        };
        assert_eq!(status.settings, Some(expected.clone()));
        assert!(status.configured);
        assert!(!status.r2_configured);
        assert_eq!(to_configure, Some(expected));
    }

    #[test]
    fn test_decide_valid_with_r2() {
        let raw = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "t".to_string(),
            r2_access_key_id: "key_id".to_string(),
            r2_secret_access_key: "secret".to_string(),
        };
        let (status, to_configure) = decide(Some(raw.clone()));
        assert_eq!(status.settings, Some(raw.clone()));
        assert!(status.configured);
        assert!(status.r2_configured);
        assert_eq!(to_configure, Some(raw));
    }

    #[test]
    fn test_decide_invalid_account() {
        let raw = Settings {
            account_id: "1234".to_string(),
            api_token: " t ".to_string(),
            r2_access_key_id: "".to_string(),
            r2_secret_access_key: "".to_string(),
        };
        let (status, to_configure) = decide(Some(raw));
        assert!(status.settings.is_some());
        assert!(!status.configured);
        assert!(!status.r2_configured);
        assert_eq!(to_configure, None);
    }

    #[test]
    fn test_decide_only_r2_key_id() {
        let raw = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "t".to_string(),
            r2_access_key_id: "key_id".to_string(),
            r2_secret_access_key: "".to_string(),
        };
        let (status, to_configure) = decide(Some(raw));
        assert!(!status.configured);
        assert!(!status.r2_configured);
        assert_eq!(to_configure, None);
    }
}
