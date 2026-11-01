# cf_explore — Cloudflare D1/R2 desktop explorer (Tauri 2 + Vue 3 + Rust)

## Context

Build a DBeaver-like desktop GUI in the empty repo `/home/wspeirs/src/cf_explore` (only `.git` exists). It covers two services:
- **D1:** run any SQL. UPDATE or DELETE without `WHERE` is blocked with an error modal. A single SELECT with no LIMIT gets `LIMIT 1000` appended automatically.
- **R2:** read-only browsing. Preview shows the first 4096 bytes, and "Show More..." loads up to 1 MiB. Objects can be downloaded.

Stack: Tauri 2 with Vue 3 (`@revolist/vue3-datagrid` for grids, `@tanstack/vue-virtual` for the tree view) and a Rust/Tokio backend. The UI uses Windows 98 styling (98.css), a native OS File/Edit/Help menu bar, and settings in `~/.config/cf_explore.json`. Every design choice keeps billable or rate-limited Cloudflare calls to a minimum: lazy loading, in-memory caches, no polling, and no HEAD requests.

Fixed product decisions:
- Native OS menu bar.
- Settings fields: Account ID, API token, R2 Access Key ID, R2 Secret Access Key.
- Double-clicking a table puts `SELECT * FROM "t" LIMIT 100;` in the editor and runs it.
- Auto-`LIMIT 1000` applies to a lone SELECT.
- R2 preview opens in a draggable, non-modal Win98 window inside the app.

## Verified facts the design relies on

**Machine**
- Ubuntu 26.04 on a **Wayland** session, rustc **1.88.0** (too old, see Step 0), node v20.20.0, npm 10.8.2.
- pnpm/corepack is broken on this machine, so use **npm** only.
- apt packages present: build-essential, curl, wget, file, pkg-config, libwebkit2gtk-4.1-dev 2.52.6.
- apt packages missing: libxdo-dev, libssl-dev, libayatana-appindicator3-dev, librsvg2-dev.

**Versions (latest stable)**
- tauri 2.12.5 (MSRV 1.90); @tauri-apps/cli and @tauri-apps/api 2.12.4.
- tauri-plugin-dialog and @tauri-apps/plugin-dialog 2.8.4.
- aws-sdk-s3 1.157.0 (MSRV 1.94.1).
- reqwest 0.13.5: default TLS is rustls, and `.query()` needs the `query` feature.
- anyhow 1.0.104, tokio 1.54.
- @revolist/vue3-datagrid 4.30.0, @tanstack/vue-virtual 3.13.51, 98.css 0.1.21.

**D1 REST API**
- Base URL `https://api.cloudflare.com/client/v4`, header `Authorization: Bearer <token>`.
- List databases: `GET /accounts/{acct}/d1/database?page=N&per_page=10000` (per_page max 10000). Returns `result: [{uuid, name, created_at, version, jurisdiction?}]`.
- Run SQL: `POST /accounts/{acct}/d1/database/{uuid}/raw` with body `{"sql": "..."}`.
  - Statements joined by `;` run as one batch, and the response has one entry per statement: `result: [{results: {columns: [...], rows: [[...]]}, success, meta: {rows_read, rows_written, changes, duration, last_row_id, ...}}]`.
  - On failure the response is `success: false, errors: [{code, message}]`. SQL errors use code 7500.
- Billing counts rows read and written, not requests. The global API limit is 1200 requests per 5 minutes.
- `JOIN pragma_table_info(...)` fails on D1 with SQLITE_AUTH, so use standalone `PRAGMA table_info("t")` instead.
- Tables starting with `_cf_` (such as `_cf_KV`) are inaccessible.
- BLOBs arrive as JSON arrays of byte numbers.

**R2 S3 API**
- Endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`.
- ListBuckets and ListObjectsV2 are Class A ($4.50 per million); GetObject is Class B ($0.36 per million).
- `max-keys` is at most 1000. Range GET is supported. A Range GET on a 0-byte object returns 416 (InvalidRange).
- Buckets in a jurisdiction are reachable only through `.eu.`, `.fedramp.` or `.us.` endpoints.
- Re-exports confirmed in 1.157.0:
  - `aws_sdk_s3::config::{BehaviorVersion, Credentials, Region, RequestChecksumCalculation, ResponseChecksumValidation}`
  - `aws_sdk_s3::primitives::DateTimeFormat`
- aws-sdk errors work with `anyhow::Context`. smithy's `SdkBody` only boxes `Send + Sync` bodies, and `SdkError` holds `Box<dyn Error + Send + Sync>` sources, so `send()` errors meet anyhow's `StdError + Send + Sync + 'static` bound.

**Tauri 2.12.5 (source-checked)**
- It uses muda 0.20. muda's GTK built-in Copy/Cut/Paste items depend on the non-default `linux-libxdo` feature, and xdo works on X11 only (the source has `// TODO: wayland`). Those items are therefore unusable here, so on Linux the Edit menu uses custom items plus `document.execCommand`.
- WebKitGTK `javascript-can-access-clipboard` (default FALSE) gates `execCommand('cut'|'copy'|'paste')`, and enabling it also sets DOMPasteAllowed. Tauri exposes this only as `WebviewWindowBuilder::enable_clipboard_access()`. The window must therefore be built in `setup` via `WebviewWindowBuilder::from_config`, with `"create": false` in the config.
- `App::set_menu(menu) -> tauri::Result<Option<Menu>>` (also on `AppHandle`) installs the app-wide menu. A window built afterwards in `setup` inherits it, because `WindowBuilder::build` falls back to `app_handle().menu()`.
- Menu API:
  - `SubmenuBuilder::new(app, "File").text(id, label).separator().cut().copy().paste().build()`
  - `MenuBuilder::new(app).items(&[..]).build()`
  - `Builder::on_menu_event(Fn(&AppHandle, MenuEvent))`
  - `event.id().as_ref()` gives `&str`, because `MenuId(pub String)` implements `AsRef<str>`.
  - Also used: `AppHandle::exit(i32)`, `app.path().home_dir() -> tauri::Result<PathBuf>`, and `App::manage(state)` from the `Manager` trait, which registers managed state inside `setup`.
- Commands defined by the app need no capability entries. Plugins do, here `dialog:allow-save`. `core:default` covers events, `getVersion()` and the path API.
- A command returning `Result<tauri::ipc::Response, E: Serialize>` with `Response::new(Vec<u8>)` resolves to an `ArrayBuffer` in JS.
- A command error must be `Into<InvokeError>`, which requires `Serialize`. `anyhow::Error` is not `Serialize`, so commands return a small wrapper (Step 2).
- anyhow implements `From<anyhow::Error> for Box<dyn std::error::Error + 'static>`, so `?` on anyhow results works inside Tauri's `setup` closure, which returns `Result<(), Box<dyn Error>>`.

**revo-grid**
- `revogr-clipboard` listens for `copy`, `cut` and `paste` on `document` while the grid has a focused cell or a range. It then calls `preventDefault()` unless the cancelable `beforecopy` CustomEvent is prevented. This would break Ctrl+C in other inputs, hence the guard in Step 7.
- Cells read `model[prop]` with no dot-path parsing.
- Sorting runs client-side on raw values. Assigning a new `columns` array with no `order` resets the sort.
- The grid is light DOM, so `--revo-grid-*` CSS variables apply.

**98.css**
- Provides window, title-bar, tabs (`menu role="tablist"`), sunken-panel, status-bar, field-row and fieldset styles. It has no menu styles, and none are needed with a native menu.
- It bundles the "Pixelated MS Sans Serif" font, licensed CC BY-SA 3.0, which requires attribution.

## Approach

Build checkpoints: Step 1 ends with a running blank window. Steps 2–6 are the backend; their modules reference each other's types (`state.rs` uses `d1::D1Ctx` and `r2::make_client`), so add each `pub mod` line as its file is created and compile and run `cargo test` at the end of Step 6. Steps 7–10 are the frontend; run `npm run build` at the end of Step 10. The frontend depends on the backend only at runtime, so the two groups can be built in either order.

### Step 0 — Toolchain prerequisites

- Run `rustup update stable`, then check that `rustc --version` reports ≥ 1.94.1 (the aws-sdk-s3 MSRV).
- Run `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev` (the official Tauri list). If sudo is not available, carry on, and install only if a build fails on a missing system library.

