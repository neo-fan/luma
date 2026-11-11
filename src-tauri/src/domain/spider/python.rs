//! py spider runtime (spec 7.2 `spider.py` / T-15).
//!
//! Rust fetches the spider source, the Python adapter executes it in a child
//! process (`pyrun.py`). The source is cached in memory so repeated calls do not
//! hit the network; parsing/normalization stays in Python.

use crate::bridge;
use crate::error::{code, AppError};
use crate::http;
use crate::spider::{RuntimeKind, SpiderMethod, SpiderRuntime};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

const SOURCE_TTL: Duration = Duration::from_secs(600);
const MAX_SOURCES: usize = 64;
/// Caps how many py child processes one fan-out may start at once.
static PY_CONCURRENCY: OnceLock<Semaphore> = OnceLock::new();

fn concurrency() -> &'static Semaphore {
    PY_CONCURRENCY.get_or_init(|| Semaphore::new(4))
}

struct CachedSource {
    text: String,
    fetched_at: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, CachedSource>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSource>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn source_for(site: &Value) -> Result<String, AppError> {
    let api = site
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if api.is_empty() {
        return Err(AppError::new(code::INVALID_ARGUMENT, "py site has no api"));
    }
    if let Some(hit) = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&api)
        .filter(|entry| entry.fetched_at.elapsed() < SOURCE_TTL)
    {
        return Ok(hit.text.clone());
    }

    let response = http::fetch(http::FetchRequest {
        url: api.clone(),
        method: None,
        headers: site.get("headers").and_then(Value::as_object).map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
                .collect::<HashMap<String, String>>()
        }),
        body: None,
        timeout_ms: Some(10_000),
    })
    .await?;

    if !response.body.contains("class Spider") && !response.body.contains("Spider(") {
        return Err(AppError::new(
            code::RUNTIME_UNAVAILABLE,
            "py source does not define a Spider class",
        ));
    }

    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.len() >= MAX_SOURCES {
        guard.clear();
    }
    guard.insert(
        api,
        CachedSource {
            text: response.body.clone(),
            fetched_at: Instant::now(),
        },
    );
    Ok(response.body)
}

pub struct PythonRuntime;

#[async_trait]
impl SpiderRuntime for PythonRuntime {
    fn kind(&self) -> RuntimeKind {
        RuntimeKind::Python
    }

    async fn invoke(
        &self,
        site: &Value,
        method: SpiderMethod,
        args: &[Value],
        timeout: Duration,
    ) -> Result<Value, AppError> {
        let source = source_for(site).await?;
        let ext = site.get("ext").and_then(Value::as_str).unwrap_or("");

        let _permit = concurrency()
            .acquire()
            .await
            .map_err(|err| AppError::new(code::INTERNAL, "py semaphore closed").with_cause(err.to_string()))?;

        let params = json!({
            "source": source,
            "className": site.get("className").and_then(Value::as_str).unwrap_or("Spider"),
            "method": method.as_str(),
            "args": args,
            "ext": ext,
            "timeoutMs": timeout.as_millis() as u64,
        });
        bridge::call_with_timeout("spider.py", params, timeout).await
    }

    async fn health(&self) -> Result<(), AppError> {
        bridge::call_with_timeout("ping", json!({}), Duration::from_secs(5)).await.map(|_| ())
    }

    /// `Spider.proxy(Map)` for `/proxy?do=py`. Python returns
    /// `{contentType, headers, body(base64)}` via `pyrun.proxy_result`.
    async fn proxy(
        &self,
        site: &Value,
        params: std::collections::HashMap<String, String>,
        timeout: Duration,
    ) -> Result<crate::spider::ProxyPayload, AppError> {
        let source = source_for(site).await?;
        let ext = site.get("ext").and_then(Value::as_str).unwrap_or("");
        let _permit = concurrency().acquire().await.map_err(|err| {
            AppError::new(code::INTERNAL, "py semaphore closed").with_cause(err.to_string())
        })?;
        let value = bridge::call_with_timeout(
            "spider.py",
            json!({
                "source": source,
                "className": site.get("className").and_then(Value::as_str).unwrap_or("Spider"),
                "method": "proxy",
                "args": [params],
                "ext": ext,
                "timeoutMs": timeout.as_millis() as u64,
            }),
            timeout,
        )
        .await?;
        crate::spider::decode_proxy_payload(&value)
    }
}
