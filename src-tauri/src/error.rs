/// Error type of every #[tauri::command]; serializes as the full anyhow chain ("context: cause: ...").
#[derive(Debug)]
pub struct CmdError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for CmdError {
    fn from(e: E) -> Self {
        let e = e.into();
        if crate::debug_enabled() {
            // {:?} on the root SdkError includes the raw HTTP status/headers/body; no request headers (no creds).
            eprintln!("[cf_explore] command error: {e:#}\n  chain: {:?}", e.chain().map(|c| format!("{c:?}")).collect::<Vec<_>>());
        }
        Self(e)
    }
}

impl serde::Serialize for CmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:#}", self.0))
    }
}

pub type CmdResult<T> = Result<T, CmdError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cmd_error_serialization() {
        assert_eq!(
            serde_json::to_string(&CmdError::from(anyhow::anyhow!("a").context("b"))).unwrap(),
            "\"b: a\""
        );
        assert_eq!(
            serde_json::to_string(&CmdError::from(std::io::Error::other(
                "x"
            )))
            .unwrap(),
            "\"x\""
        );
    }
}
