pub const AUTO_LIMIT: u32 = 1000;

/// Words are runs of ASCII alphanumerics/underscore; every other char separates them.
fn words(s: &str) -> impl Iterator<Item = &str> {
    s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).filter(|w| !w.is_empty())
}

/// Fails if any `;`-separated statement whose first word is UPDATE or DELETE contains no WHERE word.
pub fn ensure_where(sql: &str) -> anyhow::Result<()> {
    for (i, stmt) in sql.split(';').filter(|s| !s.trim().is_empty()).enumerate() {
        let mut w = words(stmt);
        let Some(first) = w.next().map(str::to_ascii_uppercase) else { continue };
        if (first == "UPDATE" || first == "DELETE") && !w.any(|x| x.eq_ignore_ascii_case("WHERE")) {
            anyhow::bail!(
                "{first} without a WHERE clause would change every row, so nothing was sent to D1 (statement {}).",
                i + 1
            );
        }
    }
    Ok(())
}

/// A single statement whose first word is SELECT and that contains no LIMIT word gets "\nLIMIT 1000".
/// The newline keeps the LIMIT outside a trailing `--` comment. Returns (sql to send, limit_applied).
pub fn auto_limit(sql: &str) -> (String, bool) {
    let body = sql.trim_end().trim_end_matches(';').trim_end();
    let lone_select = !body.contains(';')
        && words(body).next().is_some_and(|w| w.eq_ignore_ascii_case("SELECT"));
    if lone_select && !words(body).any(|w| w.eq_ignore_ascii_case("LIMIT")) {
        (format!("{body}\nLIMIT {AUTO_LIMIT}"), true)
    } else {
        (sql.to_owned(), false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ensure_where_update_without_where() {
        let err = ensure_where("UPDATE t SET a = 1").unwrap_err();
        assert!(err.to_string().starts_with("UPDATE without a WHERE clause"));
    }

    #[test]
    fn test_ensure_where_case_insensitive_and_valid() {
        assert!(ensure_where("update t set a = 1 where id = 2").is_ok());
        assert!(ensure_where("delete from t Where x").is_ok());
    }

    #[test]
    fn test_ensure_where_multi_statement() {
        let err = ensure_where("SELECT 1; delete from t").unwrap_err();
        assert!(err.to_string().contains("(statement 2)"));
    }

    #[test]
    fn test_ensure_where_boundaries() {
        let err = ensure_where("UPDATE t SET somewhere = 1").unwrap_err();
        assert!(err.to_string().starts_with("UPDATE without a WHERE clause"));
        assert!(ensure_where("INSERT INTO t(note) VALUES ('update')").is_ok());
    }

    #[test]
    fn test_auto_limit_adds_limit() {
        assert_eq!(
            auto_limit("SELECT * FROM t"),
            ("SELECT * FROM t\nLIMIT 1000".to_string(), true)
        );
        assert_eq!(
            auto_limit("SELECT * FROM t;"),
            ("SELECT * FROM t\nLIMIT 1000".to_string(), true)
        );
        assert_eq!(
            auto_limit("SELECT * FROM t -- note"),
            ("SELECT * FROM t -- note\nLIMIT 1000".to_string(), true)
        );
    }

    #[test]
    fn test_auto_limit_no_addition() {
        assert_eq!(
            auto_limit("select * from t limit 5"),
            ("select * from t limit 5".to_string(), false)
        );
        assert_eq!(
            auto_limit("SELECT 1; SELECT 2"),
            ("SELECT 1; SELECT 2".to_string(), false)
        );
        assert_eq!(
            auto_limit("PRAGMA table_info(\"t\")"),
            ("PRAGMA table_info(\"t\")".to_string(), false)
        );
        assert_eq!(
            auto_limit("WITH c AS (SELECT 1) SELECT * FROM c"),
            ("WITH c AS (SELECT 1) SELECT * FROM c".to_string(), false)
        );
    }

    #[test]
    fn test_auto_limit_untrimmed_when_no_limit() {
        assert_eq!(
            auto_limit("select * from t limit 5;\n"),
            ("select * from t limit 5;\n".to_string(), false)
        );
        assert_eq!(
            auto_limit("PRAGMA x;  "),
            ("PRAGMA x;  ".to_string(), false)
        );
    }

    #[test]
    fn test_ensure_where_skips_empty_statements() {
        let err = ensure_where("SELECT 1;;  ;delete from t").unwrap_err();
        let msg = err.to_string();
        assert!(msg.starts_with("DELETE without a WHERE clause"));
        assert!(msg.contains("(statement 2)"));
    }

    #[test]
    fn test_sql_guard_whitespace_case_repeats() {
        assert_eq!(
            auto_limit("select *\tfrom t;;\n"),
            ("select *\tfrom t\nLIMIT 1000".to_string(), true)
        );
        assert_eq!(
            auto_limit("\n  SELECT 1"),
            ("\n  SELECT 1\nLIMIT 1000".to_string(), true)
        );
        assert!(ensure_where("UPDATE t SET a=1\nWHERE\tid=2").is_ok());
        assert!(ensure_where("  \n ; ").is_ok());
        assert!(ensure_where("UPDATE t SET a='é'").is_err());
        assert!(ensure_where("SELECT 1;").is_ok());
    }
}
