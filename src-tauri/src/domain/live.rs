//! Live playlist entry (spec 7.2 `live.parseM3u` / 8.x 直播).
//!
//! Rust fetches the m3u/txt list (per-entry UA from the config), the Python
//! adapter does the parsing — the same split used for CMS.

use crate::bridge;
use crate::error::{code, AppError};
use crate::http;
use serde_json::{json, Value};
use std::collections::HashMap;
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

    bridge::call(
        "live.parseM3u",
        json!({ "raw": response.body, "url": url }),
    )
    .await
}

/// In-memory cache of the raw XMLTV payload, keyed by EPG url. Programme lists
/// can be tens of MB, so we download once per `EPG_TTL` and let Python stream-
/// match a channel on every request instead of re-fetching the whole file.
static EPG_RAW_CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();

fn epg_cache() -> &'static Mutex<HashMap<String, (Instant, String)>> {
    EPG_RAW_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const EPG_TTL: Duration = Duration::from_secs(3 * 3600);

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
pub async fn live_epg_warm(epg_url: String) -> Result<(), AppError> {
    if !(epg_url.starts_with("http://") || epg_url.starts_with("https://")) {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "epg url must be http(s)",
        ));
    }
    let fresh = {
        let guard = epg_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .get(&epg_url)
            .is_some_and(|(ts, _)| ts.elapsed() < EPG_TTL)
    };
    if fresh {
        return Ok(());
    }
    let response = http::fetch(http::FetchRequest {
        url: epg_url.clone(),
        method: None,
        headers: None,
        body: None,
        timeout_ms: Some(30_000),
    })
    .await?;
    let mut guard = epg_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard.insert(epg_url, (Instant::now(), response.body));
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
) -> Result<Value, AppError> {
    if !(epg_url.starts_with("http://") || epg_url.starts_with("https://")) {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "epg url must be http(s)",
        ));
    }

    let cached = {
        let guard = epg_cache()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .get(&epg_url)
            .filter(|(ts, _)| ts.elapsed() < EPG_TTL)
            .map(|(_, raw)| raw.clone())
    };

    let raw = match cached {
        Some(raw) => raw,
        None => {
            let response = http::fetch(http::FetchRequest {
                url: epg_url.clone(),
                method: None,
                headers: None,
                body: None,
                timeout_ms: Some(30_000),
            })
            .await?;
            let body = response.body;
            let mut guard = epg_cache()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.insert(epg_url.clone(), (Instant::now(), body.clone()));
            body
        }
    };

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

    let parsed = bridge::call(
        "live.parseEpg",
        json!({ "raw": raw, "channel": channel, "date": date }),
    )
    .await?;

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