### Step 1 — Scaffold, template cleanup, window bootstrap

1. Scaffold from `/home/wspeirs/src`:
   - Run `npm create tauri-app@latest cf_explore -- --template vue-ts --manager npm --identifier com.wspeirs.cfexplore --yes --force`. `--force` wipes the directory except `.git`, which is all the repo contains.
   - Then run `cd cf_explore && npm install`, followed by `cd src-tauri && cargo add anyhow@1`. anyhow is the only error-handling crate (no thiserror).
   - Expected result: npm/Cargo package `cf_explore`, lib crate `cf_explore_lib`, and the files `src-tauri/src/{main.rs,lib.rs}`, `src-tauri/tauri.conf.json` and `src-tauri/capabilities/default.json`.
2. Delete template leftovers:
   - the `greet` command
   - `tauri-plugin-opener`, everywhere it appears: the Cargo dep, `.plugin(tauri_plugin_opener::init())`, `"opener:default"` in the capability, and the `@tauri-apps/plugin-opener` npm dep
   - `src/assets/vue.svg`, `public/vite.svg`, `public/tauri.svg`, and the favicon `<link>` in `index.html`
   Then set `<title>cf_explore</title>` in `index.html`.
3. In `src-tauri/tauri.conf.json`:
   - Set `"productName": "cf_explore"`.
   - Set `app.windows` to `[{"label": "main", "title": "cf_explore", "width": 1200, "height": 800, "minWidth": 800, "minHeight": 500, "create": false}]`.
   - Keep `"security": {"csp": null}`.
4. In `lib.rs`, add `use anyhow::Context;` and this `.setup(...)` in `run()`. It is the only place the window gets created; Steps 2 and 6 add lines at the top of this closure:
   ```rust
   .setup(|app| {
       let cfg = app.config().app.windows.iter().find(|w| w.label == "main").cloned()
           .context("tauri.conf.json has no window labelled `main`")?;
       tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)
           .context("Invalid `main` window config")?
           .enable_clipboard_access()   // WebKitGTK: lets execCommand('cut'|'copy'|'paste') run (Edit menu, Step 6)
           .build()
           .context("Failed to create the main window")?;
       Ok(())
   })
   ```
   Check: `npm run tauri dev` opens one window titled `cf_explore`.

### Step 2 — Backend foundation: dependencies, error handling, settings, state

1. Dependencies:
   - In `src-tauri`, run:
     - `cargo add tauri-plugin-dialog@2`
     - `cargo add aws-sdk-s3@1 --features behavior-version-latest`
     - `cargo add reqwest@0.13 --features json,query`
     - `cargo add tokio@1 --features fs,io-util`
   - From the repo root, run `npm install @tauri-apps/plugin-dialog@^2 @revolist/vue3-datagrid@^4.30.0 @tanstack/vue-virtual@^3.13.51 98.css@^0.1.21`.
   - Set the `permissions` in `capabilities/default.json` to exactly `["core:default", "dialog:allow-save"]`.
   - Add `.plugin(tauri_plugin_dialog::init())` to the builder.
2. Module layout in `src-tauri/src/`:
   - `lib.rs` holds `run()`, the `log_call!` macro (defined before the `mod` lines) and `pub mod error; pub mod settings; pub mod state; pub mod sql_guard; pub mod d1; pub mod r2; mod commands; mod menu;`.
   - The modules are `pub` so a throwaway example binary can call them (Verification).
   - The macro:
     `macro_rules! log_call { ($($a:tt)*) => { #[cfg(debug_assertions)] eprintln!("[cf_explore] API call: {}", format_args!($($a)*)); } }`
   - Every outbound Cloudflare request calls it once. It is the verification hook for "minimize calls".
3. **Error handling: anyhow everywhere.**
   - Every fallible Rust function returns `anyhow::Result<T>`.
   - Every `?` applied to a non-anyhow error (from `reqwest`, `serde_json`, `std::io`, `tauri`, aws-sdk, or an `Option`) gets `.context("<static text>")` or `.with_context(|| format!(...))`.
   - A `?` on a value that is already an `anyhow::Result` with context stays bare.
   - New errors come from `anyhow::bail!` and `anyhow::ensure!`.
   - The strings quoted in Steps 2–6 are user-visible: they reach the error modal through `{:#}` (`context: cause: …`). Use them verbatim.
   - `error.rs` is the only bridge to Tauri:
     ```rust
     /// Error type of every #[tauri::command]; serializes as the full anyhow chain ("context: cause: ...").
     #[derive(Debug)]
     pub struct CmdError(anyhow::Error);
     impl<E: Into<anyhow::Error>> From<E> for CmdError {
         fn from(e: E) -> Self { Self(e.into()) }
     }
     impl serde::Serialize for CmdError {
         fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
             s.serialize_str(&format!("{:#}", self.0))
         }
     }
     pub type CmdResult<T> = Result<T, CmdError>;
     ```
     `CmdError` must not implement `std::error::Error`; if it did, the blanket `From` would overlap `impl<T> From<T> for T`.
   - Commands return `CmdResult<T>` and use plain `?` on anyhow results. JS `invoke` rejects with the message **string**.
4. `settings.rs`:
   - `#[derive(Serialize, Deserialize, Clone, Default)] pub struct Settings { #[serde(default)] pub account_id: String, #[serde(default)] pub api_token: String, #[serde(default)] pub r2_access_key_id: String, #[serde(default)] pub r2_secret_access_key: String }`. Use snake_case keys in both the file and IPC, with no renames anywhere in the project.
   - `pub fn settings_path(app: &AppHandle) -> anyhow::Result<PathBuf>`: `app.path().home_dir().context("Could not determine the home directory")?.join(".config").join("cf_explore.json")`. It needs `use tauri::Manager;`. This is the literal path on every OS.
   - `pub fn load(path: &Path) -> anyhow::Result<Option<Settings>>`: `match std::fs::read_to_string(path)`:
     - `Err(e) if e.kind() == ErrorKind::NotFound` → `Ok(None)`
     - any other `Err(e)` → `Err(e).with_context(|| format!("Could not read {}", path.display()))`
     - `Ok(text)` → `serde_json::from_str(&text).with_context(|| format!("{} is not valid settings JSON", path.display()))`, wrapped in `Some`
   - `pub fn save(path: &Path, s: &Settings) -> anyhow::Result<()>`:
     - `create_dir_all(parent)` with `.with_context(|| format!("Could not create {}", parent.display()))`
     - `serde_json::to_string_pretty(s).context("Could not serialize settings")`
     - `std::fs::write` with `.with_context(|| format!("Could not write {}", path.display()))`
     - on unix, `set_permissions(path, Permissions::from_mode(0o600))` with `.with_context(|| format!("Could not set permissions on {}", path.display()))`, because the file holds secrets
   - `pub fn normalize(s: Settings) -> Settings` trims all four fields.
   - `pub fn validate(s: &Settings) -> anyhow::Result<()>` uses `ensure!` with these messages:
     - account_id is exactly 32 ASCII hex chars, else "Account ID must be the 32-character hex ID shown in the Cloudflare dashboard."
     - api_token is not empty, else "API token is required."
     - the R2 key and secret are both set or both empty, else "Enter both the R2 Access Key ID and Secret Access Key, or leave both empty."
   - `pub fn has_r2(s: &Settings) -> bool` is true when both R2 fields are non-empty.
5. `state.rs`:
   - `pub struct AppState { http: reqwest::Client, inner: std::sync::RwLock<Option<Configured>> }` and `#[derive(Clone)] struct Configured { settings: Settings, s3: Option<aws_sdk_s3::Client> }`.
   - `AppState::new() -> anyhow::Result<Self>` builds `reqwest::Client::builder().user_agent(concat!("cf_explore/", env!("CARGO_PKG_VERSION"))).timeout(Duration::from_secs(60)).build().context("Could not create the HTTP client")?`.
   - Register it as the first line of `setup`: `app.manage(state::AppState::new()?);`.
   - `configure(&self, s: Settings)` is infallible. It stores the settings plus `r2::make_client(..)` when `has_r2`.
   - Take the lock with `self.inner.read()` / `.write()` followed by `.unwrap_or_else(std::sync::PoisonError::into_inner)`. Poisoning needs a panic while the guard is held, and nothing does that. Never hold the lock across `.await`: clone, then drop the guard.
   - `d1_ctx(&self) -> anyhow::Result<d1::D1Ctx>` returns a cloned `D1Ctx { http, account_id, api_token }`. When unconfigured, it fails via `.context("Cloudflare settings are not configured. Open File > Settings... to add them.")` on the `Option`.
   - `s3(&self) -> anyhow::Result<aws_sdk_s3::Client>`:
     - no settings → the same message as `d1_ctx`
     - `s3` is `None` → `.context("R2 credentials are not configured. Open File > Settings... to add an R2 Access Key ID and Secret Access Key.")`
