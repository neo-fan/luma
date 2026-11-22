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

/// 脚本快照 / 内存条目的新鲜期。
///
/// 曾经是 10 分钟：一次冷启动、一次重启、或十分钟后再打开应用，就要把配置里
/// 几十个 py 脚本全部重下一遍。它们都托管在同一个 GitHub 加速域名上，集中拉取
/// 会被镜像按 IP 限流（实测 47 个脚本并发 → `ghfast.top` 429，只能靠过期快照
/// 顶着）。脚本本身几乎不变（配置多数直接钉 commit hash），6 小时足够及时，
/// 也把日常请求量压到原来的 1/36。
const SOURCE_TTL: Duration = Duration::from_secs(6 * 60 * 60);
const MAX_SOURCES: usize = 64;
/// Caps how many py child processes one fan-out may start at once.
static PY_CONCURRENCY: OnceLock<Semaphore> = OnceLock::new();
/// 脚本下载闸门：与 `PY_CONCURRENCY`（子进程）分开，这里限的是**取脚本文本**的
/// 并发数。一次全站搜索会同时打到几十个 py 源，不设闸门就是几十个请求同时冲
/// 同一个加速域名，必然被限流。
static SOURCE_FETCH: OnceLock<Semaphore> = OnceLock::new();

/// 一条脚本的来源结论。
///
/// `Stale` 是「网络失败后拿过期磁盘快照救场」的结果：它能让这一次播放继续，
/// **但不该占住内存缓存**——过期条目只在兜底分支读、不刷新 `fetched_at`，否则
/// 网络恢复后还要白等一个 TTL 才重试。所以调用方拿到 `Stale` 会立刻 `invalidate`，
/// 下一次仍然尝试回源。
#[derive(Clone)]
enum Source {
    Fresh(String),
    Stale(String),
}

/// py 脚本的内存缓存：TTL 600s、上限 64 条，同 key 并发首次访问合并成一次下载
/// （`try_get_with` 保证；错误不进缓存）。
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

fn source_fetch_gate() -> &'static Semaphore {
    SOURCE_FETCH.get_or_init(|| Semaphore::new(4))
}

/// 脚本快照落盘目录。源脚本托管在 GitHub raw，冷启动每次都要重新下载，网络
/// 一抖就是十几秒甚至直接失败；有磁盘快照就能把「重启后第一次点播」压到本地
/// 读文件的时间。
///
/// 单测里固定到自己的临时根：`DATA_DIR` 是进程级环境变量，`config` 的测试会
/// 把它改成各自的临时目录，并行跑时快照会被写到别人的目录里、甚至写到已被删掉的
/// 目录（表现为 `open snapshot: NotFound` 的假失败，2026-11-22 实测）。
fn snapshot_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(dir) = TEST_SNAPSHOT_DIR.get() {
        return dir.clone();
    }
    crate::store::data_dir().join("spider-src")
}

#[cfg(test)]
static TEST_SNAPSHOT_DIR: OnceLock<PathBuf> = OnceLock::new();

