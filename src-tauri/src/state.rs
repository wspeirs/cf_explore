use std::sync::RwLock;
use std::time::Duration;
use anyhow::Context;
use crate::settings::Settings;

pub struct AppState {
    http: reqwest::Client,
    inner: RwLock<Option<Configured>>,
}

#[derive(Clone)]
struct Configured {
    settings: Settings,
    s3: Option<aws_sdk_s3::Client>,
}

impl AppState {
    pub fn new() -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("cf_explore/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(60))
            .build()
            .context("Could not create the HTTP client")?;
        Ok(Self {
            http,
            inner: RwLock::new(None),
        })
    }

    pub fn configure(&self, s: Settings) {
        let s3 = if crate::settings::has_r2(&s) {
            Some(crate::r2::make_client(&s.account_id, &s.r2_access_key_id, &s.r2_secret_access_key))
        } else {
            None
        };
        let mut guard = self.inner.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        *guard = Some(Configured { settings: s, s3 });
    }

    pub fn d1_ctx(&self) -> anyhow::Result<crate::d1::D1Ctx> {
        let guard = self.inner.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        let conf = guard.as_ref().context("Cloudflare settings are not configured. Open File > Settings... to add them.")?;
        Ok(crate::d1::D1Ctx {
            http: self.http.clone(),
            account_id: conf.settings.account_id.clone(),
            api_token: conf.settings.api_token.clone(),
        })
    }

    pub fn s3(&self) -> anyhow::Result<aws_sdk_s3::Client> {
        let guard = self.inner.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        let conf = guard.as_ref().context("Cloudflare settings are not configured. Open File > Settings... to add them.")?;
        conf.s3.clone().context("R2 credentials are not configured. Open File > Settings... to add an R2 Access Key ID and Secret Access Key.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_app_state() {
        tauri::async_runtime::block_on(async {
            let state = AppState::new().unwrap();

            // unconfigured
            let d1_err = state.d1_ctx().err().expect("an unconfigured state must not produce a D1 context");
            assert_eq!(
                d1_err.to_string(),
                "Cloudflare settings are not configured. Open File > Settings... to add them."
            );
            let s3_err = state.s3().unwrap_err();
            assert_eq!(
                s3_err.to_string(),
                "Cloudflare settings are not configured. Open File > Settings... to add them."
            );

            // configured without R2
            let s_no_r2 = Settings {
                account_id: "0123456789abcdef0123456789abcdef".to_string(),
                api_token: "test_token".to_string(),
                r2_access_key_id: String::new(),
                r2_secret_access_key: String::new(),
            };
            state.configure(s_no_r2.clone());

            let d1 = state.d1_ctx().unwrap();
            assert_eq!(d1.account_id, s_no_r2.account_id);
            assert_eq!(d1.api_token, s_no_r2.api_token);

            let s3_err_no_r2 = state.s3().unwrap_err();
            assert_eq!(
                s3_err_no_r2.to_string(),
                "R2 credentials are not configured. Open File > Settings... to add an R2 Access Key ID and Secret Access Key."
            );

            // configured with R2
            let s_with_r2 = Settings {
                account_id: "0123456789abcdef0123456789abcdef".to_string(),
                api_token: "test_token".to_string(),
                r2_access_key_id: "test_r2_key".to_string(),
                r2_secret_access_key: "test_r2_secret".to_string(),
            };
            state.configure(s_with_r2);
            assert!(state.s3().is_ok());

            // then configure again without R2 -> s3() returns the R2 message again
            state.configure(s_no_r2);
            let s3_err_reverted = state.s3().unwrap_err();
            assert_eq!(
                s3_err_reverted.to_string(),
                "R2 credentials are not configured. Open File > Settings... to add an R2 Access Key ID and Secret Access Key."
            );
        });
    }
}
