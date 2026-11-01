use anyhow::Context;

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

#[derive(serde::Deserialize)]
struct Envelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    errors: Vec<ApiMessage>,
    result: Option<T>,
}

#[derive(serde::Deserialize, Default, Clone, Debug)]
struct ApiMessage {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

#[derive(serde::Deserialize, Default, Clone, Debug)]
pub struct RawStatement {
    pub results: Option<RawRows>,
    pub meta: Option<Meta>,
}

#[derive(serde::Deserialize, Default, Clone, Debug)]
pub struct RawRows {
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
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
    all.sort_by_key(|a| a.name.to_lowercase());
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

pub async fn load_schema(ctx: &D1Ctx, database_id: &str) -> anyhow::Result<Vec<TableInfo>> {
    let master_stmts = raw(
        ctx,
        database_id,
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY name;",
    )
    .await
    .with_context(|| format!("Listing tables of database {database_id} failed"))?;

    let mut tables: Vec<(String, String)> = Vec::new();
    if let Some(stmt) = master_stmts.into_iter().next()
        && let Some(results) = stmt.results {
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

    if tables.is_empty() {
        return Ok(Vec::new());
    }

    let mut table_infos = Vec::with_capacity(tables.len());

    for chunk in tables.chunks(100) {
        let pragma_sql = chunk
            .iter()
            .map(|(name, _)| {
                let escaped = name.replace('"', "\"\"");
                format!("PRAGMA table_info(\"{escaped}\");")
            })
            .collect::<Vec<_>>()
            .join("\n");

        let pragma_stmts = raw(ctx, database_id, &pragma_sql)
            .await
            .with_context(|| format!("Reading columns of database {database_id} failed"))?;

        if pragma_stmts.len() != chunk.len() {
            anyhow::bail!(
                "D1 returned {} PRAGMA results for {} tables",
                pragma_stmts.len(),
                chunk.len()
            );
        }

        for ((tbl_name, tbl_kind), stmt) in chunk.iter().zip(pragma_stmts) {
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
    }

    Ok(table_infos)
}

pub async fn run_query(ctx: &D1Ctx, database_id: &str, sql: &str) -> anyhow::Result<QueryOutcome> {
    anyhow::ensure!(!sql.trim().is_empty(), "Nothing to run.");
    crate::sql_guard::ensure_where(sql)?;
    let (sql_to_run, limit_applied) = crate::sql_guard::auto_limit(sql);
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
            if !arr.is_empty() && arr.iter().all(|v| v.as_u64().is_some_and(|n| n <= 255)) =>
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
            && !results.columns.is_empty() {
                last_with_cols_idx = Some(idx);
            }
    }

    let (columns, rows, result_statement) = match last_with_cols_idx {
        Some(idx) => {
            let stmt = &stmts[idx];
            let results = stmt.results.as_ref().unwrap();
            let columns = results.columns.clone();
            let rows = results
                .rows
                .iter()
                .map(|row| row.iter().cloned().map(convert_cell).collect())
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
        assert!(cell_str.starts_with("x'"));
        assert!(cell_str.contains("…(300 bytes)"));
    }

    #[test]
    fn test_non_blob_array_and_object() {
        let stmts = vec![RawStatement {
            results: Some(RawRows {
                columns: vec!["arr".into(), "obj".into()],
                rows: vec![vec![
                    serde_json::json!(["hello", "world"]),
                    serde_json::json!({"key": "value"}),
                ]],
            }),
            meta: None,
        }];
        let outcome = build_outcome(stmts, false);
        assert_eq!(outcome.rows[0][0], serde_json::json!("[\"hello\",\"world\"]"));
        assert_eq!(outcome.rows[0][1], serde_json::json!("{\"key\":\"value\"}"));
    }
}
