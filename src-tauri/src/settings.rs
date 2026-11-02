use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use anyhow::Context;
use tauri::Manager;

#[derive(serde::Serialize, serde::Deserialize, Clone, Default, Debug, PartialEq, Eq)]
pub struct Settings {
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub api_token: String,
    #[serde(default)]
    pub r2_access_key_id: String,
    #[serde(default)]
    pub r2_secret_access_key: String,
}

pub fn settings_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> anyhow::Result<PathBuf> {
    Ok(app
        .path()
        .home_dir()
        .context("Could not determine the home directory")?
        .join(".config")
        .join("cf_explore.json"))
}

pub fn load(path: &Path) -> anyhow::Result<Option<Settings>> {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("Could not read {}", path.display())),
        Ok(text) => {
            let s: Settings = serde_json::from_str(&text)
                .with_context(|| format!("{} is not valid settings JSON", path.display()))?;
            Ok(Some(s))
        }
    }
}

pub fn save(path: &Path, s: &Settings) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Could not create {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(s).context("Could not serialize settings")?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::fs::PermissionsExt;

        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("Could not write {}", path.display()))?;
        file.write_all(json.as_bytes())
            .with_context(|| format!("Could not write {}", path.display()))?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Could not set permissions on {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, json).with_context(|| format!("Could not write {}", path.display()))?;
    }
    Ok(())
}

pub fn normalize(s: Settings) -> Settings {
    Settings {
        account_id: s.account_id.trim().to_string(),
        api_token: s.api_token.trim().to_string(),
        r2_access_key_id: s.r2_access_key_id.trim().to_string(),
        r2_secret_access_key: s.r2_secret_access_key.trim().to_string(),
    }
}

pub fn validate(s: &Settings) -> anyhow::Result<()> {
    anyhow::ensure!(
        s.account_id.len() == 32 && s.account_id.chars().all(|c| c.is_ascii_hexdigit()),
        "Account ID must be the 32-character hex ID shown in the Cloudflare dashboard."
    );
    anyhow::ensure!(!s.api_token.is_empty(), "API token is required.");
    anyhow::ensure!(
        (s.r2_access_key_id.is_empty() && s.r2_secret_access_key.is_empty())
            || (!s.r2_access_key_id.is_empty() && !s.r2_secret_access_key.is_empty()),
        "Enter both the R2 Access Key ID and Secret Access Key, or leave both empty."
    );
    Ok(())
}

