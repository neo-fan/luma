//! Live playlist entry (spec 7.2 `live.parseM3u` / 8.x 直播).
//!
//! Rust fetches the m3u/txt list (per-entry UA from the config) and parses it
//! in-process. Parsing used to be a `live.parseM3u` round-trip to the Python
//! adapter; a playlist is pure framework work (no third-party script), so it
//! belongs here — the sidecar only runs user/community spiders.
//!
//! XMLTV 节目单有两层缓存：内存表（3h，跨频道切换复用）和磁盘（6h，重启
//! 后不用再把 7.6 MB 的 `e.xml` 从 GitHub 拉一遍）。GitHub 地址统一走设置里
//! 的加速前缀。

#[path = "live/m3u.rs"]
mod m3u;

#[path = "live/epg.rs"]
mod epg;

use crate::config::ConfigStore;
use crate::error::{code, AppError};
use crate::ghproxy;
use crate::http;
use moka::future::Cache;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

#[tauri::command]
pub async fn live_parse(url: String, ua: Option<String>) -> Result<Value, AppError> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "live url must be http(s)",
        ));
    }

    let mut headers = HashMap::new();
    if let Some(ua) = ua.filter(|value| !value.trim().is_empty()) {
        headers.insert("User-Agent".to_string(), ua);
    }

    let response = http::fetch(http::FetchRequest {
        url: url.clone(),
        method: None,
        headers: Some(headers),
        body: None,
        timeout_ms: Some(20_000),
    })
    .await?;

    Ok(m3u::parse(&response.body, &url))
}

/// In-memory cache of the raw XMLTV payload, keyed by EPG url. Programme lists
/// can be tens of MB, so we download once per `EPG_TTL` and let Python stream-
/// match a channel on every request instead of re-fetching the whole file.
///
/// 同 key 的并发首次访问由 moka `try_get_with` 合并成一次下载：`e.xml` 实测约
/// 7.6 MB，重复拉取是最贵的一种浪费。求值失败不进缓存（`Err` 不写回），下一次
/// 仍然回源——保留原「未命中即重取」的行为。
/// 值用 `Arc<String>`：7.6 MB 的表每次命中都克隆一份，几十次换台就是数百 MB 的
/// 分配/释放压力；Arc 只加一次引用计数。
static EPG_RAW_CACHE: OnceLock<Cache<String, Arc<String>>> = OnceLock::new();

fn epg_raw_cache() -> &'static Cache<String, Arc<String>> {
    EPG_RAW_CACHE.get_or_init(|| {
        Cache::builder()
            // 按字节加权而不是条数：一条 e.xml 就有 ~7.6 MB，用条数封顶等于
            // 无界吃内存。给一个明确的总字节预算（约 6 条满量的节目单），超出
            // 由 moka 按策略淘汰最久未用的条目。
            .max_capacity(MAX_EPG_RAW_BYTES)
            .weigher(|_key: &String, value: &Arc<String>| -> u32 {
                value.len().try_into().unwrap_or(u32::MAX)
            })
            .time_to_live(EPG_TTL)
            .build()
    })
}

const EPG_TTL: Duration = Duration::from_secs(3 * 3600);
/// 原始节目单内存缓存的字节预算。一条 `e.xml` ≈ 7.6 MB（见模块头注释与
/// `live_epg_warm` 里的实测），取 6 条满量 = 48 MB 作为上限，避免无界增长。
const MAX_EPG_RAW_BYTES: u64 = 48 * 1024 * 1024;

/// 磁盘缓存的有效期：6 小时。EPG 覆盖的是滚动九天，半天不更新也不会
/// 影响「正在播什么」；超过 6h 或文件损坏就重新拉。
const EPG_DISK_TTL: Duration = Duration::from_secs(6 * 3600);

/// 磁盘缓存文件名 = URL 的 XXH3（xxhash-rust）。EPG 地址是用户自己填的，不能拿来当
/// 文件名（有 `/`、`?` 与平台限制），哈希之后既稳定又不会撞名。
fn epg_disk_path(url: &str) -> PathBuf {
    let digest = format!("{:016x}", xxhash_rust::xxh3::xxh3_64(url.as_bytes()));
    crate::store::data_dir()
        .join("cache")
        .join("epg")
        .join(format!("{digest}.xml"))
}