6. `commands.rs`, settings commands (all `#[tauri::command] async`, registered in one `generate_handler!`):
   - `#[derive(Serialize)] pub struct SettingsStatus { settings: Option<Settings>, configured: bool, r2_configured: bool }`
   - `load_settings(app, state) -> CmdResult<SettingsStatus>`:
     - No file gives `{None, false, false}`.
     - If the file exists, `normalize` it. If `validate(&s).is_ok()`, call `state.configure(..)` and return `{Some(normalized), true, has_r2}`.
     - If the file exists but fails validation, return `{Some(s), false, false}`; the frontend then opens Settings with the values filled in.
     - Read and parse failures propagate as `Err`.
   - `save_settings(app, state, settings: Settings) -> CmdResult<SettingsStatus>`: normalize, validate, save, configure, then return `{Some, true, has_r2}`.

### Step 3 — WHERE check and auto-LIMIT (`src-tauri/src/sql_guard.rs`, std only)

This is a case-insensitive whole-word scan, not a parser, and it uses no crate: `sqlparser` is a full SQL parser, which is exactly what this step avoids. Write it as follows:

```rust
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
```

Tests go in `#[cfg(test)] mod tests`:
1. `ensure_where("UPDATE t SET a = 1")` is `Err`, and its message starts with `UPDATE without a WHERE clause`.
2. `ensure_where("update t set a = 1 where id = 2")` and `ensure_where("delete from t Where x")` are `Ok`.
3. `ensure_where("SELECT 1; delete from t")` is `Err`, and its message contains `(statement 2)`.
4. `ensure_where("UPDATE t SET somewhere = 1")` is `Err`, because `WHERE` must be a whole word. `ensure_where("INSERT INTO t(note) VALUES ('update')")` is `Ok`, because only the first word decides.
5. `auto_limit` adds the LIMIT:
   - `"SELECT * FROM t"` → `("SELECT * FROM t\nLIMIT 1000", true)`
   - `"SELECT * FROM t;"` → the same
   - `"SELECT * FROM t -- note"` → `("SELECT * FROM t -- note\nLIMIT 1000", true)`
6. `auto_limit` returns `(input, false)` for `"select * from t limit 5"`, `"SELECT 1; SELECT 2"`, `"PRAGMA table_info(\"t\")"` and `"WITH c AS (SELECT 1) SELECT * FROM c"`.

### Step 4 — D1 backend (`src-tauri/src/d1.rs`, plus commands)

- **Types** (`#[derive(Serialize)]` unless noted; field names exactly as written):
  - `pub struct D1Ctx { pub http: reqwest::Client, pub account_id: String, pub api_token: String }`, no derive
  - `#[derive(Serialize, Deserialize, Clone)] pub struct D1Database { pub uuid: String, pub name: String, pub created_at: Option<String>, pub jurisdiction: Option<String> }`
  - `pub struct TableInfo { pub name: String, pub kind: String /* "table" | "view" */, pub columns: Vec<ColumnInfo> }`
  - `pub struct ColumnInfo { pub name: String, pub col_type: String, pub not_null: bool, pub pk: bool }`
  - `pub struct QueryOutcome { pub columns: Vec<String>, pub rows: Vec<Vec<serde_json::Value>>, pub result_statement: Option<usize>, pub statement_count: usize, pub rows_read: u64, pub rows_written: u64, pub changes: u64, pub duration_ms: f64, pub limit_applied: bool }`
  - Private wire types, all `#[derive(Deserialize, Default)]` except `Envelope`, which derives only `Deserialize`:
    - `Envelope<T> { #[serde(default)] success: bool, #[serde(default)] errors: Vec<ApiMessage{code: i64, message: String}>, result: Option<T> }`
    - `pub struct RawStatement { results: Option<RawRows>, meta: Option<Meta> }`
    - `RawRows { #[serde(default)] columns: Vec<String>, #[serde(default)] rows: Vec<Vec<Value>> }`
    - `Meta { rows_read: Option<u64>, rows_written: Option<u64>, changes: Option<u64>, duration: Option<f64> }`
    Every field tolerates absence or null.
- **`fn parse_envelope<T: DeserializeOwned>(status: u16, body: &str) -> anyhow::Result<T>`**, a pure function:
  - Parse with `let env: Envelope<T> = serde_json::from_str(body).with_context(|| format!("Cloudflare API returned HTTP {status}: {}", <first 300 chars of body>))?;`.
  - `env.success` with `Some(result)` → `Ok(result)`.
  - Otherwise, `bail!("Cloudflare API error: {}", <errors as "{code}: {message}" joined with "; ">)`, or `bail!("Cloudflare API returned HTTP {status} without a result")` when `errors` is empty.
- **`async fn send<T: DeserializeOwned>(req: reqwest::RequestBuilder) -> anyhow::Result<T>`**:
  - `req.send().await.context("Could not reach the Cloudflare API")?`
  - `resp.text().await.context("Could not read the Cloudflare API response")?`
  - then `parse_envelope(status.as_u16(), &body)`
- **`pub async fn list_databases(ctx: &D1Ctx) -> anyhow::Result<Vec<D1Database>>`**:
  - Loop from `page = 1u32`: `send(ctx.http.get(format!("{BASE}/accounts/{}/d1/database", ctx.account_id)).query(&[("page", page), ("per_page", 10000)]).bearer_auth(&ctx.api_token)).await.with_context(|| format!("Listing D1 databases (page {page}) failed"))?`. `BASE` is `https://api.cloudflare.com/client/v4`.
  - Call `log_call!("D1 list databases page {page}")` for each page.
  - Stop when a page holds fewer than 10000 items, then sort by `name.to_lowercase()`.
- **`pub async fn raw(ctx: &D1Ctx, database_id: &str, sql: &str) -> anyhow::Result<Vec<RawStatement>>`**:
  - `send(ctx.http.post(format!("{BASE}/accounts/{}/d1/database/{database_id}/raw", ctx.account_id)).bearer_auth(&ctx.api_token).json(&serde_json::json!({"sql": sql}))).await`, then `log_call!("D1 raw ({} bytes)", sql.len())`.
  - The result is returned bare; callers add context.
  - This is the only way SQL is sent; the `batch` body form is not used.
- **`pub async fn load_schema(ctx: &D1Ctx, database_id: &str) -> anyhow::Result<Vec<TableInfo>>`**. Costs 2 calls, or 1 when there are no tables:
  1. `raw(ctx, database_id, "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY name;").await.with_context(|| format!("Listing tables of database {database_id} failed"))?`. `substr` avoids LIKE's `_` wildcard.
  2. Split the names into chunks of ≤ 100. For each chunk, call `raw` with the statements `PRAGMA table_info("<name with \" doubled>");` joined by `\n`, adding `.with_context(|| format!("Reading columns of database {database_id} failed"))?`. Result `i` belongs to table `i` of the chunk.
  3. Find the column indices of `name`, `type`, `notnull` and `pk` by name in `results.columns`. Set `not_null = notnull != 0` and `pk = pk != 0`; non-numbers count as 0.
  4. If the result count ≠ the chunk length, `bail!("D1 returned {got} PRAGMA results for {expected} tables")` (see Contingencies).
- **`pub async fn run_query(ctx: &D1Ctx, database_id: &str, sql: &str) -> anyhow::Result<QueryOutcome>`**:
  1. `anyhow::ensure!(!sql.trim().is_empty(), "Nothing to run.");`
  2. `sql_guard::ensure_where(sql)?;`. It runs before any network call, so blocked input costs 0 calls.
  3. `let (sql, limit_applied) = sql_guard::auto_limit(sql);`
  4. `let stmts = raw(ctx, database_id, &sql).await.context("D1 query failed")?;`
  5. `Ok(build_outcome(stmts, limit_applied))`
