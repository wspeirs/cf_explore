use std::path::Path;
use anyhow::Context;
use tokio::io::AsyncWriteExt;

pub fn client_config(
    account_id: &str,
    access_key_id: &str,
    secret: &str,
) -> aws_sdk_s3::config::Builder {
    aws_sdk_s3::Config::builder()
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
}

pub fn make_client(account_id: &str, access_key_id: &str, secret: &str) -> aws_sdk_s3::Client {
    aws_sdk_s3::Client::from_conf(client_config(account_id, access_key_id, secret).build())
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

pub fn to_buckets(out: &aws_sdk_s3::operation::list_buckets::ListBucketsOutput) -> Vec<BucketInfo> {
    out.buckets()
        .iter()
        .map(|b| BucketInfo {
            name: b.name().unwrap_or_default().to_string(),
            created: b
                .creation_date()
                .and_then(|dt| dt.fmt(aws_sdk_s3::primitives::DateTimeFormat::DateTime).ok()),
        })
        .collect()
}

pub async fn list_buckets(client: &aws_sdk_s3::Client) -> anyhow::Result<Vec<BucketInfo>> {
    crate::log_call!("R2 ListBuckets");
    let out = client
        .list_buckets()
        .send()
        .await
        .context("Listing R2 buckets failed")?;

    Ok(to_buckets(&out))
}

pub fn to_list_page(
    out: &aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output,
    prefix: &str,
) -> ListPage {
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

    ListPage {
        prefixes,
        objects,
        next_token,
    }
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

    crate::log_call!("R2 ListObjectsV2 {bucket}/{prefix}");
    let out = req
        .send()
        .await
        .with_context(|| format!("Listing objects in {bucket}/{prefix} failed"))?;

    Ok(to_list_page(&out, prefix))
}

pub fn validate_range(start: u64, end: u64) -> anyhow::Result<()> {
    anyhow::ensure!(
        end >= start && end - start < 1_048_576,
        "Invalid byte range {start}-{end}"
    );
    Ok(())
}

pub async fn get_range(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    start: u64,
    end: u64,
) -> anyhow::Result<Vec<u8>> {
    validate_range(start, end)?;

    crate::log_call!("R2 GetObject range {start}-{end} {bucket}/{key}");
    let out = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .range(format!("bytes={start}-{end}"))
        .send()
        .await
        .with_context(|| format!("Reading bytes {start}-{end} of {bucket}/{key} failed"))?;

    let bytes = out
        .body
        .collect()
        .await
        .with_context(|| format!("Reading the body of {bucket}/{key} failed"))?
        .into_bytes()
        .to_vec();

    Ok(bytes)
}

pub async fn write_stream(
    mut body: aws_sdk_s3::primitives::ByteStream,
    dest: &Path,
    bucket: &str,
    key: &str,
) -> anyhow::Result<u64> {
    let mut file = tokio::fs::File::create(dest)
        .await
        .with_context(|| format!("Could not create {}", dest.display()))?;

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

pub async fn download(
    client: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    dest: &Path,
) -> anyhow::Result<u64> {
    crate::log_call!("R2 Download {bucket}/{key}");
    let out = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .send()
        .await
        .with_context(|| format!("Downloading {bucket}/{key} failed"))?;

    write_stream(out.body, dest, bucket, key).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_s3::operation::list_buckets::ListBucketsOutput;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Output;
    use aws_sdk_s3::primitives::{ByteStream, DateTime, SdkBody};
    use aws_sdk_s3::types::{Bucket, CommonPrefix, Object};

    struct TempDirGuard(std::path::PathBuf);

    impl TempDirGuard {
        fn new(name: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let id = COUNTER.fetch_add(1, Ordering::Relaxed);
            let pid = std::process::id();
            let path = std::env::temp_dir().join(format!("cf_explore_test_{pid}_{name}_{id}"));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create test temp dir");
            TempDirGuard(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn test_validate_range() {
        assert!(validate_range(0, 4095).is_ok());
        assert!(validate_range(0, 0).is_ok());
        assert!(validate_range(4096, 1_048_575).is_ok());
        assert!(validate_range(0, 1_048_575).is_ok());

        let err = validate_range(0, 1_048_576).unwrap_err();
        assert_eq!(err.to_string(), "Invalid byte range 0-1048576");

        let err = validate_range(5, 4).unwrap_err();
        assert_eq!(err.to_string(), "Invalid byte range 5-4");

        let err = validate_range(10, 10 + 1_048_576).unwrap_err();
        assert_eq!(err.to_string(), "Invalid byte range 10-1048586");

        let err = validate_range(0, u64::MAX).unwrap_err();
        assert_eq!(err.to_string(), format!("Invalid byte range 0-{}", u64::MAX));
    }

    #[test]
    fn test_make_client_no_panic() {
        let _ = make_client("0123456789abcdef0123456789abcdef", "key", "secret");
    }

    #[test]
    fn test_to_list_page() {
        // Placeholder skipped (prefix "a/", keys ["a/", "a/x.txt"] -> only "a/x.txt")
        let out = ListObjectsV2Output::builder()
            .contents(Object::builder().key("a/").build())
            .contents(Object::builder().key("a/x.txt").build())
            .build();
        let page = to_list_page(&out, "a/");
        assert_eq!(page.objects.len(), 1);
        assert_eq!(page.objects[0].key, "a/x.txt");

        // Empty prefix keeps key "x"
        let out = ListObjectsV2Output::builder()
            .contents(Object::builder().key("x").build())
            .build();
        let page = to_list_page(&out, "");
        assert_eq!(page.objects.len(), 1);
        assert_eq!(page.objects[0].key, "x");

        // Size: -5 -> 0, missing size -> 0, 1234 -> 1234
        let out = ListObjectsV2Output::builder()
            .contents(Object::builder().key("neg").size(-5).build())
            .contents(Object::builder().key("missing").build())
            .contents(Object::builder().key("pos").size(1234).build())
            .build();
        let page = to_list_page(&out, "");
        assert_eq!(page.objects.len(), 3);
        assert_eq!(page.objects[0].size, 0);
        assert_eq!(page.objects[1].size, 0);
        assert_eq!(page.objects[2].size, 1234);

        // ETag: "abc" (with quotes) -> Some("abc"), "abc-3" (with quotes) -> Some("abc-3"), none -> None
        let out = ListObjectsV2Output::builder()
            .contents(Object::builder().key("quoted").e_tag("\"abc\"").build())
            .contents(Object::builder().key("part").e_tag("\"abc-3\"").build())
            .contents(Object::builder().key("none").build())
            .build();
        let page = to_list_page(&out, "");
        assert_eq!(page.objects.len(), 3);
        assert_eq!(page.objects[0].etag.as_deref(), Some("abc"));
        assert_eq!(page.objects[1].etag.as_deref(), Some("abc-3"));
        assert_eq!(page.objects[2].etag, None);

        // Last modified: DateTime::from_secs(0) -> Some("1970-01-01T00:00:00Z")
        let out = ListObjectsV2Output::builder()
            .contents(
                Object::builder()
                    .key("epoch")
                    .last_modified(DateTime::from_secs(0))
                    .build(),
            )
            .build();
        let page = to_list_page(&out, "");
        assert_eq!(
            page.objects[0].last_modified.as_deref(),
            Some("1970-01-01T00:00:00Z")
        );

        // Common prefixes ["a/b/", "a/c/"] keep their order
        let out = ListObjectsV2Output::builder()
            .common_prefixes(CommonPrefix::builder().prefix("a/b/").build())
            .common_prefixes(CommonPrefix::builder().prefix("a/c/").build())
            .build();
        let page = to_list_page(&out, "");
        assert_eq!(page.prefixes, vec!["a/b/", "a/c/"]);

        // Next token:
        // is_truncated(true) + token "t" -> Some("t")
        let out_trunc = ListObjectsV2Output::builder()
            .is_truncated(true)
            .next_continuation_token("t")
            .build();
        assert_eq!(to_list_page(&out_trunc, "").next_token.as_deref(), Some("t"));

        // is_truncated(false) + token "t" -> None
        let out_not_trunc = ListObjectsV2Output::builder()
            .is_truncated(false)
            .next_continuation_token("t")
            .build();
        assert_eq!(to_list_page(&out_not_trunc, "").next_token, None);

        // is_truncated unset + token "t" -> None
        let out_unset = ListObjectsV2Output::builder()
            .next_continuation_token("t")
            .build();
        assert_eq!(to_list_page(&out_unset, "").next_token, None);
    }

    #[test]
    fn test_to_buckets() {
        let out = ListBucketsOutput::builder()
            .buckets(
                Bucket::builder()
                    .name("b")
                    .creation_date(DateTime::from_secs(86400))
                    .build(),
            )
            .buckets(Bucket::builder().name("no_date").build())
            .build();

        let buckets = to_buckets(&out);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].name, "b");
        assert_eq!(
            buckets[0].created.as_deref(),
            Some("1970-01-02T00:00:00Z")
        );
        assert_eq!(buckets[1].name, "no_date");
        assert_eq!(buckets[1].created, None);
    }

    struct FailingBody {
        yielded_first: bool,
    }

    impl http_body::Body for FailingBody {
        type Data = bytes::Bytes;
        type Error = std::io::Error;

        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
            if !self.yielded_first {
                self.yielded_first = true;
                std::task::Poll::Ready(Some(Ok(http_body::Frame::data(bytes::Bytes::from_static(
                    b"partial chunk",
                )))))
            } else {
                std::task::Poll::Ready(Some(Err(std::io::Error::other(
                    "simulated network stream error",
                ))))
            }
        }
    }

    #[test]
    fn test_write_stream() {
        let guard = TempDirGuard::new("write_stream");

        // 1. ByteStream::from_static(b"hello") -> Ok(5) and the file holds "hello"
        let dest1 = guard.path().join("hello.txt");
        let stream1 = ByteStream::from_static(b"hello");
        let res1 = tauri::async_runtime::block_on(write_stream(stream1, &dest1, "bucket", "key"));
        assert_eq!(res1.unwrap(), 5);
        assert_eq!(std::fs::read(&dest1).unwrap(), b"hello");

        // 2. Empty stream -> Ok(0) and an empty file
        let dest2 = guard.path().join("empty.txt");
        let stream2 = ByteStream::from_static(b"");
        let res2 = tauri::async_runtime::block_on(write_stream(stream2, &dest2, "bucket", "key"));
        assert_eq!(res2.unwrap(), 0);
        assert_eq!(std::fs::read(&dest2).unwrap(), b"");

        // 3. Dest inside non-existent directory -> Err containing "Could not create" and no file
        let bad_dest = guard.path().join("missing_dir").join("file.txt");
        let stream3 = ByteStream::from_static(b"hello");
        let res3 = tauri::async_runtime::block_on(write_stream(stream3, &bad_dest, "bucket", "key"));
        let err3 = res3.unwrap_err();
        let err3_msg = format!("{err3:#}");
        assert!(
            err3_msg.contains("Could not create"),
            "Expected 'Could not create', got: {err3_msg}"
        );
        assert!(!bad_dest.exists());

        // 4. Failing stream: yields one chunk then I/O error -> Err containing "Downloading"
        //    AND the partial file no longer exists
        let fail_dest = guard.path().join("partial.txt");
        let failing_body = FailingBody {
            yielded_first: false,
        };
        let stream4 = ByteStream::new(SdkBody::from_body_1_x(failing_body));
        let res4 = tauri::async_runtime::block_on(write_stream(
            stream4,
            &fail_dest,
            "test-bucket",
            "test-key",
        ));
        let err4 = res4.unwrap_err();
        let err4_msg = format!("{err4:#}");
        assert!(
            err4_msg.contains("Downloading test-bucket/test-key failed"),
            "Expected downloading failure context, got: {err4_msg}"
        );
        assert!(
            !fail_dest.exists(),
            "Partial file should have been removed on stream failure"
        );
    }
}

#[cfg(test)]
mod request_shape_tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use aws_sdk_s3::Client;
    use aws_smithy_runtime_api::client::http::{
        HttpClient, HttpConnector, HttpConnectorFuture, HttpConnectorSettings, SharedHttpConnector,
    };
    use aws_smithy_runtime_api::client::orchestrator::{HttpRequest, HttpResponse};
    use aws_smithy_runtime_api::client::runtime_components::RuntimeComponents;
    use aws_smithy_runtime_api::http::StatusCode;
    use aws_smithy_types::body::SdkBody;

    const TEST_ACCOUNT: &str = "0123456789abcdef0123456789abcdef";

    struct TempDirGuard(std::path::PathBuf);

    impl TempDirGuard {
        fn new(name: &str) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let id = COUNTER.fetch_add(1, Ordering::Relaxed);
            let pid = std::process::id();
            let path = std::env::temp_dir().join(format!("cf_explore_test_{pid}_{name}_{id}"));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create test temp dir");
            TempDirGuard(path)
        }

        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Debug, Clone)]
    struct RecordedRequest {
        method: String,
        uri: String,
        headers: Vec<(String, String)>,
    }

    impl RecordedRequest {
        fn host(&self) -> &str {
            let without_proto = self
                .uri
                .strip_prefix("https://")
                .or_else(|| self.uri.strip_prefix("http://"))
                .unwrap_or(&self.uri);
            without_proto.split('/').next().unwrap_or("")
        }

        fn path(&self) -> &str {
            let without_proto = self
                .uri
                .strip_prefix("https://")
                .or_else(|| self.uri.strip_prefix("http://"))
                .unwrap_or(&self.uri);
            if let Some(slash_idx) = without_proto.find('/') {
                let path_and_query = &without_proto[slash_idx..];
                path_and_query.split('?').next().unwrap_or(path_and_query)
            } else {
                "/"
            }
        }

        fn query_param(&self, key: &str) -> Option<String> {
            let query_str = self.uri.split_once('?')?.1;
            for pair in query_str.split('&') {
                let mut parts = pair.splitn(2, '=');
                let k = parts.next().unwrap_or("");
                if k == key {
                    return Some(parts.next().unwrap_or("").to_string());
                }
            }
            None
        }

        fn has_query_key(&self, key: &str) -> bool {
            self.query_param(key).is_some()
        }

        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    #[derive(Clone)]
    struct RecordingClient {
        requests: Arc<Mutex<Vec<RecordedRequest>>>,
        responder: Arc<dyn Fn(&HttpRequest) -> HttpResponse + Send + Sync>,
    }

    impl std::fmt::Debug for RecordingClient {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("RecordingClient")
                .field("requests", &self.requests)
                .finish()
        }
    }

    impl HttpConnector for RecordingClient {
        fn call(&self, request: HttpRequest) -> HttpConnectorFuture {
            let method = request.method().to_string();
            let uri = request.uri().to_string();
            let headers = request
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();

            let resp = (self.responder)(&request);

            self.requests.lock().unwrap().push(RecordedRequest {
                method,
                uri,
                headers,
            });

            HttpConnectorFuture::ready(Ok(resp))
        }
    }

    impl HttpClient for RecordingClient {
        fn http_connector(
            &self,
            _settings: &HttpConnectorSettings,
            _components: &RuntimeComponents,
        ) -> SharedHttpConnector {
            SharedHttpConnector::new(self.clone())
        }
    }

    impl RecordingClient {
        fn new(responder: impl Fn(&HttpRequest) -> HttpResponse + Send + Sync + 'static) -> Self {
            Self {
                requests: Arc::new(Mutex::new(Vec::new())),
                responder: Arc::new(responder),
            }
        }

        fn canned_200(body: &'static str) -> Self {
            Self::new(move |_req| {
                HttpResponse::new(
                    StatusCode::try_from(200u16).unwrap(),
                    SdkBody::from(body),
                )
            })
        }
        fn canned_206(body: &'static [u8]) -> Self {
            Self::new(move |_req| {
                HttpResponse::new(
                    StatusCode::try_from(206u16).unwrap(),
                    SdkBody::from(body),
                )
            })
        }


        fn requests(&self) -> Vec<RecordedRequest> {
            self.requests.lock().unwrap().clone()
        }
    }

    fn make_test_client(recording: RecordingClient) -> Client {
        Client::from_conf(
            client_config(TEST_ACCOUNT, "a", "b")
                .http_client(recording)
                .build(),
        )
    }

    // 1. list_objects(&client, "bucket", "", None) sends exactly ONE request: GET, host
    //    0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com, path /bucket (path-style
    //    addressing; the SDK appends a trailing slash /bucket/), query contains list-type=2,
    //    delimiter=%2F, max-keys=1000, and NO prefix and NO continuation-token key.
    #[test]
    fn test_list_objects_root_request_shape() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
    <Name>bucket</Name>
    <IsTruncated>false</IsTruncated>