/// URL → 稳定文件名：XXH3（`xxhash-rust`，主流、快，非加密用途足够）。只用于映射
/// 磁盘快照文件名，不承担安全职责。
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

    let headers = site.get("headers").and_then(Value::as_object).map(|map| {
        map.iter()
            .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
            .collect::<HashMap<String, String>>()
    });
    // 闸门只罩住网络这一段：快照命中/本地读文件不该排在限流后面。
    let fetched = {
        let _permit = source_fetch_gate().acquire().await.map_err(|err| {
            AppError::new(code::INTERNAL, "py source fetch gate closed").with_cause(err.to_string())
        })?;
        let mut throttled = false;
        loop {
            let attempt = http::fetch(http::FetchRequest {
                url: api.clone(),
                method: None,
                headers: headers.clone(),
                body: None,
                timeout_ms: Some(10_000),
            })
            .await;
            match attempt {
                // 429/503 = 镜像限流/过载。原样重试只会更糟，退避一次足够穿过
                // 瞬时限流；仍失败就走快照兜底。
                Ok(response) if !throttled && matches!(response.status, 429 | 503) => {
                    throttled = true;
                    tracing::warn!(
                        url = %api,
                        status = response.status,
                        "py source fetch throttled, retrying once after backoff"
                    );
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
                other => break other,
            }
        }
    };
    let response = match fetched {
        Ok(response) => response,
        Err(err) => {
            // 脚本托管在 GitHub raw，网络抖动/代理不可用是常态。此时手里有
            // 磁盘快照（哪怕已过期）也比整个源不可用强（2026-11-14 实测：
            // 一次 `fetch bubuzhuiju.py failed` 会让详情和播放同时失败）。
            // 兜底来源从「内存表」改成「磁盘」：moka 里过期的条目读不到了，
            // 而磁盘快照的覆盖面至少等价（写内存的路径都同时写盘）。
            if let Some((text, _)) = &snapshot {
                tracing::warn!(url = %api, error = %err, "py source fetch failed, using stale snapshot");
                return Ok(Source::Stale(text.clone()));
            }
            return Err(err);
        }
    };

    // 非 2xx 不能当脚本文本：镜像/网关会用 403/502 的纯文本指错页回话
    // （`gh-proxy.com` 现在就这样），送进 `looks_like_spider` 只会得到
    // 「does not define a Spider class」这种假诊断，还会丢掉过期快照兜底。
    if !(200..300).contains(&response.status) {
        if let Some((text, _)) = &snapshot {
            tracing::warn!(
                url = %api,
                status = response.status,
                "py source fetch returned non-2xx, using stale snapshot"
            );
            return Ok(Source::Stale(text.clone()));
        }
        return Err(AppError::new(
            code::CONFIG_FETCH_FAIL,
            format!("py source fetch failed: HTTP {}", response.status),
        )
        .with_cause(response.body.chars().take(160).collect::<String>()));
    }

    if !looks_like_spider(&response.body) {
        let head: String = response.body.chars().take(160).collect();
        return Err(AppError::new(
            code::RUNTIME_UNAVAILABLE,
            "py source does not define a Spider class",
        )
        .with_cause(format!("body starts with: {head}")));
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

/// py 源返回值归一：契约映射只在 Rust 这一份实现里做，适配层只负责执行脚本。
///
/// 形状不对时返回空信封而不是错误——一个坏源不该拖垮整轮聚合。空详情本身合法
/// （发现型源没有 detailContent），但不能悄无声息，所以仍记一条 INFO，带脚本 URL
/// 和 vodId：适配层的 `spider.log` 只收脚本异常，这条是宿主侧的归一化诊断，落宿主
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
    /// `junk` 给不是脚本的内容，`gate` 给 403 + 指错页文本）。命中次数记在
    /// **调用方传入的计数器**上——用全局静态会被并行测试互相污染（第一版
    /// 就因此得到 3 次命中的假阴性）。
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
                    let (status, body) = match mode {
                        "ok" => (StatusCode::OK, "class Spider:\n    pass\n"),
                        "gate" => (
                            StatusCode::FORBIDDEN,
                            "Access to proxy rules is forbidden on this hostname",
                        ),
                        // 第一次 429、之后正常：用来验证「被限流时退避重试一次」。
                        "throttle" => {
                            if hits.load(std::sync::atomic::Ordering::SeqCst) == 1 {
                                (StatusCode::TOO_MANY_REQUESTS, "rate limited")
                            } else {
                                (StatusCode::OK, "class Spider:\n    pass\n")
                            }
                        }
                        _ => (StatusCode::OK, "<!doctype html><html>gate page</html>"),
                    };
                    Response::builder()
                        .status(status)
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

    /// 把快照目录钉在本进程的临时根上（只在本模块测试里用）。
    fn isolate_snapshot_dir() {
        TEST_SNAPSHOT_DIR.get_or_init(|| {
            let dir = std::env::temp_dir().join(format!("luma-spider-src-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&dir);
            dir
        });
    }

    /// 把快照写成「已过期」，这样 `source_for` 不会在 TTL 内提前返回 Fresh。
    fn write_stale_snapshot(url: &str, text: &str) {
        isolate_snapshot_dir();
        write_snapshot(url, text);
        let path = snapshot_dir().join(format!("{}.py", snapshot_key(url)));
        let file = std::fs::File::options()
            .write(true)
            .open(&path)
            .expect("open snapshot");
        let aged = SystemTime::now() - (SOURCE_TTL + Duration::from_secs(60));
        file.set_modified(aged).expect("age snapshot");
    }

    fn forget_snapshot(url: &str) {
        isolate_snapshot_dir();
        let path = snapshot_dir().join(format!("{}.py", snapshot_key(url)));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn throttled_fetch_retries_once_then_succeeds() {
        // 镜像对集中拉取会回 429。退避一次就能穿过瞬时限流，不该直接把整个源
        // 判死（429 也没有磁盘快照可兜底时就是用户点哪都失败）。
        let hits = Arc::new(AtomicUsize::new(0));
        let (url, task) = stub("throttle", hits.clone()).await;
        let site = json!({ "api": url.clone() });
        let source = source_for(&site).await.expect("429 后应退避重试成功");
        assert!(source.contains("class Spider"), "{source}");
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            2,
            "429 只该重试一次"
        );
        task.abort();
        forget_snapshot(&url);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_same_url_downloads_once() {
        // moka `try_get_with` 的核心承诺：同 key 并发首次访问只跑一次求值。
        // 这条保证由库兑现，测试守的是「我们确实接到了它」，而不是重测库本身。
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

    #[tokio::test(flavor = "multi_thread")]
    async fn non_2xx_body_is_not_treated_as_script() {
        // 镜像/网关的 403 指错页（`gh-proxy.com` 现状）既不是脚本，也不能
        // 当「源里没有 Spider 类」上报——那是诊断误导。没有快照时必须给出
        // 带状态码的取数失败，而不是 RUNTIME_UNAVAILABLE。
        let hits = Arc::new(AtomicUsize::new(0));
        let (url, task) = stub("gate", hits.clone()).await;
        let site = json!({ "api": url.clone() });
        let err = source_for(&site).await.expect_err("403 must fail");
        assert_eq!(err.code, code::CONFIG_FETCH_FAIL);
        assert!(
            err.message.contains("403"),
            "错误要带上状态码，实际：{}",
            err.message
        );
        task.abort();
        forget_snapshot(&url);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn non_2xx_falls_back_to_stale_snapshot() {
        // 过期快照的兜底此前只在「网络层报错」时生效；403 是 Ok 响应，
        // 于是明明手里有可用脚本却整源不可用（首页/详情一起挂）。
        let hits = Arc::new(AtomicUsize::new(0));
        let (url, task) = stub("gate", hits.clone()).await;
        write_stale_snapshot(&url, "class Spider:\n    pass\n");
        let site = json!({ "api": url.clone() });
        let source = source_for(&site).await.expect("stale snapshot must rescue");
        assert!(source.contains("class Spider"));
        assert!(
            hits.load(std::sync::atomic::Ordering::SeqCst) >= 1,
            "应先尝试回源"
        );
        task.abort();
        forget_snapshot(&url);
    }
}
