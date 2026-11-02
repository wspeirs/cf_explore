use anyhow::Context;
use serde::Deserialize;

#[derive(Clone)]
pub struct D1Ctx {
    pub http: reqwest::Client,
    pub account_id: String,
    pub api_token: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct D1Database {
    pub uuid: String,
    pub name: String,
    pub created_at: Option<String>,
    pub jurisdiction: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct TableInfo {
    pub name: String,
    pub kind: String,
    pub columns: Vec<ColumnInfo>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ColumnInfo {
    pub name: String,
    pub col_type: String,
    pub not_null: bool,
    pub pk: bool,
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct QueryOutcome {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub result_statement: Option<usize>,
    pub statement_count: usize,
    pub rows_read: u64,
    pub rows_written: u64,
    pub changes: u64,
    pub duration_ms: f64,
    pub limit_applied: bool,
}

fn null_as_default<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de> + Default,
{
    let opt = Option::<T>::deserialize(d)?;
    Ok(opt.unwrap_or_default())
}

#[derive(serde::Deserialize)]
struct Envelope<T> {
    #[serde(default, deserialize_with = "null_as_default")]
    success: bool,
    #[serde(default, deserialize_with = "null_as_default")]
    errors: Vec<ApiMessage>,
    result: Option<T>,
}

#[derive(serde::Deserialize, Default, Clone, Debug)]
struct ApiMessage {
    #[serde(default, deserialize_with = "null_as_default")]
    code: i64,
    #[serde(default, deserialize_with = "null_as_default")]
    message: String,
}

#[derive(serde::Deserialize, Default, Clone, Debug)]
pub struct RawStatement {
    pub results: Option<RawRows>,
    pub meta: Option<Meta>,
}

#[derive(serde::Deserialize, Default, Clone, Debug)]
pub struct RawRows {
    #[serde(default, deserialize_with = "null_as_default")]
    pub columns: Vec<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[derive(serde::Deserialize, Default, Clone, Debug)]
pub struct Meta {
    pub rows_read: Option<u64>,
    pub rows_written: Option<u64>,
    pub changes: Option<u64>,
    pub duration: Option<f64>,
}

pub fn parse_envelope<T: serde::de::DeserializeOwned>(status: u16, body: &str) -> anyhow::Result<T> {
    let snippet: String = body.chars().take(300).collect();
    let env: Envelope<T> = serde_json::from_str(body)
        .with_context(|| format!("Cloudflare API returned HTTP {status}: {snippet}"))?;

    if env.success
        && let Some(res) = env.result {
            return Ok(res);
        }

    if !env.errors.is_empty() {
        let err_msg = env
            .errors
            .iter()
            .map(|e| format!("{}: {}", e.code, e.message))
            .collect::<Vec<_>>()
            .join("; ");
        anyhow::bail!("Cloudflare API error: {err_msg}");
    } else {
        anyhow::bail!("Cloudflare API returned HTTP {status} without a result");
    }
}

const BASE: &str = "https://api.cloudflare.com/client/v4";

async fn send<T: serde::de::DeserializeOwned>(req: reqwest::RequestBuilder) -> anyhow::Result<T> {
    let resp = req.send().await.context("Could not reach the Cloudflare API")?;
    let status = resp.status().as_u16();
    let body = resp.text().await.context("Could not read the Cloudflare API response")?;
    parse_envelope(status, &body)
}

fn sort_databases(v: &mut [D1Database]) {
    v.sort_by_key(|a| a.name.to_lowercase());
}

pub async fn list_databases(ctx: &D1Ctx) -> anyhow::Result<Vec<D1Database>> {
    let mut all = Vec::new();
    let mut page = 1u32;
    loop {
        crate::log_call!("D1 list databases page {page}");
        let url = format!("{BASE}/accounts/{}/d1/database", ctx.account_id);
        let page_dbs: Vec<D1Database> = send(
            ctx.http
                .get(&url)
                .query(&[("page", page), ("per_page", 10000)])
                .bearer_auth(&ctx.api_token),
        )
        .await
        .with_context(|| format!("Listing D1 databases (page {page}) failed"))?;

        let count = page_dbs.len();
        all.extend(page_dbs);

        if count < 10000 {
            break;
        }
        page += 1;
    }
    sort_databases(&mut all);
    Ok(all)
}

pub async fn raw(ctx: &D1Ctx, database_id: &str, sql: &str) -> anyhow::Result<Vec<RawStatement>> {
    let url = format!("{BASE}/accounts/{}/d1/database/{database_id}/raw", ctx.account_id);
    let req = ctx
        .http
        .post(&url)
        .bearer_auth(&ctx.api_token)
        .json(&serde_json::json!({ "sql": sql }));
    let res = send(req).await;
    crate::log_call!("D1 raw ({} bytes)", sql.len());
    res
}

fn parse_table_list(stmts: Vec<RawStatement>) -> Vec<(String, String)> {
    let mut tables = Vec::new();
    if let Some(stmt) = stmts.into_iter().next()
        && let Some(results) = stmt.results
    {
        let name_idx = results.columns.iter().position(|c| c.eq_ignore_ascii_case("name"));
        let type_idx = results.columns.iter().position(|c| c.eq_ignore_ascii_case("type"));
        if let (Some(n_idx), Some(t_idx)) = (name_idx, type_idx) {
            for row in results.rows {
                let name = row.get(n_idx).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let kind = row.get(t_idx).and_then(|v| v.as_str()).unwrap_or("table").to_string();
                if !name.is_empty() {
                    tables.push((name, kind));
                }
            }
        }
    }
    tables
}

fn pragma_sql(chunk: &[(String, String)]) -> String {
    chunk
        .iter()
        .map(|(name, _)| {
            let escaped = name.replace('"', "\"\"");
            format!("PRAGMA table_info(\"{escaped}\");")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn assemble_chunk(
    chunk: &[(String, String)],
    stmts: Vec<RawStatement>,
) -> anyhow::Result<Vec<TableInfo>> {
    if stmts.len() != chunk.len() {
        anyhow::bail!(
            "D1 returned {} PRAGMA results for {} tables",
            stmts.len(),
            chunk.len()
        );
    }

    let mut table_infos = Vec::with_capacity(chunk.len());

    for ((tbl_name, tbl_kind), stmt) in chunk.iter().zip(stmts) {
        let mut columns = Vec::new();
        if let Some(results) = stmt.results {
            let name_idx = results.columns.iter().position(|c| c.eq_ignore_ascii_case("name"));
            let type_idx = results.columns.iter().position(|c| c.eq_ignore_ascii_case("type"));
            let notnull_idx = results.columns.iter().position(|c| c.eq_ignore_ascii_case("notnull"));
            let pk_idx = results.columns.iter().position(|c| c.eq_ignore_ascii_case("pk"));

            for row in results.rows {
                let col_name = name_idx
                    .and_then(|idx| row.get(idx))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let col_type = type_idx
                    .and_then(|idx| row.get(idx))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let not_null = notnull_idx
                    .and_then(|idx| row.get(idx))
                    .map(|v| match v {
                        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
                        _ => false,
                    })
                    .unwrap_or(false);
                let pk = pk_idx
                    .and_then(|idx| row.get(idx))
                    .map(|v| match v {
                        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
                        _ => false,
                    })
                    .unwrap_or(false);

                columns.push(ColumnInfo {
                    name: col_name,
                    col_type,
                    not_null,
                    pk,
                });
            }
        }
        table_infos.push(TableInfo {
            name: tbl_name.clone(),
            kind: tbl_kind.clone(),
            columns,
        });
    }

    Ok(table_infos)
}

pub async fn load_schema(ctx: &D1Ctx, database_id: &str) -> anyhow::Result<Vec<TableInfo>> {
    let master_stmts = raw(
        ctx,
        database_id,
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY name;",
    )
    .await
    .with_context(|| format!("Listing tables of database {database_id} failed"))?;

    let tables = parse_table_list(master_stmts);
    if tables.is_empty() {
        return Ok(Vec::new());
    }

    let mut table_infos = Vec::with_capacity(tables.len());

    for chunk in tables.chunks(100) {
        let sql = pragma_sql(chunk);
        let pragma_stmts = raw(ctx, database_id, &sql)
            .await
            .with_context(|| format!("Reading columns of database {database_id} failed"))?;
        let chunk_infos = assemble_chunk(chunk, pragma_stmts)?;
        table_infos.extend(chunk_infos);
    }

    Ok(table_infos)
}

fn prepare_query(sql: &str) -> anyhow::Result<(String, bool)> {
    anyhow::ensure!(!sql.trim().is_empty(), "Nothing to run.");
    crate::sql_guard::ensure_where(sql)?;
    Ok(crate::sql_guard::auto_limit(sql))
}

pub async fn run_query(ctx: &D1Ctx, database_id: &str, sql: &str) -> anyhow::Result<QueryOutcome> {
    let (sql_to_run, limit_applied) = prepare_query(sql)?;
    let stmts = raw(ctx, database_id, &sql_to_run).await.context("D1 query failed")?;
    Ok(build_outcome(stmts, limit_applied))
}

fn format_blob(arr: &[serde_json::Value]) -> serde_json::Value {
    let total = arr.len();
    let cap = total.min(256);
    let mut hex = String::with_capacity(cap * 2);
    for v in &arr[..cap] {
        let b = v.as_u64().unwrap_or(0) as u8;
        use std::fmt::Write;
        let _ = write!(&mut hex, "{:02x}", b);
    }
    if total > 256 {
        serde_json::Value::String(format!("x'{hex}'…({total} bytes)"))
    } else {
        serde_json::Value::String(format!("x'{hex}'"))
    }
}

fn convert_cell(val: serde_json::Value) -> serde_json::Value {
    match &val {
        serde_json::Value::Array(arr)
            if arr.iter().all(|v| v.as_u64().is_some_and(|n| n <= 255)) =>
        {
            format_blob(arr)
        }
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            serde_json::Value::String(val.to_string())
        }
        _ => val,
    }
}

pub fn build_outcome(stmts: Vec<RawStatement>, limit_applied: bool) -> QueryOutcome {
    let statement_count = stmts.len();
    let mut rows_read = 0u64;
    let mut rows_written = 0u64;
    let mut changes = 0u64;
    let mut duration_ms = 0.0f64;

    for stmt in &stmts {
        if let Some(meta) = &stmt.meta {
            rows_read += meta.rows_read.unwrap_or(0);
            rows_written += meta.rows_written.unwrap_or(0);
            changes += meta.changes.unwrap_or(0);
            duration_ms += meta.duration.unwrap_or(0.0);
        }
    }

    let mut last_with_cols_idx = None;
    for (idx, stmt) in stmts.iter().enumerate() {
        if let Some(results) = &stmt.results
            && !results.columns.is_empty()
        {
            last_with_cols_idx = Some(idx);
        }
    }

    let (columns, rows, result_statement) = match last_with_cols_idx {
        Some(idx) => {
            let results = stmts
                .into_iter()
                .nth(idx)
                .and_then(|stmt| stmt.results)
                .unwrap_or_default();
            let columns = results.columns;
            let rows = results
                .rows
                .into_iter()
                .map(|row| row.into_iter().map(convert_cell).collect())
                .collect();
            (columns, rows, Some(idx + 1))
        }
        None => (Vec::new(), Vec::new(), None),
    };

    QueryOutcome {
        columns,
        rows,
        result_statement,
        statement_count,
        rows_read,
        rows_written,
        changes,
        duration_ms,
        limit_applied,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_envelope_error() {
        let err = parse_envelope::<Vec<RawStatement>>(
            400,
            r#"{"success":false,"errors":[{"code":7500,"message":"near \"SELEC\": syntax error"}],"messages":[],"result":null}"#,
        )
        .unwrap_err();
        let formatted = format!("{:#}", err);
        assert!(
            formatted.contains("7500: near \"SELEC\": syntax error"),
            "Expected error to contain '7500: near \"SELEC\": syntax error', got: {formatted}"
        );
    }

    #[test]
    fn test_build_outcome_two_statements() {
        let stmts = vec![
            RawStatement {
                results: Some(RawRows {
                    columns: vec![],
                    rows: vec![],
                }),
                meta: Some(Meta {
                    changes: Some(2),
                    rows_written: Some(2),
                    rows_read: None,
                    duration: None,
                }),
            },
            RawStatement {
                results: Some(RawRows {
                    columns: vec!["id".into(), "data".into()],
                    rows: vec![
                        vec![
                            serde_json::json!(1),
                            serde_json::json!([1, 255]),
                        ],
                        vec![
                            serde_json::json!(2),
                            serde_json::Value::Null,
                        ],
                    ],
                }),
                meta: Some(Meta {
                    rows_read: Some(2),
                    rows_written: None,
                    changes: None,
                    duration: None,
                }),
            },
        ];

        let outcome = build_outcome(stmts, false);
        assert_eq!(outcome.columns, vec!["id", "data"]);
        assert_eq!(outcome.rows.len(), 2);
        assert_eq!(outcome.rows[0][0], serde_json::json!(1));
        assert_eq!(outcome.rows[0][1], serde_json::json!("x'01ff'"));
        assert_eq!(outcome.rows[1][0], serde_json::json!(2));
        assert_eq!(outcome.rows[1][1], serde_json::Value::Null);
        assert_eq!(outcome.result_statement, Some(2));
        assert_eq!(outcome.statement_count, 2);
        assert_eq!(outcome.rows_read, 2);
        assert_eq!(outcome.rows_written, 2);
        assert_eq!(outcome.changes, 2);
        assert!(!outcome.limit_applied);
    }

    #[test]
    fn test_blob_cap_at_256_bytes() {
        let first_256_hex: String = (0..256u32).map(|b| format!("{b:02x}")).collect();

        // 300 bytes: (i % 256) as u8
        let long_blob: Vec<serde_json::Value> =
            (0..300).map(|i| serde_json::json!((i % 256) as u8)).collect();
        let stmts = vec![RawStatement {
            results: Some(RawRows {
                columns: vec!["blob".into()],
                rows: vec![vec![serde_json::Value::Array(long_blob)]],
            }),
            meta: None,
        }];
        let outcome = build_outcome(stmts, false);
        let cell = &outcome.rows[0][0];
        let cell_str = cell.as_str().unwrap();
        let expected_300 = format!("x'{first_256_hex}'…(300 bytes)");
        assert_eq!(cell_str, expected_300);

        // Boundary: exactly 256 bytes -> x'<512 hex chars>' with NO suffix
        let blob_256: Vec<serde_json::Value> =
            (0..256).map(|i| serde_json::json!((i % 256) as u8)).collect();
        let stmts_256 = vec![RawStatement {
            results: Some(RawRows {
                columns: vec!["blob".into()],
                rows: vec![vec![serde_json::Value::Array(blob_256)]],
            }),
            meta: None,
        }];
        let outcome_256 = build_outcome(stmts_256, false);
        let cell_256 = &outcome_256.rows[0][0];
        let cell_256_str = cell_256.as_str().unwrap();
        let expected_256 = format!("x'{first_256_hex}'");
        assert_eq!(cell_256_str, expected_256);

        // Boundary: 257 bytes -> 512 hex chars then '…(257 bytes)
        let blob_257: Vec<serde_json::Value> =
            (0..257).map(|i| serde_json::json!((i % 256) as u8)).collect();
        let stmts_257 = vec![RawStatement {
            results: Some(RawRows {
                columns: vec!["blob".into()],
                rows: vec![vec![serde_json::Value::Array(blob_257)]],
            }),
            meta: None,
        }];
        let outcome_257 = build_outcome(stmts_257, false);
        let cell_257 = &outcome_257.rows[0][0];
        let cell_257_str = cell_257.as_str().unwrap();
        let expected_257 = format!("x'{first_256_hex}'…(257 bytes)");
        assert_eq!(cell_257_str, expected_257);
    }

    #[test]
    fn test_parse_envelope_success_and_missing_result() {
        let dbs: Vec<D1Database> = parse_envelope(
            200,
            r#"{"success":true,"errors":[],"result":[{"uuid":"u","name":"n"}]}"#,
        )
        .unwrap();
        assert_eq!(
            dbs,
            vec![D1Database {
                uuid: "u".into(),
                name: "n".into(),
                created_at: None,
                jurisdiction: None,
            }]
        );

        let err_null = parse_envelope::<Vec<D1Database>>(
            200,
            r#"{"success":true,"errors":[],"result":null}"#,
        )
        .unwrap_err();
        assert_eq!(
            err_null.to_string(),
            "Cloudflare API returned HTTP 200 without a result"
        );

        let err_absent = parse_envelope::<Vec<D1Database>>(
            200,
            r#"{"success":true,"errors":[]}"#,
        )
        .unwrap_err();
        assert_eq!(
            err_absent.to_string(),
            "Cloudflare API returned HTTP 200 without a result"
        );
    }

    #[test]
    fn test_parse_envelope_multiple_errors() {
        let err = parse_envelope::<Vec<D1Database>>(
            403,
            r#"{"success":false,"errors":[{"code":10000,"message":"Authentication error"},{"code":9109,"message":"x"}],"result":null}"#,
        )
        .unwrap_err();
        assert_eq!(
            err.to_string(),
            "Cloudflare API error: 10000: Authentication error; 9109: x"
        );
    }

    #[test]
    fn test_parse_envelope_non_json_and_truncation() {
        let err = parse_envelope::<Vec<D1Database>>(502, "<html>Bad gateway</html>").unwrap_err();
        let formatted = format!("{:#}", err);
        assert!(
            formatted.starts_with("Cloudflare API returned HTTP 502: <html>Bad gateway</html>: "),
            "Unexpected formatted: {formatted}"
        );

        let body: String = "é".repeat(400);
        let err = parse_envelope::<Vec<D1Database>>(500, &body).unwrap_err();
        let formatted = format!("{:#}", err);
        let snippet_300: String = "é".repeat(300);
        let snippet_301: String = "é".repeat(301);
        assert!(formatted.contains(&snippet_300));
        assert!(!formatted.contains(&snippet_301));
    }

    #[test]
    fn test_parse_envelope_null_tolerance() {
        let dbs: Vec<D1Database> = parse_envelope(
            200,
            r#"{"success":true,"errors":null,"result":[]}"#,
        )
        .unwrap();
        assert!(dbs.is_empty());

        let err = parse_envelope::<Vec<D1Database>>(
            400,
            r#"{"errors":[{"code":null,"message":null}],"result":null}"#,
        )
        .unwrap_err();
        assert!(
            err.to_string().starts_with("Cloudflare API error:"),
            "Expected 'Cloudflare API error:', got: {}",
            err
        );
    }

    #[test]
    fn test_build_outcome_no_column_bearing_statement() {
        let stmts = vec![
            RawStatement::default(),
            RawStatement {
                results: Some(RawRows::default()),
                meta: None,
            },
        ];
        let outcome = build_outcome(stmts, false);
        assert!(outcome.columns.is_empty());
        assert!(outcome.rows.is_empty());
        assert_eq!(outcome.result_statement, None);
        assert_eq!(outcome.statement_count, 2);
        assert_eq!(outcome.rows_read, 0);
        assert_eq!(outcome.rows_written, 0);
        assert_eq!(outcome.changes, 0);
        assert_eq!(outcome.duration_ms, 0.0);
    }

    #[test]
    fn test_build_outcome_duration_sum() {
        let stmts = vec![
            RawStatement {
                results: None,
                meta: Some(Meta {
                    duration: Some(0.25),
                    ..Default::default()
                }),
            },
            RawStatement {
                results: None,
                meta: Some(Meta {
                    duration: Some(1.5),
                    ..Default::default()
                }),
            },
        ];
        let outcome = build_outcome(stmts, false);
        assert_eq!(outcome.duration_ms, 1.75);
    }

    #[test]
    fn test_build_outcome_last_column_bearing_statement_wins() {
        let stmts = vec![
            RawStatement {
                results: Some(RawRows {
                    columns: vec!["a".into()],
                    rows: vec![vec![serde_json::json!(1)]],
                }),
                meta: None,
            },
            RawStatement {
                results: Some(RawRows {
                    columns: vec!["b".into()],
                    rows: vec![vec![serde_json::json!(2)]],
                }),
                meta: None,
            },
            RawStatement {
                results: Some(RawRows {
                    columns: vec![],
                    rows: vec![],
                }),
                meta: None,
            },
        ];
        let outcome = build_outcome(stmts, false);
        assert_eq!(outcome.columns, vec!["b"]);
        assert_eq!(outcome.rows, vec![vec![serde_json::json!(2)]]);
        assert_eq!(outcome.result_statement, Some(2));
        assert_eq!(outcome.statement_count, 3);
    }

    #[test]
    fn test_build_outcome_cell_conversions_and_limit_applied() {
        let stmts = vec![RawStatement {
            results: Some(RawRows {
                columns: vec![
                    "c1".into(), "c2".into(), "c3".into(), "c4".into(),
                    "c5".into(), "c6".into(), "c7".into(), "c8".into(),
                ],
                rows: vec![vec![
                    serde_json::json!([256]),
                    serde_json::json!([-1]),
                    serde_json::json!([1.5]),
                    serde_json::json!([]),
                    serde_json::json!("txt"),
                    serde_json::json!(3),
                    serde_json::json!(true),
                    serde_json::Value::Null,
                ]],
            }),
            meta: None,
        }];
        let outcome = build_outcome(stmts, true);
        assert!(outcome.limit_applied);
        assert_eq!(outcome.rows[0][0], serde_json::json!("[256]"));
        assert_eq!(outcome.rows[0][1], serde_json::json!("[-1]"));
        assert_eq!(outcome.rows[0][2], serde_json::json!("[1.5]"));
        assert_eq!(outcome.rows[0][3], serde_json::json!("x''"));
        assert_eq!(outcome.rows[0][4], serde_json::json!("txt"));
        assert_eq!(outcome.rows[0][5], serde_json::json!(3));
        assert_eq!(outcome.rows[0][6], serde_json::json!(true));
        assert_eq!(outcome.rows[0][7], serde_json::Value::Null);
    }

    #[test]
    fn test_pragma_sql() {
        let chunk = vec![
            ("a\"b".to_string(), "table".to_string()),
            ("c".to_string(), "view".to_string()),
        ];
        let sql = pragma_sql(&chunk);
        assert_eq!(sql, "PRAGMA table_info(\"a\"\"b\");\nPRAGMA table_info(\"c\");");
    }

    #[test]
    fn test_parse_table_list() {
        let stmts = vec![RawStatement {
            results: Some(RawRows {
                columns: vec!["name".into(), "type".into()],
                rows: vec![
                    vec![serde_json::json!("v"), serde_json::json!("view")],
                    vec![serde_json::Value::Null, serde_json::json!("table")],
                ],
            }),
            meta: None,
        }];
        let tables = parse_table_list(stmts);
        assert_eq!(tables, vec![("v".to_string(), "view".to_string())]);

        let empty = parse_table_list(vec![RawStatement {
            results: None,
            meta: None,
        }]);
        assert!(empty.is_empty());
    }

    #[test]
    fn test_assemble_chunk() {
        let chunk = vec![("t1".to_string(), "table".to_string())];
        let stmts = vec![RawStatement {
            results: Some(RawRows {
                columns: vec![
                    "cid".into(),
                    "name".into(),
                    "type".into(),
                    "notnull".into(),
                    "dflt_value".into(),
                    "pk".into(),
                ],
                rows: vec![
                    vec![
                        serde_json::json!(0),
                        serde_json::json!("id"),
                        serde_json::json!("INTEGER"),
                        serde_json::json!(0),
                        serde_json::Value::Null,
                        serde_json::json!(1),
                    ],
                    vec![
                        serde_json::json!(1),
                        serde_json::json!("t"),
                        serde_json::json!("TEXT"),
                        serde_json::json!(1),
                        serde_json::Value::Null,
                        serde_json::json!(0),
                    ],
                ],
            }),
            meta: None,
        }];

        let res = assemble_chunk(&chunk, stmts).unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].name, "t1");
        assert_eq!(res[0].kind, "table");
        assert_eq!(
            res[0].columns,
            vec![
                ColumnInfo {
                    name: "id".into(),
                    col_type: "INTEGER".into(),
                    not_null: false,
                    pk: true,
                },
                ColumnInfo {
                    name: "t".into(),
                    col_type: "TEXT".into(),
                    not_null: true,
                    pk: false,
                },
            ]
        );

        // Permuted columns give identical result
        let permuted_stmts = vec![RawStatement {
            results: Some(RawRows {
                columns: vec![
                    "pk".into(),
                    "notnull".into(),
                    "type".into(),
                    "name".into(),
                    "cid".into(),
                    "dflt_value".into(),
                ],
                rows: vec![
                    vec![
                        serde_json::json!(1),
                        serde_json::json!(0),
                        serde_json::json!("INTEGER"),
                        serde_json::json!("id"),
                        serde_json::json!(0),
                        serde_json::Value::Null,
                    ],
                    vec![
                        serde_json::json!(0),
                        serde_json::json!(1),
                        serde_json::json!("TEXT"),
                        serde_json::json!("t"),
                        serde_json::json!(1),
                        serde_json::Value::Null,
                    ],
                ],
            }),
            meta: None,
        }];
        let permuted_res = assemble_chunk(&chunk, permuted_stmts).unwrap();
        assert_eq!(permuted_res, res);

        // "notnull": "1" (a string) -> false
        let string_notnull_stmts = vec![RawStatement {
            results: Some(RawRows {
                columns: vec!["name".into(), "type".into(), "notnull".into(), "pk".into()],
                rows: vec![vec![
                    serde_json::json!("col"),
                    serde_json::json!("TEXT"),
                    serde_json::json!("1"),
                    serde_json::json!(0),
                ]],
            }),
            meta: None,
        }];
        let str_res = assemble_chunk(&chunk, string_notnull_stmts).unwrap();
        assert!(!str_res[0].columns[0].not_null);

        // Two chunk entries but one statement -> error exactly "D1 returned 1 PRAGMA results for 2 tables"
        let chunk2 = vec![
            ("t1".to_string(), "table".to_string()),
            ("t2".to_string(), "table".to_string()),
        ];
        let err = assemble_chunk(&chunk2, vec![RawStatement::default()]).unwrap_err();
        assert_eq!(err.to_string(), "D1 returned 1 PRAGMA results for 2 tables");
    }

    #[test]
    fn test_prepare_query() {
        let err_empty = prepare_query("  \n").unwrap_err();
        assert_eq!(err_empty.to_string(), "Nothing to run.");

        let err_update = prepare_query("UPDATE t SET a=1").unwrap_err();
        assert!(
            err_update.to_string().starts_with("UPDATE without a WHERE clause"),
            "Expected start with 'UPDATE without a WHERE clause', got: {}",
            err_update
        );

        let (sql, limit) = prepare_query("SELECT * FROM t").unwrap();
        assert_eq!(sql, "SELECT * FROM t\nLIMIT 1000");
        assert!(limit);
    }

    #[test]
    fn test_sort_databases() {
        let mut dbs = vec![
            D1Database {
                uuid: "1".into(),
                name: "b".into(),
                created_at: None,
                jurisdiction: None,
            },
            D1Database {
                uuid: "2".into(),
                name: "A".into(),
                created_at: None,
                jurisdiction: None,
            },
            D1Database {
                uuid: "3".into(),
                name: "a2".into(),
                created_at: None,
                jurisdiction: None,
            },
        ];
        sort_databases(&mut dbs);
        let names: Vec<&str> = dbs.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(names, vec!["A", "a2", "b"]);
    }
}