pub fn has_r2(s: &Settings) -> bool {
    !s.r2_access_key_id.is_empty() && !s.r2_secret_access_key.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let id = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("cf_explore_test_{name}_{}_{id}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("failed to create temp dir");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn test_normalize() {
        let s = Settings {
            account_id: "\t\r\n 0123456789abcdef0123456789abcdef \r\n\t".to_string(),
            api_token: "\r\n\t token \t\r\n".to_string(),
            r2_access_key_id: "\t\n key_id \r\n".to_string(),
            r2_secret_access_key: "\n\t secret \r\n".to_string(),
        };
        let norm = normalize(s);
        assert_eq!(norm.account_id, "0123456789abcdef0123456789abcdef");
        assert_eq!(norm.api_token, "token");
        assert_eq!(norm.r2_access_key_id, "key_id");
        assert_eq!(norm.r2_secret_access_key, "secret");
    }

    #[test]
    fn test_validate_and_has_r2() {
        // Valid without R2
        let s_no_r2 = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "secret_token".to_string(),
            r2_access_key_id: "".to_string(),
            r2_secret_access_key: "".to_string(),
        };
        assert!(validate(&s_no_r2).is_ok());
        assert!(!has_r2(&s_no_r2));

        // Valid with R2
        let s_with_r2 = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "secret_token".to_string(),
            r2_access_key_id: "key".to_string(),
            r2_secret_access_key: "sec".to_string(),
        };
        assert!(validate(&s_with_r2).is_ok());
        assert!(has_r2(&s_with_r2));

        // UPPERCASE 32-hex account id is accepted
        let s_upper = Settings {
            account_id: "0123456789ABCDEF0123456789ABCDEF".to_string(),
            api_token: "token".to_string(),
            ..Default::default()
        };
        assert!(validate(&s_upper).is_ok());

        // Invalid account ID length
        let s_bad_id = Settings {
            account_id: "1234".to_string(),
            api_token: "token".to_string(),
            ..Default::default()
        };
        assert_eq!(
            validate(&s_bad_id).unwrap_err().to_string(),
            "Account ID must be the 32-character hex ID shown in the Cloudflare dashboard."
        );

        // Invalid account ID non-hex
        let s_non_hex = Settings {
            account_id: "0123456789abcdef0123456789abcdeg".to_string(),
            api_token: "token".to_string(),
            ..Default::default()
        };
        assert_eq!(
            validate(&s_non_hex).unwrap_err().to_string(),
            "Account ID must be the 32-character hex ID shown in the Cloudflare dashboard."
        );

        // A 32-BYTE id made of 30 hex chars + "é" is rejected with the account message
        let s_32bytes_non_hex = Settings {
            account_id: "012345678901234567890123456789é".to_string(),
            api_token: "token".to_string(),
            ..Default::default()
        };
        assert_eq!(s_32bytes_non_hex.account_id.len(), 32);
        assert_eq!(
            validate(&s_32bytes_non_hex).unwrap_err().to_string(),
            "Account ID must be the 32-character hex ID shown in the Cloudflare dashboard."
        );

        // Empty api token
        let s_no_token = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "".to_string(),
            ..Default::default()
        };
        assert_eq!(
            validate(&s_no_token).unwrap_err().to_string(),
            "API token is required."
        );

        // Only key id
        let s_only_key = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "token".to_string(),
            r2_access_key_id: "key".to_string(),
            r2_secret_access_key: "".to_string(),
        };
        assert_eq!(
            validate(&s_only_key).unwrap_err().to_string(),
            "Enter both the R2 Access Key ID and Secret Access Key, or leave both empty."
        );
        assert!(!has_r2(&s_only_key));

        // Only secret
        let s_only_sec = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "token".to_string(),
            r2_access_key_id: "".to_string(),
            r2_secret_access_key: "sec".to_string(),
        };
        assert_eq!(
            validate(&s_only_sec).unwrap_err().to_string(),
            "Enter both the R2 Access Key ID and Secret Access Key, or leave both empty."
        );
        assert!(!has_r2(&s_only_sec));
    }

    #[test]
    fn test_save_and_load_file() {
        let temp = TempDir::new("save_load");
        let sub_file = temp.path().join("sub").join("x.json");
        let s = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "secret_token".to_string(),
            r2_access_key_id: "key".to_string(),
            r2_secret_access_key: "sec".to_string(),
        };

        // save to dir/sub/x.json creates sub, and load returns Some(equal settings)
        save(&sub_file, &s).unwrap();
        let loaded = load(&sub_file).unwrap();
        assert_eq!(loaded, Some(s.clone()));

        // the saved text is pretty JSON (contains "\n  \"account_id\"")
        let content = std::fs::read_to_string(&sub_file).unwrap();
        assert!(content.contains("\n  \"account_id\""));

        // on unix the mode is 0o600, also when saving over a pre-existing file created with 0o644
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let meta = std::fs::metadata(&sub_file).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);

            let overwrite_file = temp.path().join("sub").join("existing.json");
            std::fs::write(&overwrite_file, b"pre-existing").unwrap();
            std::fs::set_permissions(&overwrite_file, std::fs::Permissions::from_mode(0o644)).unwrap();
            let meta_before = std::fs::metadata(&overwrite_file).unwrap();
            assert_eq!(meta_before.permissions().mode() & 0o777, 0o644);

            save(&overwrite_file, &s).unwrap();
            let meta_after = std::fs::metadata(&overwrite_file).unwrap();
            assert_eq!(meta_after.permissions().mode() & 0o777, 0o600);
        }

        // load(dir/missing.json) == Ok(None)
        let missing = temp.path().join("missing.json");
        assert_eq!(load(&missing).unwrap(), None);

        // a file containing `{not json` -> format!("{:#}", err) starts with "<path> is not valid settings JSON"
        let bad_file = temp.path().join("invalid.json");
        std::fs::write(&bad_file, "{not json").unwrap();
        let bad_err = load(&bad_file).unwrap_err();
        assert!(format!("{:#}", bad_err).starts_with(&format!("{} is not valid settings JSON", bad_file.display())));

        // `{"account_id":"abc"}` loads with every other field empty
        let partial_file = temp.path().join("partial.json");
        std::fs::write(&partial_file, r#"{"account_id":"abc"}"#).unwrap();
        let partial_loaded = load(&partial_file).unwrap();
        assert_eq!(
            partial_loaded,
            Some(Settings {
                account_id: "abc".to_string(),
                api_token: String::new(),
                r2_access_key_id: String::new(),
                r2_secret_access_key: String::new(),
            })
        );

        // `load(&dir)` (a directory) is Err whose message starts with "Could not read <dir>"
        let dir_path = temp.path();
        let dir_err = load(dir_path).unwrap_err();
        assert!(format!("{:#}", dir_err).starts_with(&format!("Could not read {}", dir_path.display())));
    }
}