fn read_epg_disk(url: &str) -> Option<String> {
    let path = epg_disk_path(url);
    let age = std::fs::metadata(&path)
        .ok()?
        .modified()
        .ok()?
        .elapsed()
        .ok()?;
    if age > EPG_DISK_TTL {
        return None;
    }
    let raw = std::fs::read_to_string(&path).ok()?;
    // 写到一半被杀 / 源站返回错误页都可能留下半截文件，别拿去解析。
    raw.contains("<tv").then_some(raw)
}

fn write_epg_disk(url: &str, raw: &str) {
    let path = epg_disk_path(url);
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    // 先写临时文件再改名：中途失败不会把上一次的好缓存冲掉。
    let tmp = path.with_extension("xml.tmp");
    if std::fs::write(&tmp, raw).is_err() {
        return;
    }
    // Windows 上 rename 不覆盖已存在文件，先删旧的。
    let _ = std::fs::remove_file(&path);
    if let Err(err) = std::fs::rename(&tmp, &path) {
        tracing::warn!(error = %err, "epg disk cache write failed");
        let _ = std::fs::remove_file(&tmp);
    }
}

/// 取 XMLTV 原始表：内存 → 磁盘 → 网络（GitHub 地址走加速前缀）。
async fn load_epg_raw(state: &ConfigStore, epg_url: &str) -> Result<Arc<String>, AppError> {
    // 先查内存：命中就直接返回，不去读加速前缀（`github_proxy` 是一次 sqlite meta
    // 读，只在真要回源时才读）。未命中才用 `try_get_with` 合并并发首次访问成一次
    // 回源，求值失败不进缓存（下一次仍回源）。求值体 `cold_epg_raw` 内部保留「磁盘
    // → 网络」两级兜底：内存里过期的条目读不到（moka 直接淘汰），兜底来源仍是磁盘
    // 快照（磁盘 6h TTL 独立于内存 3h TTL）。
    let cache = epg_raw_cache();
    let key = epg_url.to_string();
    if let Some(raw) = cache.get(&key).await {
        return Ok(raw);
    }
    match cache
        .try_get_with(key, cold_epg_raw(epg_url.to_string(), state.github_proxy()))
        .await
    {
        Ok(raw) => Ok(raw),
        Err(err) => Err((*err).clone()),
    }
}

/// `load_epg_raw` 的实际取数链（磁盘快照 → 网络）。只在 moka 里没有有效条目
/// 时才会被跑到。
async fn cold_epg_raw(epg_url: String, prefix: String) -> Result<Arc<String>, AppError> {
    if let Some(raw) = read_epg_disk(&epg_url) {
        return Ok(Arc::new(raw));
    }
    let url = ghproxy::apply(&epg_url, &prefix).into_owned();
    let response = http::fetch(http::FetchRequest {
        url,
        method: None,
        headers: None,
        body: None,
        timeout_ms: Some(30_000),
    })
    .await?;
    // http::fetch 对 HTTP 错误状态仍返回 Ok(body)，由调用方自行判断。这里若把
    // 5xx/限流页当成功：错误体会被写盘并被内存缓存（求值失败才不缓存），
    // parse 出空节目单后再缓存 30 分钟——一次瞬态故障变成半小时「今天没节目」。
    // 非成功状态直接 Err：try_get_with 不缓存失败，下一轮仍会回源重试。
    if response.status >= 400 {
        return Err(AppError::new(
            code::CONFIG_FETCH_FAIL,
            format!("epg fetch {epg_url} -> HTTP {}", response.status),
        ));
    }
    let body = response.body;
    write_epg_disk(&epg_url, &body);
    Ok(Arc::new(body))
}

/// Parsed programmes for one channel/day.
///
/// The raw XMLTV is ~7.6 MB and Python needs two streaming passes over it
/// (~0.5 s); zapping between channels would pay that on every click. Keyed by
/// `url | channel | date` because the adapter already filtered by date.
///
/// 上限 64 条：一次会话里连切几百个频道不该堆出几百份节目单。用 moka 按访问频率
/// 逐条淘汰给内存封顶——不会一次把整张表冲掉、让老频道重新解析。
static EPG_RESULT_CACHE: OnceLock<Cache<String, Value>> = OnceLock::new();

fn epg_result_cache() -> &'static Cache<String, Value> {
    EPG_RESULT_CACHE.get_or_init(|| {
        Cache::builder()
            .max_capacity(EPG_RESULT_MAX_ENTRIES)
            .time_to_live(EPG_RESULT_TTL)
            .build()
    })
}