- **`pub fn build_outcome(stmts: Vec<RawStatement>, limit_applied: bool) -> QueryOutcome`**, a pure function:
  - Show the **last** statement whose `results.columns` is non-empty. `result_statement` is its 1-based index, or `None` with empty columns and rows if no statement returned columns.
  - `statement_count = stmts.len()`, the number of statements D1 actually ran.
  - Sum `rows_read`, `rows_written`, `changes` and `duration` (as `duration_ms`).
  - Convert cell values:
    - A JSON array whose elements are all integers 0–255 (a BLOB) becomes the string `x'<lowercase hex>'`. Show at most 256 bytes, then `…(<N> bytes)`.
    - Any other array or object becomes its JSON text.
    - Scalars and null pass through.
- **Tests** in `d1.rs`:
  - `parse_envelope::<Vec<RawStatement>>(400, r#"{"success":false,"errors":[{"code":7500,"message":"near \"SELEC\": syntax error"}],"messages":[],"result":null}"#)` is `Err`, and `format!("{:#}", err)` contains `7500: near "SELEC": syntax error`.
  - `build_outcome(stmts, false)` with two statements:
    - first: an UPDATE with empty columns, meta `changes: 2, rows_written: 2`
    - second: columns `["id","data"]`, rows `[[1,[1,255]],[2,null]]`, meta `rows_read: 2`
    - expected: columns `["id","data"]`, `rows[0][1] == "x'01ff'"`, `rows[1][1]` null, `result_statement == Some(2)`, `statement_count == 2`, `rows_read == 2`, `rows_written == 2`, `changes == 2`.
- **Commands** return `CmdResult`, with bodies like `Ok(d1::run_query(&state.d1_ctx()?, &database_id, &sql).await?)`:
  - `d1_list_databases(state) -> CmdResult<Vec<D1Database>>`
  - `d1_load_schema(state, database_id: String) -> CmdResult<Vec<TableInfo>>`
  - `d1_query(state, database_id: String, sql: String) -> CmdResult<QueryOutcome>`

### Step 5 — R2 backend (`src-tauri/src/r2.rs`, plus commands; read-only, no put/delete anywhere)

- **`pub fn make_client(account_id: &str, access_key_id: &str, secret: &str) -> aws_sdk_s3::Client`** is infallible and makes no network call. It uses `aws_sdk_s3::Config::builder()` with:
  - `.behavior_version(BehaviorVersion::latest())`
  - `.region(Region::new("auto"))`
  - `.endpoint_url(format!("https://{account_id}.r2.cloudflarestorage.com"))`
  - `.credentials_provider(Credentials::new(access_key_id, secret, None, None, "cf_explore"))`
  - `.force_path_style(true)`
  - `.request_checksum_calculation(RequestChecksumCalculation::WhenRequired)`
  - `.response_checksum_validation(ResponseChecksumValidation::WhenRequired)`

  Finish with `.build()`, then `Client::from_conf`.
- **Types** (`Serialize`):
  - `BucketInfo { name: String, created: Option<String> }`
  - `ListPage { prefixes: Vec<String>, objects: Vec<ObjectInfo>, next_token: Option<String> }`
  - `ObjectInfo { key: String, size: u64, last_modified: Option<String>, etag: Option<String> }`
- **`pub async fn list_buckets(client: &Client) -> anyhow::Result<Vec<BucketInfo>>`**:
  - `client.list_buckets().send().await.context("Listing R2 buckets failed")?` (1 Class A), then `log_call!("R2 ListBuckets")`.
  - Names come from `buckets()`, and `created` from `creation_date()` via `.fmt(DateTimeFormat::DateTime).ok()` (RFC 3339).
  - It makes a single call with no pagination; R2 returns up to 1000 buckets.
- **`pub async fn list_objects(client: &Client, bucket: &str, prefix: &str, token: Option<String>) -> anyhow::Result<ListPage>`**:
  - `list_objects_v2().bucket(bucket).delimiter("/").max_keys(1000)`, adding `.prefix(prefix)` only when `prefix` is non-empty and `.continuation_token(t)` when a token is given.
  - Then `.send().await.with_context(|| format!("Listing objects in {bucket}/{prefix} failed"))?` and `log_call!("R2 ListObjectsV2 {bucket}/{prefix}")`.
  - `prefixes` come from `common_prefixes()[*].prefix()`.
  - `objects` come from `contents()`, skipping any object whose key equals `prefix` (a folder placeholder):
    - `size` is `size().unwrap_or(0).max(0) as u64`
    - `last_modified` is formatted as RFC 3339
    - `etag` is `e_tag()` with the `"` characters trimmed
  - `next_token` is `next_continuation_token()` only when `is_truncated() == Some(true)`.
- **`pub async fn get_range(client: &Client, bucket: &str, key: &str, start: u64, end: u64) -> anyhow::Result<Vec<u8>>`**:
  - `ensure!(end >= start && end - start < 1_048_576, "Invalid byte range {start}-{end}")`.
  - `get_object().bucket(bucket).key(key).range(format!("bytes={start}-{end}")).send().await.with_context(|| format!("Reading bytes {start}-{end} of {bucket}/{key} failed"))?` (1 Class B), then `log_call!`.
  - Return `out.body.collect().await.with_context(|| format!("Reading the body of {bucket}/{key} failed"))?.into_bytes().to_vec()`.
- **`pub async fn download(client: &Client, bucket: &str, key: &str, dest: &Path) -> anyhow::Result<u64>`**:
  - `get_object()` with no range, then `.send().await.with_context(|| format!("Downloading {bucket}/{key} failed"))?` (1 Class B), then `log_call!`.
  - `let mut file = tokio::fs::File::create(dest).await.with_context(|| format!("Could not create {}", dest.display()))?;`
  - Stream inside an inner `async` block that returns `anyhow::Result<u64>`:
    - loop `while let Some(chunk) = body.try_next().await.with_context(|| format!("Downloading {bucket}/{key} failed"))? { file.write_all(&chunk).await.with_context(|| format!("Could not write {}", dest.display()))?; n += chunk.len() as u64 }`
    - then `file.flush()` with the same write context
    The object streams to disk and is never held in memory.
  - If the block returns `Err`, drop `file`, run `let _ = tokio::fs::remove_file(dest).await;` (best-effort cleanup of the partial file), then return the error.
- **Commands**, each `CmdResult`, getting the client from `state.s3()?`:
  - `r2_list_buckets(state) -> CmdResult<Vec<BucketInfo>>`
  - `r2_list_objects(state, bucket: String, prefix: String, continuation_token: Option<String>) -> CmdResult<ListPage>`
  - `r2_get_range(state, bucket: String, key: String, start: u64, end: u64) -> CmdResult<tauri::ipc::Response>`, which wraps `Response::new(bytes)`; JS receives an `ArrayBuffer`
  - `r2_download(state, bucket: String, key: String, dest: String) -> CmdResult<u64>`

### Step 6 — Native menu (`src-tauri/src/menu.rs`)

- **`pub fn build<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> anyhow::Result<tauri::menu::Menu<R>>`**:
  - File: `SubmenuBuilder::new(app, "File").text("file.settings", "Settings...").separator().text("file.exit", "Exit").build().context("Failed to build the File menu")?`
  - Edit:
    - on `#[cfg(target_os = "linux")]`: `.text("edit.cut", "Cut").text("edit.copy", "Copy").text("edit.paste", "Paste")`, custom items with **no accelerators**, so GTK never swallows Ctrl+X/C/V and the webview keeps handling them natively
    - on `#[cfg(not(target_os = "linux"))]`: `.cut().copy().paste()`, the built-in muda items, which are native on macOS and Windows
    - `.build().context("Failed to build the Edit menu")?`
  - Help: `.text("help.about", "About cf_explore")`, then `.build().context("Failed to build the Help menu")?`
  - Combine them with `MenuBuilder::new(app).items(&[&file, &edit, &help]).build().context("Failed to build the menu bar")`.
