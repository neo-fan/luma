//! py spider runtime (spec 7.2 `spider.py` / T-15).
//!
//! Rust fetches the spider source, the Python adapter executes it in a child
//! process (`pyrun.py`). The source is cached in memory *and* on disk
//! (`<data>/spider-src/`) so a restart does not re-download every script from
//! GitHub raw — that path is the single slowest step of a cold play request
//! (measured 18.3 s end-to-end on the first call to a py source).

use crate::bridge;
use crate::error::{code, AppError};
use crate::http;
use crate::spider::{RuntimeKind, SpiderMethod, SpiderRuntime};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
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

/// 脚本快照落盘目录。源脚本托管在 GitHub raw，冷启动每次都要重新下载，网络
/// 一抖就是十几秒甚至直接失败；有磁盘快照就能把「重启后第一次点播」压到本地
/// 读文件的时间。
fn snapshot_dir() -> PathBuf {
    crate::store::data_dir().join("spider-src")
}

/// FNV-1a 64：只为把 URL 映射成稳定文件名，不承担任何安全职责。
fn snapshot_key(url: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// 读磁盘快照；返回（脚本文本, 是否在 TTL 内）。
fn read_snapshot(url: &str) -> Option<(String, bool)> {
    let path = snapshot_dir().join(format!("{}.py", snapshot_key(url)));
    let text = crate::textio::read_file(&path).ok()?;
    if !looks_like_spider(&text) {
        return None;
    }
    let fresh = std::fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age < SOURCE_TTL)
        .unwrap_or(false);
    Some((text, fresh))
}

fn write_snapshot(url: &str, text: &str) {
    let dir = snapshot_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    // 先写临时文件再改名：半截脚本落盘比没有快照更糟（语法错会让整个源崩）。
    let final_path = dir.join(format!("{}.py", snapshot_key(url)));
    let temp_path = dir.join(format!("{}.py.tmp", snapshot_key(url)));
    if std::fs::write(&temp_path, text).is_ok() {
        let _ = std::fs::rename(&temp_path, &final_path);
    }
}

fn looks_like_spider(text: &str) -> bool {
    text.contains("class Spider") || text.contains("Spider(")
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

    // 没命中内存缓存时先看磁盘：TTL 内的快照直接当命中（省掉一次网络往返）。
    if let Some((text, fresh)) = read_snapshot(&api) {
        remember(&api, &text);
        if fresh {
            return Ok(text);
        }
    }

    let response = match http::fetch(http::FetchRequest {
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
    .await
    {
        Ok(response) => response,
        Err(err) => {
            // 脚本托管在 GitHub raw，网络抖动/代理不可用是常态。此时若手里有
            // 过期快照（内存或磁盘），用旧的也比整个源不可用强（2026-11-14
            // 实测：一次 `fetch bubuzhuiju.py failed` 会让详情和播放同时失败）。
            if let Some(stale) = cache()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(&api)
                .map(|entry| entry.text.clone())
            {
                tracing::warn!(url = %api, error = %err, "py source fetch failed, using stale snapshot");
                return Ok(stale);
            }
            return Err(err);
        }
    };

    if !looks_like_spider(&response.body) {
        return Err(AppError::new(
            code::RUNTIME_UNAVAILABLE,
            "py source does not define a Spider class",
        ));
    }

    write_snapshot(&api, &response.body);
    remember(&api, &response.body);
    Ok(response.body)
}

fn remember(api: &str, text: &str) {
    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.len() >= MAX_SOURCES {
        guard.clear();
    }
    guard.insert(
        api.to_string(),
        CachedSource {
            text: text.to_string(),
            fetched_at: Instant::now(),
        },
    );
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
            // Diagnostics only: lets pyrun label tracebacks with the real script
            // URL and lets adapterlog attribute a crash to a concrete site.
            "api": site.get("api").and_then(Value::as_str).unwrap_or(""),
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
                "api": site.get("api").and_then(Value::as_str).unwrap_or(""),
                "timeoutMs": timeout.as_millis() as u64,
            }),
            timeout,
        )
        .await?;
        crate::spider::decode_proxy_payload(&value)
    }
}
