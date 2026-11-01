use std::path::Path;
use anyhow::Context;
use tokio::io::AsyncWriteExt;

pub fn make_client(account_id: &str, access_key_id: &str, secret: &str) -> aws_sdk_s3::Client {
    let conf = aws_sdk_s3::Config::builder()
        .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
        .region(aws_sdk_s3::config::Region::new("auto"))
        .endpoint_url(format!("https://{account_id}.r2.cloudflarestorage.com"))
        .credentials_provider(aws_sdk_s3::config::Credentials::new(
            access_key_id,
            secret,
            None,
            None,
            "cf_explore",
        ))
        .force_path_style(true)
        .request_checksum_calculation(
            aws_sdk_s3::config::RequestChecksumCalculation::WhenRequired,
        )
        .response_checksum_validation(
            aws_sdk_s3::config::ResponseChecksumValidation::WhenRequired,
        )
        .build();

    aws_sdk_s3::Client::from_conf(conf)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BucketInfo {
    pub name: String,
    pub created: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ListPage {
    pub prefixes: Vec<String>,
    pub objects: Vec<ObjectInfo>,
    pub next_token: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ObjectInfo {
    pub key: String,
    pub size: u64,
    pub last_modified: Option<String>,
    pub etag: Option<String>,
}

pub async fn list_buckets(client: &aws_sdk_s3::Client) -> anyhow::Result<Vec<BucketInfo>> {
    let out = client
        .list_buckets()
        .send()
        .await
        .context("Listing R2 buckets failed")?;
    crate::log_call!("R2 ListBuckets");

    let buckets = out
        .buckets()
        .iter()
        .map(|b| BucketInfo {
            name: b.name().unwrap_or_default().to_string(),
            created: b
                .creation_date()
                .and_then(|dt| dt.fmt(aws_sdk_s3::primitives::DateTimeFormat::DateTime).ok()),
        })
        .collect();

    Ok(buckets)
}

pub async fn list_objects(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    prefix: &str,
    token: Option<String>,
) -> anyhow::Result<ListPage> {
    let mut req = client
        .list_objects_v2()
        .bucket(bucket)
        .delimiter("/")
        .max_keys(1000);

    if !prefix.is_empty() {
        req = req.prefix(prefix);
    }

    if let Some(t) = token {
        req = req.continuation_token(t);
    }

    let out = req
        .send()
        .await
        .with_context(|| format!("Listing objects in {bucket}/{prefix} failed"))?;
    crate::log_call!("R2 ListObjectsV2 {bucket}/{prefix}");

    let prefixes = out
        .common_prefixes()
        .iter()
        .filter_map(|cp| cp.prefix().map(|s| s.to_string()))
        .collect();

    let mut objects = Vec::new();
    for obj in out.contents() {
        let key = obj.key().unwrap_or_default();
        if key == prefix {
            continue;
        }
        let size = obj.size().unwrap_or(0).max(0) as u64;
        let last_modified = obj
            .last_modified()
            .and_then(|dt| dt.fmt(aws_sdk_s3::primitives::DateTimeFormat::DateTime).ok());
        let etag = obj.e_tag().map(|e| e.trim_matches('"').to_string());
        objects.push(ObjectInfo {
            key: key.to_string(),
            size,
            last_modified,
            etag,
        });
    }

    let next_token = if out.is_truncated() == Some(true) {
        out.next_continuation_token().map(|s| s.to_string())
    } else {
        None
    };

    Ok(ListPage {
        prefixes,
        objects,
        next_token,
    })
}

pub async fn get_range(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    start: u64,
    end: u64,
) -> anyhow::Result<Vec<u8>> {
    anyhow::ensure!(
        end >= start && end - start < 1_048_576,
        "Invalid byte range {start}-{end}"
    );

    let out = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .range(format!("bytes={start}-{end}"))
        .send()
        .await
        .with_context(|| format!("Reading bytes {start}-{end} of {bucket}/{key} failed"))?;
    crate::log_call!("R2 GetObject range {start}-{end} {bucket}/{key}");

    let bytes = out
        .body
        .collect()
        .await
        .with_context(|| format!("Reading the body of {bucket}/{key} failed"))?
        .into_bytes()
        .to_vec();

    Ok(bytes)
}

pub async fn download(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    dest: &Path,
) -> anyhow::Result<u64> {
    let out = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .with_context(|| format!("Downloading {bucket}/{key} failed"))?;
    crate::log_call!("R2 Download {bucket}/{key}");

    let mut file = tokio::fs::File::create(dest)
        .await
        .with_context(|| format!("Could not create {}", dest.display()))?;

    let mut body = out.body;
    let res: anyhow::Result<u64> = async {
        let mut n: u64 = 0;
        while let Some(chunk) = body
            .try_next()
            .await
            .with_context(|| format!("Downloading {bucket}/{key} failed"))?
        {
            file.write_all(&chunk)
                .await
                .with_context(|| format!("Could not write {}", dest.display()))?;
            n += chunk.len() as u64;
        }
        file.flush()
            .await
            .with_context(|| format!("Could not write {}", dest.display()))?;
        Ok(n)
    }
    .await;

    match res {
        Ok(n) => Ok(n),
        Err(err) => {
            drop(file);
            let _ = tokio::fs::remove_file(dest).await;
            Err(err)
        }
    }
}