</ListBucketResult>"#;
        let recording = RecordingClient::canned_200(xml);
        let client = make_test_client(recording.clone());

        let page = tauri::async_runtime::block_on(list_objects(&client, "bucket", "", None))
            .expect("list_objects succeeded");

        assert!(page.objects.is_empty());
        assert!(page.prefixes.is_empty());
        assert_eq!(page.next_token, None);

        let reqs = recording.requests();
        assert_eq!(reqs.len(), 1);
        let req = &reqs[0];

        assert_eq!(req.method, "GET");
        assert_eq!(
            req.host(),
            "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
        );
        assert_eq!(req.path().trim_end_matches('/'), "/bucket");
        assert_eq!(req.query_param("list-type").as_deref(), Some("2"));
        assert_eq!(req.query_param("delimiter").as_deref(), Some("%2F"));
        assert_eq!(req.query_param("max-keys").as_deref(), Some("1000"));
        assert!(!req.has_query_key("prefix"));
        assert!(!req.has_query_key("continuation-token"));
    }

    // 2. list_objects(&client, "bucket", "a/", Some("t".to_string())) -> query has prefix=a%2F
    //    and continuation-token=t in addition to delimiter/max-keys; reply with a truncated listing
    //    (IsTruncated true, NextContinuationToken, one <Contents> and one <CommonPrefixes>) and
    //    assert next_token == Some(..), the object and the folder are mapped.
    #[test]
    fn test_list_objects_prefixed_truncated_request_shape() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
    <Name>bucket</Name>
    <Prefix>a/</Prefix>
    <Delimiter>/</Delimiter>
    <MaxKeys>1000</MaxKeys>
    <IsTruncated>true</IsTruncated>
    <NextContinuationToken>next-token-val</NextContinuationToken>
    <Contents>
        <Key>a/file.txt</Key>
        <LastModified>2024-01-01T12:00:00.000Z</LastModified>
        <ETag>&quot;etag123&quot;</ETag>
        <Size>1234</Size>
    </Contents>
    <CommonPrefixes>
        <Prefix>a/subfolder/</Prefix>
    </CommonPrefixes>