- **`pub fn on_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: tauri::menu::MenuEvent)`**: match `event.id().as_ref()`:
  - `"file.exit"` → `app.exit(0)`
  - `"file.settings"` → emit `"settings"`
  - `"help.about"` → emit `"about"`
  - `"edit.cut"`, `"edit.copy"`, `"edit.paste"` → emit `"cut"`, `"copy"`, `"paste"`
  - any other id → ignored

  Emit with `use tauri::Emitter;` and `if let Err(e) = app.emit("menu", payload).context("Failed to deliver the menu event") { eprintln!("[cf_explore] {e:#}"); }`. There is no UI to surface the failure in.
- **Wiring.**
  - The builder gets `.on_menu_event(menu::on_event)`.
  - In `setup`, after `app.manage(...)` and before the window is built, add `let menu = menu::build(app.handle())?; app.set_menu(menu).context("Failed to install the menu")?;`.
  - The window built next inherits the menu. `Builder::menu` is not used, because its closure must return `tauri::Result`.

### Step 7 — Frontend shell: styles, API layer, dialogs, menu handling, first run

1. **`src/main.ts`** imports `98.css/dist/98.css` (the package has no `exports` field), then `./styles/app.css`, then mounts `App.vue`.
2. **`src/types.ts`** holds TS interfaces that mirror the Rust structs field for field in snake_case: `Settings`, `SettingsStatus`, `D1Database`, `TableInfo`, `ColumnInfo`, `QueryOutcome`, `BucketInfo`, `ListPage`, `ObjectInfo`. It also holds `TreeNode { id: string; label: string; icon: IconName; depth: number; expandable: boolean; expanded: boolean; loading: boolean; data?: unknown }`. Command errors arrive as plain strings (the anyhow chain), so there is no error type.
3. **`src/api.ts`** holds typed `invoke` wrappers. Argument keys are camelCase, which Tauri maps to snake_case parameters:
   - `loadSettings()`
   - `saveSettings(settings)`, passing `{ settings }`
   - `d1ListDatabases()`
   - `d1LoadSchema(databaseId)`
   - `d1Query(databaseId, sql)`
   - `r2ListBuckets()`
   - `r2ListObjects(bucket, prefix, continuationToken: string | null)`
   - `r2GetRange(bucket, key, start, end)`, which returns `new Uint8Array(await invoke<ArrayBuffer>(...))`
   - `r2Download(bucket, key, dest)`
4. **`src/state.ts`** holds module-level refs and helpers:
   - `status = ref('Ready')`
   - `settingsStatus = ref<SettingsStatus>({settings: null, configured: false, r2_configured: false})`
   - `settingsVersion = ref(0)`, bumped after each successful save; both panels watch it to drop caches and reload
   - `errorDialog = ref<string | null>(null)`, holding the message to show
   - `showError(e: unknown)`: `errorDialog.value = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)`. Every error, including the D1 WHERE guard, uses this one modal.
   - `quoteIdent(name) => '"' + name.replace(/"/g, '""') + '"'`. Don't use `replaceAll`: the template's TS `lib` is ES2020, so `vue-tsc` would reject it.
   - `guardGridCopy(e: Event)`. Bind it as `@beforecopy` on **every** `VGrid`. It calls `e.preventDefault()` when the focused element is an `INPUT`, `TEXTAREA` or `SELECT` or is contentEditable, or when `window.getSelection()` holds a non-empty selection. Native copy of that text then proceeds instead of revo-grid's hijack.
5. **`src/icons.ts`** exports `ICONS: Record<IconName, string>`, a set of static 16×16 inline SVG strings drawn in Win98 colors (black outline, `#c0c0c0`, `#000080`, `#ffff80`):
   - `database`: a cylinder
   - `table`: a white grid with a navy header row
   - `view`: the table icon with a teal `#008080` header
   - `column`: a narrow bar
   - `bucket`: a pail
   - `folder`: yellow
   - `more`: three dots
   - `magnify`: a circle plus a handle, 14px
   - `download`: an arrow into a tray, 14px
   - `error`: a 32px red circle with a white ×
   They are rendered with `v-html`; these are constants, not user data.
6. **`src/components/Win98Dialog.vue`** is a modal wrapper:
   - props `title: string`, `width?: number` (default 380); emits `close`.
   - Markup: a `.modal-overlay` (fixed, full viewport, flex-centered, z-index 100) containing `.window` → `.title-bar` (`.title-bar-text` plus `.title-bar-controls > button[aria-label=Close]`) → `.window-body > <slot/>`.
   - Escape emits `close`.
7. **`src/App.vue`**:
   - **Tabs.** 98.css markup, `<menu role="tablist">` with two tabs: "D1" first and "R2" second. `tab = ref<'d1' | 'r2'>('d1')`, and `aria-selected` follows `tab`. The tab panel `.window[role=tabpanel]` contains `<D1Panel v-show="tab==='d1'"/>` and `<R2Panel v-show="tab==='r2'" :active="tab==='r2'"/>`. `v-show` keeps both grids mounted and their caches alive.
   - **Status bar.** A bottom `.status-bar > p.status-bar-field` bound to `status`.
   - **Dialogs.**
     - `<SettingsDialog v-if="showSettings">`.
     - About is a `Win98Dialog` with the title "About cf_explore" and three lines:
       - "cf_explore v{getVersion()}"
       - "A lightweight explorer for Cloudflare D1 databases and R2 buckets. Run SQL against D1 (UPDATE/DELETE require a WHERE clause) and browse, preview, and download R2 objects (read-only). Built with Tauri, Vue and Rust."
       - "Font: “MS Sans Serif” by lou (FontStruct), CC BY-SA 3.0."
       Close it with an OK button.
     - Error is a `Win98Dialog` titled "Error", shown while `errorDialog` is non-null. It shows `ICONS.error` and the message (`white-space: pre-wrap`), with an autofocused OK button that sets `errorDialog = null`.
   - **`onMounted`.**
     - Register `listen<string>('menu', e => ...)` from `@tauri-apps/api/event`:
       - `settings` sets `showSettings = true`
       - `about` opens About
       - `cut`, `copy` and `paste` call `runEditCommand(payload)`
     - Then run `settingsStatus.value = await loadSettings()`. If that fails, call `showError` and set `showSettings = true`. If `!configured`, set `showSettings = true` (the first-run popup) and set status to "Not configured: use File › Settings...".
   - **`runEditCommand(cmd)`** runs `if (!document.execCommand(cmd)) status.value = 'Clipboard command unavailable; use Ctrl+X / Ctrl+C / Ctrl+V'`. Copy reaches revo-grid's own TSV handler through the trusted `copy` event, so grid cells copy via the menu too.
8. **`src/components/SettingsDialog.vue`**:
   - Layout: a `Win98Dialog` titled "Settings" and 420 px wide. The form copies `settingsStatus.settings ?? empty`.
   - Fieldset "Cloudflare API (D1)":
     - `Account ID` (text)
     - `API token` (password)
     - hint: "Token needs Account › D1 › Edit permission."
   - Fieldset "R2 S3 API (optional)":
     - `Access Key ID` (text)
     - `Secret Access Key` (password)
     - hint: "Create keys under R2 › Manage API tokens; use Admin Read only so buckets can be listed."
   - Footer:
     - the note "Saved to ~/.config/cf_explore.json"
     - a `button.default` "OK" that submits the form; Enter also submits
     - a "Cancel" button that emits close
   - On OK, call `saveSettings(form)`:
     - success: assign `settingsStatus`, `settingsVersion++`, set status to "Settings saved", then close
     - failure: show the error string inline in red and keep the dialog open
