//! HTTP wrapper (spec T-06): UA / Referer / Cookie / redirect / timeout.
//!
//! One shared entry point for all outbound requests. Headers from the config
//! are passed through verbatim; a default TVBox-style UA is added only when the
//! caller did not supply one. A single `reqwest::Client` is reused so the
//! connection pool survives across requests.

use crate::error::{code, AppError};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FetchResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// One client for the whole process so TCP/TLS connections and DNS are reused.
/// Building a fresh `reqwest::Client` per request (as this used to do) throws
/// away the pool on every call — painful during a 20-site fan-out.
pub(crate) fn shared_client() -> Result<&'static reqwest::Client, AppError> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    match CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
            .build()
            .map_err(|err| err.to_string())
    }) {
        Ok(client) => Ok(client),
        Err(cause) => Err(
            AppError::new(code::CONFIG_FETCH_FAIL, "http client init failed")
                .with_cause(cause.clone()),
        ),
    }
}

pub async fn fetch(request: FetchRequest) -> Result<FetchResponse, AppError> {
    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS),
    );
    let client = shared_client()?;

    let method = match request.method.as_deref().unwrap_or("GET") {
        name if name.eq_ignore_ascii_case("GET") => reqwest::Method::GET,
        name if name.eq_ignore_ascii_case("POST") => reqwest::Method::POST,
        other => {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                format!("unsupported method: {other}"),
            ))
        }
    };

    let mut headers = HeaderMap::new();
    if let Some(extra) = request.headers {
        for (name, value) in extra {
            let header_name = HeaderName::from_bytes(name.as_bytes()).map_err(|err| {
                AppError::new(code::INVALID_ARGUMENT, format!("bad header name: {name}"))
                    .with_cause(err.to_string())
            })?;
            let header_value = HeaderValue::from_str(&value).map_err(|err| {
                AppError::new(code::INVALID_ARGUMENT, format!("bad header value for {name}"))
                    .with_cause(err.to_string())
            })?;
            headers.insert(header_name, header_value);
        }
    }
    if !headers.contains_key(USER_AGENT) {
        headers.insert(
            USER_AGENT,
            HeaderValue::from_static(crate::netrules::DEFAULT_UA),
        );
    }

    // The shared client has no global timeout: each caller's budget is applied
    // per request, otherwise one slow source would set the policy for all.
    let mut builder = client
        .request(method, &request.url)
        .headers(headers)
        .timeout(timeout);
    if let Some(body) = request.body {
        builder = builder.body(body);
    }

    let response = builder.send().await.map_err(|err| {
        if err.is_timeout() {
            AppError::new(code::SITE_TIMEOUT, format!("fetch {} timed out", request.url))
                .with_cause(err.to_string())
        } else {
            AppError::new(code::CONFIG_FETCH_FAIL, format!("fetch {} failed", request.url))
                .with_cause(err.to_string())
        }
    })?;

    let status = response.status().as_u16();
    // Charset must be read before the body consumes the response.
    let declared_charset = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(crate::textio::charset_from_content_type);
    let response_headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    // `Response::text()` assumes UTF-8 (the `charset` feature is off), which
    // turns GBK/GB18030 bodies into `????`. Collect bytes and normalise here so
    // every caller of the shared fetch gets UTF-8 text.
    let bytes = response.bytes().await.map_err(|err| {
        AppError::new(code::CONFIG_FETCH_FAIL, "read response body failed")
            .with_cause(err.to_string())
    })?;
    let body = crate::textio::decode_with_charset(&bytes, declared_charset.as_deref());

    Ok(FetchResponse {
        status,
        headers: response_headers,
        body,
    })
}

#[tauri::command]
pub async fn http_fetch(request: FetchRequest) -> Result<FetchResponse, AppError> {
    fetch(request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpStream;
    use std::process::{Child, Command};
    use std::time::Duration;

    fn python() -> String {
        crate::env::get_or("PYTHON", "python")
    }

    fn start_stub() -> Child {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("project root")
            .to_path_buf();
        Command::new(python())
            .arg(root.join("tests").join("stub_server.py"))
            .spawn()
            .expect("spawn stub server")
    }

    fn wait_ready() -> bool {
        for _ in 0..75 {
            if TcpStream::connect("127.0.0.1:8787").is_ok() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        false
    }

    #[tokio::test]
    async fn passes_headers_and_enforces_timeout() {
        let mut stub = start_stub();
        assert!(wait_ready(), "stub server not ready");

        let response = fetch(FetchRequest {
            url: "http://127.0.0.1:8787/echo".to_string(),
            method: None,
            headers: Some(HashMap::from([
                ("X-Test".to_string(), "abc".to_string()),
                ("Referer".to_string(), "http://127.0.0.1:8787/".to_string()),
            ])),
            body: None,
            timeout_ms: Some(5_000),
        })
        .await
        .expect("fetch echo");

        assert_eq!(response.status, 200);
        let echo: serde_json::Value = serde_json::from_str(&response.body).expect("echo json");
        assert_eq!(echo["headers"]["x-test"], "abc");
        assert_eq!(echo["headers"]["referer"], "http://127.0.0.1:8787/");
        assert!(echo["headers"]["user-agent"]
            .as_str()
            .unwrap_or_default()
            .contains("okhttp"));

        let error = fetch(FetchRequest {
            url: "http://127.0.0.1:8787/slow".to_string(),
            method: None,
            headers: None,
            body: None,
            timeout_ms: Some(200),
        })
        .await
        .expect_err("must time out");
        assert_eq!(error.code, code::SITE_TIMEOUT);

        let _ = stub.kill();
    }
}