</ListBucketResult>"#;
        let recording = RecordingClient::canned_200(xml);
        let client = make_test_client(recording.clone());

        let page = tauri::async_runtime::block_on(list_objects(
            &client,
            "bucket",
            "a/",
            Some("t".to_string()),
        ))
        .expect("list_objects succeeded");

        assert_eq!(page.next_token.as_deref(), Some("next-token-val"));
        assert_eq!(page.prefixes, vec!["a/subfolder/".to_string()]);
        assert_eq!(page.objects.len(), 1);
        assert_eq!(page.objects[0].key, "a/file.txt");
        assert_eq!(page.objects[0].size, 1234);
        assert_eq!(
            page.objects[0].last_modified.as_deref(),
            Some("2024-01-01T12:00:00Z")
        );
        assert_eq!(page.objects[0].etag.as_deref(), Some("etag123"));

        let reqs = recording.requests();
        assert_eq!(reqs.len(), 1);
        let req = &reqs[0];

        assert_eq!(req.method, "GET");
        assert_eq!(
            req.host(),
            "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
        );
        assert_eq!(req.path().trim_end_matches('/'), "/bucket");
        assert_eq!(req.query_param("list-type").as_deref(), Some("2"));
        assert_eq!(req.query_param("delimiter").as_deref(), Some("%2F"));
        assert_eq!(req.query_param("max-keys").as_deref(), Some("1000"));
        assert_eq!(req.query_param("prefix").as_deref(), Some("a%2F"));
        assert_eq!(req.query_param("continuation-token").as_deref(), Some("t"));
    }

    // 3. get_range(&client, "bucket", "dir/key.txt", 0, 4095) sends GET path /bucket/dir/key.txt
    //    with header range: bytes=0-4095 (case-insensitive header lookup) and returns the canned
    //    body bytes (reply 206 with a few bytes); exactly ONE request.
    #[test]
    fn test_get_range_request_shape() {
        let recording = RecordingClient::canned_206(b"partial-range-data");
        let client = make_test_client(recording.clone());

        let bytes = tauri::async_runtime::block_on(get_range(
            &client,
            "bucket",
            "dir/key.txt",
            0,
            4095,
        ))
        .expect("get_range succeeded");

        assert_eq!(bytes, b"partial-range-data");

        let reqs = recording.requests();
        assert_eq!(reqs.len(), 1);
        let req = &reqs[0];

        assert_eq!(req.method, "GET");
        assert_eq!(
            req.host(),
            "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
        );
        assert_eq!(req.path(), "/bucket/dir/key.txt");
        assert_eq!(req.header("range"), Some("bytes=0-4095"));
    }

    // 4. download(&client, "bucket", "k", <unique temp file>) sends exactly ONE request WITHOUT
    //    a range header and writes the canned body to disk (unique dir under std::env::temp_dir(),
    //    removed afterwards via a Drop guard; NEVER use special files).
    #[test]
    fn test_download_request_shape() {
        let guard = TempDirGuard::new("download_shape");
        let dest = guard.path().join("downloaded.bin");

        let recording = RecordingClient::canned_200("full-download-bytes");
        let client = make_test_client(recording.clone());

        let n = tauri::async_runtime::block_on(download(&client, "bucket", "k", &dest))
            .expect("download succeeded");

        assert_eq!(n, 19);
        assert_eq!(
            std::fs::read(&dest).expect("read downloaded file"),
            b"full-download-bytes"
        );

        let reqs = recording.requests();
        assert_eq!(reqs.len(), 1);
        let req = &reqs[0];

        assert_eq!(req.method, "GET");
        assert_eq!(
            req.host(),
            "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
        );
        assert_eq!(req.path(), "/bucket/k");
        assert_eq!(req.header("range"), None);
    }

    // 5. list_buckets(&client) sends exactly ONE GET to path / and maps the canned
    //    <ListAllMyBucketsResult> (one bucket with name and creation date) to BucketInfo.
    #[test]
    fn test_list_buckets_request_shape() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
    <Buckets>
        <Bucket>
            <Name>test-bucket</Name>
            <CreationDate>2024-01-02T03:04:05.000Z</CreationDate>
        </Bucket>
    </Buckets>