9. **`src/styles/app.css`**, the essentials:
   - Page:
     - `html, body, #app { height: 100%; margin: 0 }`
     - `body { background: #c0c0c0; font: 11px "Pixelated MS Sans Serif", Arial, sans-serif; overflow: hidden }`
     - `#app` is a flex column with 4px padding: tabs, then the tab panel (`flex: 1; min-height: 0`), then the status bar.
   - Panels:
     - `.panel { display: flex; gap: 4px; height: 100% }`
     - `.sidebar { width: 260px; min-width: 180px; display: flex; flex-direction: column }`
     - `.tree-box { flex: 1; min-height: 0; background: #fff }`
     - `.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px }`
     - `.toolbar { display: flex; align-items: center; gap: 6px }`
   - Editor and grid:
     - `.sql-editor { height: 160px; resize: vertical; font: 12px "Courier New", monospace }`
     - `.grid-box { flex: 1; min-height: 0 }` and `.grid-box revo-grid { height: 100% }`
   - `.icon-btn { min-width: 0; width: 22px; height: 18px; padding: 0; display: inline-flex; align-items: center; justify-content: center }`. This overrides 98.css's 75px button min-width.
   - Null cells: `.cell-null { color: #808080; font-style: italic } .cell-null::after { content: "NULL" }`.
   - Grid theme: `.win98-grid revo-grid[theme] { --revo-grid-font-family: "Pixelated MS Sans Serif", Arial; --revo-grid-font-size: 11px; --revo-grid-header-bg: #c0c0c0; --revo-grid-header-color: #222; --revo-grid-header-border: #808080; --revo-grid-cell-border: #dfdfdf; --revo-grid-selection-border: #000080; --revo-grid-row-headers-bg: #c0c0c0 }`. The `[theme]` selector beats revo-grid's injected theme CSS on specificity. Header cells also get the 98.css raised bevel: `box-shadow: inset -1px -1px #0a0a0a, inset 1px 1px #fff, inset -2px -2px #808080, inset 2px 2px #dfdfdf`. These rules are purely visual.

### Step 8 — Virtualized tree (`src/components/TreeView.vue`, shared by both tabs)

- **API.** Props `rows: TreeNode[]` (already flattened, visible rows only) and `selectedId: string | null`. Emits `toggle(node)`, `select(node)` and `activate(node)`.
- **Virtualizer.** `useVirtualizer(computed(() => ({ count: props.rows.length, getScrollElement: () => scrollRef.value, estimateSize: () => 20, overscan: 10, getItemKey: (i) => props.rows[i].id })))`. The options must be a `computed` so `count` stays reactive.
- **Markup.** The scroll container is `overflow: auto; height: 100%`. Inside it, a spacer `div` has `height = getTotalSize()`. Each absolutely positioned row uses `transform: translateY(start px)`, `height: 20px` and `padding-left: depth*16 + 4 px`, and contains:
  - a 9×9 bordered twisty `+` / `−` when `expandable`, which on `@click.stop` emits `toggle`; otherwise a 9px spacer
  - `<span v-html="ICONS[icon]">`
  - a label `<span>`, with `" (loading…)"` appended when `loading`. A selected row's label gets `background: #000080; color: #fff`.
- **Mouse.** Clicking a row emits `select`; double-clicking emits `activate`. No keyboard navigation.

### Step 9 — D1 tab (`src/components/D1Panel.vue` + `src/components/ResultGrid.vue`)

- **State.**
  - `databases = ref<D1Database[]>([])`
  - `schemas = reactive(new Map<string, TableInfo[]>())`, keyed by database uuid
  - `expanded = reactive(new Set(['root']))`
  - `loading = reactive(new Set<string>())`
  - `selectedId = ref('root')`
  - `activeDbId = ref<string | null>(null)`
  - `sqlText = ref('')`
  - `result = shallowRef<{columns: string[]; rows: unknown[][]}>({columns: [], rows: []})`
  - `running = ref(false)`
- **Tree rows** (a `computed`; node ids are stable strings):
  - `root`: "D1 Databases", depth 0, expandable, icon `database`.
  - `db:<uuid>`: the database name, depth 1, expandable, `data {dbId}`.
  - `tbl:<uuid>:<table>`: depth 2, icon `table` or `view` by `kind`, expandable when it has columns, `data {dbId, table}`.
  - `col:<uuid>:<table>:<col>`: depth 3, icon `column`, label `"<name> <col_type>"` plus `" (PK)"` when `pk`, `data {dbId}`.
  - A node's children appear only while its id is in `expanded`.
- **Behavior.**
  - **Load:** `watch([() => settingsStatus.value.configured, settingsVersion], ..., {immediate: true})`. When configured: clear `schemas`, `expanded` (back to `{'root'}`), `databases` and `activeDbId`, then `loadDatabases()`. That function does `databases = await d1ListDatabases()` (1 call) and sets status to `"<n> databases"`. Errors go to `showError`.
  - **toggle:** collapse if the node is expanded. For an unloaded `db:` node: add it to `loading`, `schemas.set(dbId, await d1LoadSchema(dbId))` (2 calls), then expand. Otherwise just expand. Expanding a table never makes a call.
  - **select:** set `selectedId`. If the node carries a `dbId`, set `activeDbId = dbId`.
  - **activate** (double-click):
    - `tbl:` node: `sqlText = 'SELECT * FROM ' + quoteIdent(table) + ' LIMIT 100;'`, set `activeDbId`, then `run()`.
    - `root` or `db:` node: `toggle`.
  - **Refresh button** above the tree: with `root` selected, re-run `loadDatabases()` and clear all schemas and expansion, keeping `root`. With a database or one of its children selected, re-fetch only that database's schema and keep its expansion.
- **Main area, top to bottom:**
  - A toolbar with `button.default` "Run" (disabled while `running`), the hint text "Ctrl+Enter", and `Database: <select v-model="activeDbId">`. The select has an empty option "(select a database)" plus every database (value uuid, label name).
  - `<textarea ref="editor" class="sql-editor" v-model="sqlText" spellcheck="false">` with `@keydown.ctrl.enter.prevent="run"` and `@keydown.meta.enter.prevent="run"`.
  - `<div class="grid-box win98-grid"><ResultGrid :columns :rows/></div>`.
- **`run()`**:
  1. `const ta = editor.value; const text = ta.selectionStart !== ta.selectionEnd ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : ta.value;`. A non-empty selection runs only the selection.
  2. With no `activeDbId`, call `showError('Select a database in the tree (or the Database list) first.')`.
  3. Set `running`, set status to "Running…", then `const o = await d1Query(activeDbId, text)` (1 call, or 0 when blocked).
  4. Set `result = {columns: o.columns, rows: o.rows}`.
  5. Set the status:
     - If there are columns: `"<rows.length> row(s)" + (o.limit_applied ? " (auto LIMIT 1000)" : "") + " · read <rows_read> · written <rows_written> · <duration_ms.toFixed(1)> ms"`.
     - If there are none: `"Executed <statement_count> statement(s) · <changes> row(s) changed · read … · written … · … ms"`.
     - If `statement_count > 1 && result_statement`, prefix `"Showing result of statement <k> of <n> · "`.
  6. Errors go to `showError(e)` and appear in the Error modal. That includes the WHERE guard's `UPDATE without a WHERE clause would change every row, so nothing was sent to D1 (statement 1).`.
- **`ResultGrid.vue`**:
  - Props `columns: string[]` and `rows: unknown[][]`.
  - `gridColumns = shallowRef` rebuilt on every new result. A new array resets the sort.
    - Each entry is `{ prop: 'c' + i, name, size: 150, minSize: 50, sortable: true, cellProperties: ({model, prop}) => model[prop] === null ? {class: {'cell-null': true}} : {} }`.
    - Synthetic `c<i>` props make duplicate or odd column names safe.
  - `gridSource = shallowRef(rows.map(r => Object.fromEntries(r.map((v, i) => ['c' + i, v]))))`.
  - Render `<VGrid :source="gridSource" :columns="gridColumns" :readonly="true" :range="true" :resize="true" :row-headers="true" theme="default" :row-size="22" @beforecopy="guardGridCopy" style="height:100%"/>`, with `import VGrid from '@revolist/vue3-datagrid'`. Always bind VGrid booleans explicitly (`:x="true"`): a bare attribute may reach the Stencil wrapper as `""`, which is falsy. Do not set `hide-attribution`.

### Step 10 — R2 tab (`src/components/R2Panel.vue` + `src/components/PreviewWindow.vue` + `src/format.ts`)

- **`src/format.ts`** holds pure helpers:
  - `formatBytes(n)`: under 1024 gives `"<n> B"`; otherwise KB, MB or GB with one decimal place, 1024-based.
  - `hexDump(bytes)`: one line per 16 bytes, formatted as `offset(8 hex)` + two spaces + 16 space-separated hex bytes (with an extra space after the 8th) + two spaces + `|ascii|`. Bytes 0x20–0x7e print as themselves; everything else prints as `.`.
  - `decodePreview(bytes, truncated)`:
    - Try `new TextDecoder('utf-8', {fatal: true})` on `bytes`. When `truncated`, retry with the last 1, 2 or 3 bytes cut off, to drop a split code point.
    - Successful text with no `\u0000` → `{kind: 'text', text}`.
    - Otherwise → `{kind: 'hex', text: hexDump(bytes)}`.
