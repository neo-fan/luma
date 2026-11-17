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
use moka::future::Cache;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};
use tokio::sync::Semaphore;

const SOURCE_TTL: Duration = Duration::from_secs(600);
const MAX_SOURCES: usize = 64;
/// Caps how many py child processes one fan-out may start at once.
static PY_CONCURRENCY: OnceLock<Semaphore> = OnceLock::new();

/// 一条脚本的来源结论。
///
/// `Stale` 是「网络失败后拿过期磁盘快照救场」的结果：它能让这一次播放继续，
/// **但不该占住内存缓存**——否则网络恢复后还要白等一个 TTL 才重试（旧实现就是
/// 这个语义：过期条目只在兜底分支读，不刷新 `fetched_at`）。所以调用方拿到
/// `Stale` 会立刻 `invalidate`，下一次仍然尝试回源。
#[derive(Clone)]
enum Source {
    Fresh(String),
    Stale(String),
}

/// py 脚本的内存缓存：TTL 600s、上限 64 条，同 key 并发首次访问合并成一次下载
/// （`try_get_with` 保证；错误不进缓存）。
///
/// 取代原先「`HashMap + Instant` 自研 TTL 表 + `infra::flights` 自研 single-flight」
/// 两套东西——它们是同一个库的两个特性（评审：优先用主流库，不要手搓）。
static SOURCE_CACHE: OnceLock<Cache<String, Source>> = OnceLock::new();

fn source_cache() -> &'static Cache<String, Source> {
    SOURCE_CACHE.get_or_init(|| {
        Cache::builder()
            .max_capacity(MAX_SOURCES as u64)
            .time_to_live(SOURCE_TTL)
            .build()
    })
}

fn concurrency() -> &'static Semaphore {
    PY_CONCURRENCY.get_or_init(|| Semaphore::new(4))
}

/// 脚本快照落盘目录。源脚本托管在 GitHub raw，冷启动每次都要重新下载，网络
/// 一抖就是十几秒甚至直接失败；有磁盘快照就能把「重启后第一次点播」压到本地
/// 读文件的时间。
fn snapshot_dir() -> PathBuf {
    crate::store::data_dir().join("spider-src")
}

/// URL → 稳定文件名：XXH3（`xxhash-rust`，主流、快，非加密用途足够），取代原先
/// 手搓的 FNV-1a——「不要手搓轮子」。只用于映射磁盘快照文件名，不承担安全职责。
fn snapshot_key(url: &str) -> String {
    format!("{:016x}", xxhash_rust::xxh3::xxh3_64(url.as_bytes()))
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
    // `try_get_with`：同 key 的并发首次访问合并成一次下载（脚本下载不在
    // `PY_CONCURRENCY` 信号量覆盖范围内，不去重就会并发重复抓同一个 URL），
    // 并且求值失败不进缓存 —— 下一次调用仍然回源。
    let cache = source_cache();
    match cache
        .try_get_with(api.clone(), cold_source(site.clone()))
        .await
    {
        Ok(Source::Fresh(text)) => Ok(text),
        Ok(Source::Stale(text)) => {
            // 过期快照救场：这一次能用，但不占住内存缓存，下次继续尝试回源。
            cache.invalidate(&api).await;
            Ok(text)
        }
        Err(err) => Err((*err).clone()),
    }
}