</ListAllMyBucketsResult>"#;
        let recording = RecordingClient::canned_200(xml);
        let client = make_test_client(recording.clone());

        let buckets = tauri::async_runtime::block_on(list_buckets(&client))
            .expect("list_buckets succeeded");

        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].name, "test-bucket");
        assert_eq!(
            buckets[0].created.as_deref(),
            Some("2024-01-02T03:04:05Z")
        );

        let reqs = recording.requests();
        assert_eq!(reqs.len(), 1);
        let req = &reqs[0];

        assert_eq!(req.method, "GET");
        assert_eq!(
            req.host(),
            "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com"
        );
        assert_eq!(req.path(), "/");
    }

    // 6. get_range(&client, "b", "k", 5, 4) and an over-limit span record ZERO requests
    //    (validation happens before any I/O).
    #[test]
    fn test_get_range_validation_records_zero_requests() {
        let recording = RecordingClient::canned_206(b"should-not-be-called");
        let client = make_test_client(recording.clone());

        // Inverted range (start > end)
        let res_inverted =
            tauri::async_runtime::block_on(get_range(&client, "b", "k", 5, 4));
        assert!(res_inverted.is_err());

        // Over-limit span (end - start >= 1_048_576)
        let res_over_limit =
            tauri::async_runtime::block_on(get_range(&client, "b", "k", 0, 1_048_576));
        assert!(res_over_limit.is_err());

        // Over-limit span offset
        let res_over_limit_offset =
            tauri::async_runtime::block_on(get_range(&client, "b", "k", 10, 10 + 1_048_576));
        assert!(res_over_limit_offset.is_err());

        assert_eq!(recording.requests().len(), 0);
    }
}