- **R2Panel state.**
  - prop `active: boolean`
  - `buckets = ref<BucketInfo[] | null>(null)`
  - `listings = reactive(new Map<string, {prefixes: string[]; objects: ObjectInfo[]; nextToken: string | null; loading: boolean}>())`, keyed by `` `${bucket}\u0000${prefix}` ``
  - `expanded = reactive(new Set(['root']))`
  - `selectedId = ref('root')`
  - `current = ref<{bucket: string; prefix: string} | null>(null)`
  - `previewTarget = ref<{bucket: string; key: string; size: number; etag: string | null} | null>(null)`
- **Loading.**
  - Bucket list: `watch([() => props.active, () => settingsStatus.value.configured, settingsVersion], ...)`. When `active && configured && r2_configured && buckets === null`, run `buckets = await r2ListBuckets()` (1 Class A per session).
  - Settings change: a `settingsVersion` change first resets `buckets = null` and clears `listings`, `expanded` (back to `{'root'}`), `current` and `previewTarget`.
  - Without `r2_configured`, the sidebar shows the text "R2 credentials are not configured. Use File › Settings... to add them." and no calls are made.
- **Tree rows.**
  - `root`: "R2 Buckets", icon `bucket`, depth 0.
  - `b:<bucket>`: depth 1, icon `bucket`, `data {bucket, prefix: ''}`.
  - `p:<bucket>\u0000<prefix>`: for each loaded listing's `prefixes` under an expanded node, recursively. Icon `folder`, label is the prefix minus its parent prefix (for example `photos/`), `data {bucket, prefix}`.
  - `more:<bucket>\u0000<prefix>`: added as the last child when `nextToken` is set. Label `(more…)`, icon `more`, `data {bucket, prefix, more: true}`.
- **`loadListing(bucket, prefix, more = false)`**:
  - Skip if the listing is already `loading`, if `!more` and it already exists, or if `more` and it has no `nextToken`. This in-flight de-duplication is the cache.
  - Call `r2ListObjects(bucket, prefix, more ? nextToken : null)` (1 Class A).
  - Append `prefixes` and `objects` and replace `nextToken`.
  - Set status to `"<objects> objects, <prefixes> folders" + (nextToken ? " (more available)" : "")`.
