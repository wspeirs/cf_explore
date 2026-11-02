# cf_explore

A small desktop explorer for Cloudflare **D1** databases and **R2** buckets, built with Tauri 2, Vue 3 and Rust, styled after Windows 98.

- **D1:** browse databases, tables, views and columns; run any SQL.
  - `UPDATE` / `DELETE` without a `WHERE` word are blocked before anything is sent.
  - A lone `SELECT` without `LIMIT` gets `LIMIT 1000` appended.
  - Double-clicking a table runs `SELECT * FROM "<table>" LIMIT 100;`.
- **R2 (read-only):** browse buckets and folders, preview an object (first 4096 bytes, "Show More..." up to 1 MiB; text or hex dump) and download objects. There is no upload, delete or copy anywhere in the code.

Every design choice keeps billable and rate-limited Cloudflare calls to a minimum: everything loads lazily, listings and previews are cached in memory, nothing polls, and no HEAD requests are made. Debug builds print one `[cf_explore] API call: ...` line to stderr per outbound Cloudflare request.

## Settings

File › Settings... (shown automatically on first run) stores four values in `~/.config/cf_explore.json` (plain JSON, mode `0600`):

| Field | Needed for | Notes |
|---|---|---|
| Account ID | D1 and R2 | the 32-character hex ID from the Cloudflare dashboard |
| API token | D1 | needs Account › D1 › Edit |
| R2 Access Key ID / Secret Access Key | R2 | optional, but both or neither; create them under R2 › Manage API tokens |

No OS keychain is used, so the secrets are stored in plain text.

## Requirements

- Node.js 20.19 or newer and npm
- Rust 1.94.1 or newer (the `aws-sdk-s3` MSRV)
- On Linux, the Tauri system libraries:
  `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

## Develop

```sh
npm install
npm run tauri dev     # run the app with hot reload
npm run tauri build   # bundle a release build
```

## Test

```sh
npm test                    # frontend unit tests (vitest)
npm run build               # type-check (vue-tsc) and bundle the frontend
cd src-tauri && cargo test  # backend unit tests
```

Neither suite talks to Cloudflare: the network-facing code is covered through its pure parts (envelope parsing, outcome building, SQL guard, listing/response mapping, range validation). Exercising the real D1/R2 APIs needs your own credentials.

## Known limits

- The `WHERE` guard and auto-`LIMIT` are whole-word scans, not a SQL parser: statements are split on every `;` (even inside string literals), only a statement whose first word is `UPDATE` or `DELETE` is checked, and a `WHERE` word anywhere in the statement (even in a comment) satisfies it. Auto-`LIMIT` applies only to a single statement whose first word is `SELECT`.
- Only default-jurisdiction R2 buckets are listed.
- Result grids are read-only; data changes only through SQL.
- Linux on Wayland is the platform this was built on. macOS and Windows use the native Cut/Copy/Paste menu items but have not been tried.

## Credits

The UI uses [98.css](https://github.com/jdan/98.css), which bundles the "Pixelated MS Sans Serif" font: "MS Sans Serif" by lou (FontStruct), licensed CC BY-SA 3.0.
