//! Live R2 diagnostics. Run: cargo test --test r2_live -- --ignored --nocapture
//! Reads ~/.config/cf_explore.json. Never prints credential values.
use aws_sdk_s3::error::ProvideErrorMetadata;
use cf_explore_lib::{r2, settings};

fn describe<E: ProvideErrorMetadata + std::fmt::Debug, R: std::fmt::Debug>(
    e: &aws_smithy_runtime_api::client::result::SdkError<E, R>,
) -> String {
    use aws_smithy_runtime_api::client::result::SdkError::*;
    match e {
        ServiceError(se) => format!(
            "service error: code={:?} message={:?} raw={:?}",
            se.err().code(),
            se.err().message(),
            se.raw()
        ),
        other => format!("{other:?}"),
    }
}

fn shape(label: &str, v: &str) {
    println!(
        "{label}: len={} hex={} ws_or_quote={}",
        v.len(),
        v.chars().all(|c| c.is_ascii_hexdigit()),
        v.chars().any(|c| c.is_whitespace() || c == '"' || c == '\'')
    );
}

#[test]
#[ignore]
fn live_r2() {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(run());
}

async fn run() {
    let path = std::env::home_dir().unwrap().join(".config/cf_explore.json");
    let s = settings::load(&path).unwrap().expect("settings file missing");
    shape("account_id", &s.account_id);
    shape("r2_access_key_id (expect 32 hex)", &s.r2_access_key_id);
    shape("r2_secret_access_key (expect 64 hex)", &s.r2_secret_access_key);
    println!(
        "access_key_id == api_token? {}",
        s.r2_access_key_id == s.api_token
    );

    let client = r2::make_client(&s.account_id, &s.r2_access_key_id, &s.r2_secret_access_key);

    let mut buckets: Vec<String> = vec![];
    match client.list_buckets().send().await {
        Ok(out) => {
            buckets = r2::to_buckets(&out).into_iter().map(|b| b.name).collect();
            println!("ListBuckets OK: {buckets:?}");
        }
        Err(e) => println!("ListBuckets FAILED: {}", describe(&e)),
    }

    // Fall back to the Cloudflare REST API to discover buckets for per-bucket probes.
    if buckets.is_empty() {
        let url = format!(
            "https://api.cloudflare.com/client/v4/accounts/{}/r2/buckets",
            s.account_id
        );
        let r = reqwest::Client::new()
            .get(url)
            .bearer_auth(&s.api_token)
            .send()
            .await
            .unwrap();
        let status = r.status();
        let body: serde_json::Value = r.json().await.unwrap_or_default();
        println!("REST list buckets status={status} errors={}", body["errors"]);
        if let Some(a) = body["result"]["buckets"].as_array() {
            buckets = a.iter().filter_map(|b| b["name"].as_str().map(String::from)).collect();
            println!("REST buckets: {buckets:?}");
        }
    }

    // Bucket-scoped keys can't ListBuckets; probe a known bucket: R2_TEST_BUCKET=name
    if let Ok(b) = std::env::var("R2_TEST_BUCKET") {
        buckets.push(b);
    }

    for b in &buckets {
        match client.list_objects_v2().bucket(b).max_keys(1).send().await {
            Ok(o) => println!("ListObjectsV2 {b} OK (key_count={:?})", o.key_count()),
            Err(e) => println!("ListObjectsV2 {b} FAILED: {}", describe(&e)),
        }
    }
}