const EPG_RESULT_TTL: Duration = Duration::from_secs(30 * 60);
const EPG_RESULT_MAX_ENTRIES: u64 = 64;

/// Warm the raw XMLTV cache without parsing anything.
///
/// `e.xml` is ~7.6 MB; fetching it takes 10 s+ on a cold cache while the user is
/// already looking at the channel list. The live page calls this once on mount
/// so the first channel click only pays the ~0.5 s Python parse instead of the
/// whole download.
#[tauri::command]
pub async fn live_epg_warm(
    epg_url: String,
    state: tauri::State<'_, ConfigStore>,
) -> Result<(), AppError> {
    if !(epg_url.starts_with("http://") || epg_url.starts_with("https://")) {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "epg url must be http(s)",
        ));
    }
    // 与订阅导入同一个纠正点：用户手填 / 早期存下的畸形地址（`https://https://…`）
    // 在这里一起治好，之后取数与缓存都用纠正后的地址。
    let epg_url = crate::config::repair_url(&epg_url).unwrap_or(epg_url);
    load_epg_raw(state.inner(), &epg_url).await?;
    Ok(())
}

/// Fetch an XMLTV programme list and return today's programmes for one channel.
///
/// The raw payload is cached in-process (TTL 3h); `channel` matching and XML
/// parsing happen in Python (`live.parseEpg`) so the heavy work stays off the
/// Rust side. `date` is only a pass-through hint for the adapter.
#[tauri::command]
pub async fn live_epg(
    epg_url: String,
    channel: String,
    date: Option<String>,
    state: tauri::State<'_, ConfigStore>,
) -> Result<Value, AppError> {
    if !(epg_url.starts_with("http://") || epg_url.starts_with("https://")) {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "epg url must be http(s)",
        ));
    }
    // 同 `live_epg_warm`：畸形地址在入口治好，取数与结果缓存都用纠正后的地址。
    let epg_url = crate::config::repair_url(&epg_url).unwrap_or(epg_url);

    let raw = load_epg_raw(state.inner(), &epg_url).await?;

    let key = format!(
        "{epg_url}\u{1}{channel}\u{1}{}",
        date.clone().unwrap_or_default()
    );
    let cache = epg_result_cache();
    if let Some(cached) = cache.get(key.as_str()).await {
        return Ok(cached);
    }
    // 解析是纯 CPU：7.6 MB 两遍扫描（collect + match + programmes）要数百毫秒，
    // 直接在 async worker 上跑会占住线程，连切几个频道就把 worker 串满。
    let parsed = {
        let raw = Arc::clone(&raw);
        let channel = channel.clone();
        let date = date.clone();
        tauri::async_runtime::spawn_blocking(move || epg::parse(&raw, &channel, date.as_deref()))
            .await
            .map_err(|err| AppError::new(code::INTERNAL, format!("解析节目单失败：{err}")))?
    };
    cache.insert(key, parsed.clone()).await;
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epg_disk_path_is_stable_and_distinct() {
        let raw = "https://raw.githubusercontent.com/fanmingming/live/main/e.xml";
        let other = "https://example.com/epg.xml";
        assert_eq!(epg_disk_path(raw), epg_disk_path(raw));
        assert_ne!(epg_disk_path(raw), epg_disk_path(other));
        assert_eq!(
            epg_disk_path(raw)
                .extension()
                .and_then(|value| value.to_str()),
            Some("xml")
        );
    }

    #[test]
    fn epg_disk_path_lives_under_data_cache() {
        let path = epg_disk_path("https://example.com/epg.xml");
        let text = path.to_string_lossy().replace('\\', "/");
        assert!(text.contains("/cache/epg/"), "{text}");
        assert!(text.ends_with(".xml"), "{text}");
    }

    use axum::body::Body;
    use axum::http::{Response, StatusCode};
    use axum::routing::get;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 起一个能返回合法 XMLTV 的本地桩，命中次数记在**调用方传入的计数器**上。
    /// 用全局静态计数器会被并行测试互相污染（python.rs 第一版就因此得假阴性）。
    async fn ok_stub(hits: Arc<AtomicUsize>) -> (String, tokio::task::JoinHandle<()>) {
        let counter = hits.clone();
        let router = axum::Router::new().route(
            "/",
            get(move || {
                let hits = counter.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("content-type", "application/xml")
                        .body(Body::from("<tv>\n  <programme/>\n</tv>\n"))
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

    /// 接了 TCP 但一个字节都不回、立刻断开 —— 让 `http::fetch` 得到传输层错误。
    /// `http::fetch` 对 HTTP 5xx 仍返回 `Ok`，只有连接失败才返回 `Err`，所以「失败
    /// 不进缓存」这条必须用真·失败来测。
    async fn reject_stub(hits: Arc<AtomicUsize>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        let task = tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        hits.fetch_add(1, Ordering::SeqCst);
                        drop(stream);
                    }
                    Err(_) => break,
                }
            }
        });
        (format!("http://{addr}/"), task)
    }

    fn forget_epg_disk(url: &str) {
        let _ = std::fs::remove_file(epg_disk_path(url));
    }

    /// 与生产同构的本地缓存（同 weigher/TTL），测试用它避免污染全局 static。
    fn raw_cache(ttl: Duration) -> Cache<String, Arc<String>> {
        Cache::builder()
            .max_capacity(MAX_EPG_RAW_BYTES)
            .weigher(|_key: &String, value: &Arc<String>| -> u32 {
                value.len().try_into().unwrap_or(u32::MAX)
            })
            .time_to_live(ttl)
            .build()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn epg_raw_hit_within_ttl_does_not_refetch() {
        // (a) TTL 内命中不再回源：第一次冷取（磁盘无 → 网络），第二次应直接命中
        // moka，不再打桩。短 TTL 只为隔离，本例不需要等它过期。
        let hits = Arc::new(AtomicUsize::new(0));
        let (url, task) = ok_stub(hits.clone()).await;
        let cache = raw_cache(Duration::from_secs(30));
        let first = cache
            .try_get_with(url.clone(), cold_epg_raw(url.clone(), String::new()))
            .await
            .expect("cold");
        assert!(first.contains("<tv"));
        let second = cache
            .try_get_with(url.clone(), cold_epg_raw(url.clone(), String::new()))
            .await
            .expect("warm");
        assert!(second.contains("<tv"));
        cache.run_pending_tasks().await;
        assert_eq!(hits.load(Ordering::SeqCst), 1, "TTL 内命中不应再次回源");
        task.abort();
        forget_epg_disk(&url);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn epg_raw_concurrent_same_url_downloads_once() {
        // (b) 同 key 并发只回源一次：7.6 MB 的节目单重复下载最贵，`try_get_with`
        // 的合并语义保证同 key 并发共享一次回源。
        let hits = Arc::new(AtomicUsize::new(0));
        let (url, task) = ok_stub(hits.clone()).await;
        let cache = raw_cache(Duration::from_secs(30));
        let results = tokio::join!(
            cache.try_get_with(url.clone(), cold_epg_raw(url.clone(), String::new())),
            cache.try_get_with(url.clone(), cold_epg_raw(url.clone(), String::new())),
            cache.try_get_with(url.clone(), cold_epg_raw(url.clone(), String::new())),
            cache.try_get_with(url.clone(), cold_epg_raw(url.clone(), String::new())),
        );
        for result in [results.0, results.1, results.2, results.3] {
            assert!(result.expect("source").contains("<tv"));
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1, "同 URL 并发只应回源一次");
        task.abort();
        forget_epg_disk(&url);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn epg_raw_failure_is_not_cached() {
        // (c) 失败不进缓存：连接失败必须返回 Err 且不写回，第二次继续回源。
        let hits = Arc::new(AtomicUsize::new(0));
        let (url, task) = reject_stub(hits.clone()).await;
        let cache = raw_cache(Duration::from_secs(30));
        cache
            .try_get_with(url.clone(), cold_epg_raw(url.clone(), String::new()))
            .await
            .expect_err("connection failure must error");
        let second = cache
            .try_get_with(url.clone(), cold_epg_raw(url.clone(), String::new()))
            .await
            .err();
        assert!(second.is_some(), "第二次仍应回源并再次失败");
        cache.run_pending_tasks().await;
        assert_eq!(cache.entry_count(), 0, "失败不应留下任何条目");
        assert!(
            hits.load(Ordering::SeqCst) >= 2,
            "失败不进缓存：第二次必须重新回源"
        );
        task.abort();
        forget_epg_disk(&url);
    }
}