- **Tree actions.**
  - toggle on a bucket or folder: if not loaded, `await loadListing`; then expand or collapse.
  - select on a bucket or folder: set `current = {bucket, prefix}` and `loadListing(bucket, prefix)`; a cached listing makes no call.
  - select or activate on a `more:` node: `loadListing(bucket, prefix, true)`.
  - Refresh button: with `root` selected, reset as on a settings change and reload buckets. With a bucket or folder selected, delete every listing whose key starts with `` `${bucket}\u0000${prefix}` `` and every `expanded` id that starts with `` `p:${bucket}\u0000${prefix}` `` (except the node's own id), then `loadListing(bucket, prefix)` (1 call).
- **Right side.**
  - Path label: `"<bucket>/<prefix>"`, or "Select a bucket or folder" when nothing is selected.
  - Grid: `<div class="grid-box win98-grid"><VGrid :source="objectRows" :columns="objectColumns" :readonly="true" :resize="true" theme="default" :row-size="22" @beforecopy="guardGridCopy" style="height:100%"/></div>`. `objectRows` is a `computed` over the current listing.
    - Source: the current listing's objects mapped to `{name: key.slice(prefix.length), size, last_modified, key, etag}`.
    - Name: `prop name`, size 320, sortable.
    - Size: `prop size`, size 100, sortable on the raw number. Shown via `cellTemplate: (h, p) => h('span', formatBytes(p.model.size))`.
    - Last Modified: `prop last_modified`, size 190, sortable. ISO strings sort chronologically.
    - Actions: `prop key`, size 64, `sortable: false`. Its cellTemplate returns `h('span', {class: 'obj-actions'}, [h('button', {class: 'icon-btn', title: 'Preview', innerHTML: ICONS.magnify, onClick: () => openPreview(p.model)}), h('button', {class: 'icon-btn', title: 'Download', innerHTML: ICONS.download, onClick: () => download(p.model)})])`.
  - When the current listing has `nextToken`, a `Load more…` button sits under the grid and calls `loadListing(bucket, prefix, true)`.
- **`openPreview(row)`**: set `previewTarget = {bucket, key, size, etag}`.
- **`download(row)`**:
  1. Build `defaultPath` from `name = row.key.split('/').pop() || 'download'`: `await join(await downloadDir(), name)`, or just `name` if `downloadDir()` throws. Then `const dest = await save({ title: 'Download object', defaultPath })`, using `save` from `@tauri-apps/plugin-dialog` and `join`/`downloadDir` from `@tauri-apps/api/path`. A `null` result does nothing.
  2. Set status to `"Downloading <key>…"`.
  3. `const n = await r2Download(bucket, key, dest)`, then set status to `"Saved <key> to <dest> (<formatBytes(n)>)"`. Errors go to `showError`.
- **`PreviewWindow.vue`**, the non-modal floating window, one at a time. R2Panel renders it inside its single root `div` as `<PreviewWindow v-if="previewTarget" :target="previewTarget" @close="previewTarget = null"/>`. D1Panel and R2Panel each need a single root element so `v-show` from App.vue applies.
  - **Props and events.** Prop `target` (nullable); emits `close`.
  - **Markup.** `.window.floating-window` with `position: fixed; z-index: 50; resize: both; overflow: hidden; display: flex; flex-direction: column; min-width: 320px; min-height: 200px`. It opens at 640×420, centered and clamped to the viewport, and keeps its position when the target changes.
  - **Title bar.** It reads `Preview — <key>`, plus a Close button that emits `close`.
  - **Drag.** `pointerdown` on `.title-bar` (but not on its buttons) records the pointer offset and calls `setPointerCapture`. `pointermove` sets left/top, clamped so the title bar stays reachable: `top ∈ [0, innerHeight-24]` and `left ∈ [60-width, innerWidth-60]`. `pointerup` releases. There is no overlay, so the tree and grid stay interactive.
  - **Body.** An info line `"Showing <loaded> of <size> bytes · <Text (UTF-8) | Hex>"`. Next comes the link `<a href="#" @click.prevent="showMore">Show More...</a>`, shown only when `loaded < min(size, 1048576)`. For `size > 1048576` the note "Only the first 1 MiB is shown; use Download for the full object." appears once loading has reached 1 MiB. Below that is a white sunken `<pre>` (`flex: 1; overflow: auto; margin: 0; white-space: pre-wrap`) showing the decoded text or hex.
  - **Loading.** On every `target` change:
    - `size === 0`: show "(empty object)" and make no call; a Range GET on 0 bytes would return 416.
    - Otherwise: look up the module-level `previewCache: Map<string, Uint8Array>`, keyed by `` `${bucket}\n${key}\n${etag}` ``. On a miss, call `r2GetRange(bucket, key, 0, Math.min(size, 4096) - 1)` (1 Class B).
  - **Show More.** `showMore` calls `r2GetRange(bucket, key, loaded, Math.min(size, 1048576) - 1)` (1 Class B) and concatenates the result.
  - **Cache.** Store bytes in the cache after every load. When there are more than 16 entries, delete the oldest (the first key in Map order).
  - **Stale responses.** A `requestSeq` counter discards responses that come back for a target that is no longer current; those bytes are still cached.
  - **Decoding.** Decode with `decodePreview(bytes, loaded < size)`.

## Critical files & anchors

- `src-tauri/src/lib.rs` `run()`: `.plugin(tauri_plugin_dialog::init())`, `.on_menu_event(menu::on_event)`, one `generate_handler![load_settings, save_settings, d1_list_databases, d1_load_schema, d1_query, r2_list_buckets, r2_list_objects, r2_get_range, r2_download]`, and `.setup`. Inside `setup`, in this order: `app.manage(AppState::new()?)`, `menu::build` + `app.set_menu`, then the window built with `enable_clipboard_access`.
- `src-tauri/tauri.conf.json` `app.windows[0]`: `"create": false` is required. Without it, Tauri builds a second, clipboard-less window.
- `src-tauri/src/sql_guard.rs` `ensure_where` / `auto_limit`: the only guard against an UPDATE or DELETE without WHERE, and the only place auto-LIMIT is applied. `d1::run_query` calls them before any network call.
- `src/state.ts` `guardGridCopy`: without it, revo-grid's document-level `copy` listener blanks Ctrl+C in the SQL editor whenever a grid cell is focused.
- `src/components/PreviewWindow.vue`: the 4096 / 1 MiB range math and the `size === 0` short-circuit.

## Verification

Run everything from `/home/wspeirs/src/cf_explore` unless noted otherwise.

1. **Unit tests.** Run `cd src-tauri && cargo test`. All `sql_guard` tests (Step 3, tests 1–6) and both `d1` tests pass.
2. **Frontend build.** `npm run build` passes `vue-tsc --noEmit` and `vite build` with no errors.
3. **Backend smoke (throwaway).** This needs real credentials in `~/.config/cf_explore.json`. If the file is missing, ask the user to start `npm run tauri dev` and fill in the first-run Settings dialog.
   - Create `src-tauri/examples/smoke.rs`. Its `fn main() -> anyhow::Result<()>` runs `tauri::async_runtime::block_on(async { … })`, adding `.context(...)` on each step, and:
     - loads the file with `cf_explore_lib::settings::load` at `$HOME/.config/cf_explore.json`
     - builds `cf_explore_lib::d1::D1Ctx { http: reqwest::Client::new(), .. }`
     - prints the names from `d1::list_databases`
     - prints `d1::run_query(first, "SELECT 1 AS one")`; expected: columns `["one"]`, rows `[[1]]`, `limit_applied: true`
     - prints `d1::run_query(first, "DELETE FROM x")` as `{:#}`; expected: text starting with `DELETE without a WHERE clause` and **no** `[cf_explore] API call` line after it
     - if R2 keys are present, prints the bucket names from `r2::list_buckets(&r2::make_client(..))`
   - Run `cd src-tauri && cargo run --example smoke`, then delete the file.
4. **GUI smoke.** Start `npm run tauri dev` as a long-running process. Every `[cf_explore] API call:` line in the terminal is one Cloudflare request, and the call counts below are checked against those lines. The UI steps need the user at the keyboard.
   1. **First run.** `mv ~/.config/cf_explore.json ~/.config/cf_explore.json.bak` if it exists, then launch. The Settings dialog appears automatically over the selected D1 tab, with 0 calls so far. Enter credentials and click OK:
      - `stat -c %a ~/.config/cf_explore.json` prints `600`
      - exactly 1 `D1 list databases page 1` line
      - databases appear under "D1 Databases"
   2. **Expand a database:** exactly 2 calls. Tables, views and columns appear, with no `_cf_KV` or `sqlite_*`. Collapsing and expanding again makes 0 calls.
   3. **Double-click a table:** the editor shows `SELECT * FROM "<table>" LIMIT 100;`, 1 call, and the grid shows the real column names with NULLs as grey `NULL`.
   4. **Auto-LIMIT:** `SELECT * FROM <table>` → Run → the status includes `(auto LIMIT 1000)`. `SELECT * FROM <table> LIMIT 5` → no such text.
   5. **WHERE guard:**
      - `UPDATE <table> SET <col> = <col>` → the Error modal reads `UPDATE without a WHERE clause would change every row, so nothing was sent to D1 (statement 1).`, with **0** calls
      - `delete from <table>` → blocked (case-insensitive). `SELECT 1; DELETE FROM <table>` → blocked with `(statement 2)` and 0 calls
      - `UPDATE <table> SET <col> = <col> WHERE 1=0` → 1 call, and the status shows `0 row(s) changed`
   6. **Multiple statements and selection:** `SELECT 1; SELECT 2 AS two` → 1 call; the grid shows column `two` and the status says statement 2 of 2. Selecting only `SELECT 1` and running → the grid shows column `1`.
   7. **Edit menu (Linux):** Edit › Copy, then Edit › Paste elsewhere in the editor, duplicates the text. Edit › Cut removes the selection. Select grid cells, then Edit › Copy, then Ctrl+V into the editor: the values arrive tab-separated. With a grid cell focused, click into the editor, select text and press Ctrl+C, then Ctrl+V: the editor text comes back (the guard works).
   8. **R2 listing:**
      - opening the R2 tab for the first time → 1 ListBuckets call
      - expanding a bucket → 1 call, folders show in the tree and objects in the grid
      - reselecting the same folder → 0 calls
      - a prefix with more than 1000 entries → "Load more…" makes 1 call and appends
   9. **Preview:**
      - Magnifier on a text object larger than 4 KiB → the floating window shows `Showing 4096 of …` (1 call). Show More... → up to 1 MiB (1 call) and the link disappears; for objects over 1 MiB the 1 MiB note appears.
      - Reopening the same object → 0 calls.
      - A binary object shows a hex dump. A 0-byte object shows "(empty object)" with 0 calls.
      - The window drags by its title bar, and the tree and grid stay clickable while it is open.
   10. **Download:** the download icon opens the native Save dialog, prefilled with `~/Downloads/<name>`, and makes 1 call. `stat -c %s <file>` equals the Size shown in the grid.
   11. **Menus:** Help › About shows the description modal. File › Settings... reopens Settings with the values filled in. File › Exit quits.

## Assumptions & contingencies

**Assumptions (you can override these):**
- Linux on Wayland is the verified platform. macOS and Windows compile with muda's built-in native Cut/Copy/Paste but are not verified. On macOS, the first submenu ("File") is shown under the app name.
- Secrets are stored in plain JSON, mode 0600, at the literal path `$HOME/.config/cf_explore.json` on every OS. No OS keychain is used.
- The R2 key pair is optional; D1 needs only the Account ID and API token.
- Only default-jurisdiction R2 buckets are listed. Covering EU, FedRAMP and US would cost three extra Class A ListBuckets calls per session.
- Result grids are read-only; data changes only through SQL.
- A multi-statement run shows the last statement that returned columns.
- The WHERE guard is a word scan, chosen for simplicity:
  - Statements are split on every `;`, including any inside string literals.
  - Only statements whose **first word** is UPDATE or DELETE are checked. A statement that starts with a comment, or a `WITH … DELETE`, is not checked.
  - A `WHERE` word anywhere in the statement satisfies the check, even inside a comment or string.
- Auto-LIMIT follows the same idea. It applies only when the input has no `;` other than trailing ones, its first word is SELECT, and the word LIMIT appears nowhere. `WITH … SELECT` is not limited.
- Preview shows UTF-8 text or a hex dump; images are not rendered.

**Contingencies, decided in advance:**
- **Linux Edit menu.** If `document.execCommand('copy'|'cut'|'paste')` returns false or does nothing even with `enable_clipboard_access()`:
  - Add `tauri-plugin-clipboard-manager@2` and `@tauri-apps/plugin-clipboard-manager@^2`, with the capability permissions `clipboard-manager:allow-read-text` and `clipboard-manager:allow-write-text`.
  - In `runEditCommand`:
    - copy: `writeText(sel)`, where `sel` is the focused input/textarea `value.slice(selectionStart, selectionEnd)`, falling back to `window.getSelection()?.toString()`
    - cut: the same `writeText`, then `document.execCommand('delete')` when the focused element is an editable input or textarea
    - paste: `readText()`, then `document.execCommand('insertText', false, text)` into a focused editable input or textarea
  - Grid cells then copy via Ctrl+C only.
- **PRAGMA result count.** If D1 returns fewer `/raw` results than there are `;`-joined PRAGMA statements, send each schema chunk as `{"batch": [{"sql": "PRAGMA table_info(\"t\")"}, …]}` instead; that body form is documented.
- **Empty icon buttons.** If the `innerHTML` icon buttons in the revo-grid cellTemplate render empty, use the child `h('img', {src: 'data:image/svg+xml,' + encodeURIComponent(svg), width: 14, height: 14})`.
- **Scaffold differences.** If the `create-tauri-app` output uses different file names, apply the same edits to the equivalents: the Rust `run()` entry and the window entry in tauri.conf.json.
