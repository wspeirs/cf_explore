/// Error type of every #[tauri::command]; serializes as the full anyhow chain ("context: cause: ...").
#[derive(Debug)]
pub struct CmdError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for CmdError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

impl serde::Serialize for CmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:#}", self.0))
    }
}

pub type CmdResult<T> = Result<T, CmdError>;
