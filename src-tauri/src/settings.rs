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
    std::fs::write(path, json).with_context(|| format!("Could not write {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .with_context(|| format!("Could not set permissions on {}", path.display()))?;
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

    #[test]
    fn test_normalize() {
        let s = Settings {
            account_id: "  0123456789abcdef0123456789abcdef  ".to_string(),
            api_token: "  token  ".to_string(),
            r2_access_key_id: "  key_id  ".to_string(),
            r2_secret_access_key: "  secret  ".to_string(),
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

        // Invalid account ID length
        let s_bad_id = Settings {
            account_id: "1234".to_string(),
            api_token: "token".to_string(),
            ..Default::default()
        };
        assert!(validate(&s_bad_id).is_err());

        // Invalid account ID non-hex
        let s_non_hex = Settings {
            account_id: "0123456789abcdef0123456789abcdeg".to_string(),
            api_token: "token".to_string(),
            ..Default::default()
        };
        assert!(validate(&s_non_hex).is_err());

        // Empty api token
        let s_no_token = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "".to_string(),
            ..Default::default()
        };
        assert!(validate(&s_no_token).is_err());

        // Partial R2 credentials
        let s_partial_r2 = Settings {
            account_id: "0123456789abcdef0123456789abcdef".to_string(),
            api_token: "token".to_string(),
            r2_access_key_id: "key".to_string(),
            r2_secret_access_key: "".to_string(),
        };
        assert!(validate(&s_partial_r2).is_err());
    }
}