/// `source_for` 的实际取数链（磁盘快照 → 网络 → 过期快照兜底）。
/// 只在 moka 里没有有效条目时才会被跑到。
async fn cold_source(site: Value) -> Result<Source, AppError> {
    let api = site
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    // 先看磁盘：TTL 内的快照直接当命中（省掉一次网络往返）。
    let snapshot = read_snapshot(&api);
    if let Some((text, true)) = snapshot.clone() {
        return Ok(Source::Fresh(text));
    }

    let response = match http::fetch(http::FetchRequest {
        url: api.clone(),
        method: None,
        headers: site.get("headers").and_then(Value::as_object).map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect::<HashMap<String, String>>()
        }),
        body: None,
        timeout_ms: Some(10_000),
    })
    .await
    {
        Ok(response) => response,
        Err(err) => {
            // 脚本托管在 GitHub raw，网络抖动/代理不可用是常态。此时手里有
            // 磁盘快照（哪怕已过期）也比整个源不可用强（2026-11-14 实测：
            // 一次 `fetch bubuzhuiju.py failed` 会让详情和播放同时失败）。
            // 兜底来源从「内存表」改成「磁盘」：moka 里过期的条目读不到了，
            // 而磁盘快照的覆盖面至少等价（写内存的路径都同时写盘）。
            if let Some((text, _)) = snapshot {
                tracing::warn!(url = %api, error = %err, "py source fetch failed, using stale snapshot");
                return Ok(Source::Stale(text));
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
    Ok(Source::Fresh(response.body))
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

        let _permit = concurrency().acquire().await.map_err(|err| {
            AppError::new(code::INTERNAL, "py semaphore closed").with_cause(err.to_string())
        })?;

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
        bridge::call_with_timeout("spider.py", params, timeout)
            .await
            .map(|value| normalize(site, method, args, value))
    }

    async fn health(&self) -> Result<(), AppError> {
        bridge::call_with_timeout("ping", json!({}), Duration::from_secs(5))
            .await
            .map(|_| ())
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

/// py 源返回值归一（原 `sidecars/py/pyspider.py::_normalize`）：契约映射只留
/// 一份 Rust 实现，适配层回归「只执行脚本」。
///
/// 形状不对时返回空信封而不是错误——一个坏源不该拖垮整轮聚合。空详情曾经完全
/// 不可见（UI 只报「未获取到影片详情」），所以仍记一条 INFO，带脚本 URL 和
/// vodId：适配层的 `spider.log` 只收脚本异常，这条是宿主侧的归一化诊断，落宿主
/// 日志。
fn normalize(site: &Value, method: SpiderMethod, args: &[Value], result: Value) -> Value {
    let normalized = crate::spider::cms_parse::normalize_spider_result(method.as_str(), &result);
    if method == SpiderMethod::DetailContent
        && normalized.as_array().map_or(true, |items| items.is_empty())
    {
        let api = site.get("api").and_then(Value::as_str).unwrap_or("");
        let vod_id = args
            .first()
            .map(|value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            })
            .unwrap_or_default();
        tracing::info!(source_api = %api, vod_id = %vod_id, "spider detailContent returned no video");
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Response, StatusCode};
    use axum::routing::get;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    /// 起一个本地桩：返回什么由 `mode` 决定（`ok` 给合法 Spider 脚本，
    /// `junk` 给不是脚本的内容）。命中次数记在**调用方传入的计数器**上——
    /// 用全局静态会被并行测试互相污染（第一版就因此得到 3 次命中的假阴性）。
    async fn stub(
        mode: &'static str,
        hits: Arc<AtomicUsize>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let counter = hits.clone();
        let router = axum::Router::new().route(
            "/",
            get(move || {
                let hits = counter.clone();
                async move {
                    hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let body = if mode == "ok" {
                        "class Spider:\n    pass\n"
                    } else {
                        "<!doctype html><html>gate page</html>"
                    };
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "text/plain; charset=utf-8")
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        (format!("http://{addr}/"), task)
    }

    fn forget_snapshot(url: &str) {
        let path = snapshot_dir().join(format!("{}.py", snapshot_key(url)));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_same_url_downloads_once() {
        // moka `try_get_with` 的核心承诺：同 key 并发首次访问只跑一次求值。
        // 这一条以前靠自研 flights 保证，现在由库兑现 —— 测试守住的是
        // 「我们确实接到了这个保证」，而不是重测库本身。
        let hits = Arc::new(AtomicUsize::new(0));
        let (url, task) = stub("ok", hits.clone()).await;
        let site = json!({ "api": url });
        let results = tokio::join!(
            source_for(&site),
            source_for(&site),
            source_for(&site),
            source_for(&site),
        );
        for result in [results.0, results.1, results.2, results.3] {
            assert!(result.expect("source").contains("class Spider"));
        }
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "同 URL 并发只应回源一次"
        );
        task.abort();
        forget_snapshot(&url);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failed_source_is_not_cached() {
        // 不是脚本的内容必须返回 Err 且**不进缓存**：否则一次坏响应会在
        // TTL 内一直供给坏数据（`try_get_with` 的 Err 不缓存语义）。
        let hits = Arc::new(AtomicUsize::new(0));
        let (url, task) = stub("junk", hits.clone()).await;
        let site = json!({ "api": url.clone() });
        let err = source_for(&site).await.expect_err("junk body must fail");
        assert_eq!(err.code, code::RUNTIME_UNAVAILABLE);
        // 第二次仍然回源（没有把失败结果缓存下来）。
        let _ = source_for(&site).await.err();
        assert!(
            hits.load(std::sync::atomic::Ordering::SeqCst) >= 2,
            "失败后必须重新回源"
        );
        task.abort();
        forget_snapshot(&url);
    }
}
