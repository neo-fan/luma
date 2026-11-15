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
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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
static EPG_RAW_CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();

fn epg_cache() -> &'static Mutex<HashMap<String, (Instant, String)>> {
    EPG_RAW_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const EPG_TTL: Duration = Duration::from_secs(3 * 3600);

/// 磁盘缓存的有效期：6 小时。EPG 覆盖的是滚动九天，半天不更新也不会
/// 影响「正在播什么」；超过 6h 或文件损坏就重新拉。
const EPG_DISK_TTL: Duration = Duration::from_secs(6 * 3600);

/// 磁盘缓存文件名 = URL 的 sha1。EPG 地址是用户自己填的，不能拿来当
/// 文件名（有 `/`、`?` 与平台限制），哈希之后既稳定又不会撞名。
fn epg_disk_path(url: &str) -> PathBuf {
    use sha1::{Digest, Sha1};
    let digest = format!("{:x}", Sha1::digest(url.as_bytes()));
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
async fn load_epg_raw(state: &ConfigStore, epg_url: &str) -> Result<String, AppError> {
    let cached = {
        let guard = epg_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .get(epg_url)
            .filter(|(ts, _)| ts.elapsed() < EPG_TTL)
            .map(|(_, raw)| raw.clone())
    };
    if let Some(raw) = cached {
        return Ok(raw);
    }
    if let Some(raw) = read_epg_disk(epg_url) {
        let mut guard = epg_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.insert(epg_url.to_string(), (Instant::now(), raw.clone()));
        return Ok(raw);
    }
    let prefix = state.github_proxy();
    let url = ghproxy::apply(epg_url, &prefix).into_owned();
    let response = http::fetch(http::FetchRequest {
        url,
        method: None,
        headers: None,
        body: None,
        timeout_ms: Some(30_000),
    })
    .await?;
    let body = response.body;
    write_epg_disk(epg_url, &body);
    let mut guard = epg_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.insert(epg_url.to_string(), (Instant::now(), body.clone()));
    Ok(body)
}

/// Parsed programmes for one channel/day.
///
/// The raw XMLTV is ~7.6 MB and Python needs two streaming passes over it
/// (~0.5 s); zapping between channels would pay that on every click. Keyed by
/// `url | channel | date` because the adapter already filtered by date.
static EPG_RESULT_CACHE: OnceLock<Mutex<HashMap<String, (Instant, Value)>>> = OnceLock::new();

fn epg_result_cache() -> &'static Mutex<HashMap<String, (Instant, Value)>> {
    EPG_RESULT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const EPG_RESULT_TTL: Duration = Duration::from_secs(30 * 60);

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

    let raw = load_epg_raw(state.inner(), &epg_url).await?;

    let key = format!("{epg_url}\u{1}{channel}\u{1}{}", date.clone().unwrap_or_default());
    {
        let guard = epg_result_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((ts, cached)) = guard.get(&key) {
            if ts.elapsed() < EPG_RESULT_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let parsed = epg::parse(&raw, &channel, date.as_deref());

    let mut guard = epg_result_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Bound the map: a user zapping through a few hundred channels in one
    // session must not accumulate hundreds of programme lists.
    if guard.len() >= 64 {
        guard.clear();
    }
    guard.insert(key, (Instant::now(), parsed.clone()));
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
            epg_disk_path(raw).extension().and_then(|value| value.to_str()),
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
}
