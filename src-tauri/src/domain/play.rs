//! Playback resolution and external player fallback (spec 10 / T-09).
//!
//! The webview never talks to a third-party host directly: every playable
//! URL is wrapped into the local proxy so anti-leech headers survive.

use crate::error::{code, AppError};
use crate::proxy::{self, ProxyState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use url::Url;

/// Spec 8.6 level 4. The spec gives no separate budget for the hidden WebView,
/// so reuse the 15s single-source wall clock; a successful sniff is cached so
/// re-entering the player for the same page does not open a window again.
const SNIFF_TIMEOUT: Duration = Duration::from_secs(15);
const SNIFF_TTL: Duration = Duration::from_secs(600);

struct SniffHit {
    media: String,
    found_at: Instant,
}

fn sniff_cache() -> &'static Mutex<HashMap<String, SniffHit>> {
    static CACHE: OnceLock<Mutex<HashMap<String, SniffHit>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_sniff(page: &str) -> Option<String> {
    let guard = sniff_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    guard
        .get(page)
        .filter(|hit| hit.found_at.elapsed() < SNIFF_TTL)
        .map(|hit| hit.media.clone())
}

fn remember_sniff(page: &str, media: &str) {
    let mut guard = sniff_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.len() >= 128 {
        guard.clear();
    }
    guard.insert(
        page.to_string(),
        SniffHit {
            media: media.to_string(),
            found_at: Instant::now(),
        },
    );
}

fn kind_of(url: &str) -> String {
    Url::parse(url)
        .map(|parsed| classify(&parsed).to_string())
        .unwrap_or_else(|_| "page".to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    pub site_key: String,
    pub url: String,
    #[serde(default)]
    pub ua: Option<String>,
    #[serde(default)]
    pub referer: Option<String>,
    #[serde(default)]
    pub cookie: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayResolved {
    pub url: String,
    pub proxy_url: String,
    /// `hls` for m3u8, `flv` for flv, `file` for direct media, `page` otherwise.
    pub kind: String,
    pub headers: Vec<(String, String)>,
}

#[tauri::command]
pub async fn resolve_play(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<ProxyState>>,
    request: PlayRequest,
) -> Result<PlayResolved, AppError> {
    let parsed = Url::parse(&request.url)
        .map_err(|err| AppError::new(code::INVALID_ARGUMENT, "play url is invalid").with_cause(err.to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            format!("play url scheme {} is not supported", parsed.scheme()),
        ));
    }

    // Some sources hand back TVBox's own local proxy URL already
    // (`http://127.0.0.1:<port>/proxy?do=py&...`). That endpoint is playable by
    // itself — wrapping it in another proxy layer would 403.
    if matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost"))
        && parsed.path() == "/proxy"
    {
        return Ok(PlayResolved {
            url: request.url.clone(),
            proxy_url: request.url.clone(),
            kind: kind_of(&request.url),
            headers: Vec::new(),
        });
    }

    if parsed.host_str().is_none() {
        return Err(AppError::new(code::INVALID_ARGUMENT, "play url has no host"));
    }
    let port = state.port();

    // Levels 1-3 already ran inside the spider (the URL we get here is either a
    // direct stream or a play page). A `page` URL means all of them failed, so
    // this is where level 4 kicks in.
    let mut effective_url = request.url.clone();
    let mut kind = classify(&parsed).to_string();
    if kind == "page" {
        let cached = cached_sniff(&request.url);
        let media = match cached {
            Some(media) => Some(media),
            None => match crate::sniff::sniff(&app, &request.url, SNIFF_TIMEOUT).await {
                Ok(media) => {
                    remember_sniff(&request.url, &media);
                    Some(media)
                }
                Err(err) => {
                    tracing::info!(
                        site = %request.site_key,
                        error = %err.message,
                        "level-4 sniff found nothing"
                    );
                    None
                }
            },
        };
        if let Some(media) = media {
            kind = kind_of(&media);
            effective_url = media;
        }
    }

    // Only what the spider actually supplied counts as explicit. Defaults are
    // applied after the config table, otherwise `okhttp/3.15` would overwrite
    // the per-host UA a config ships for anti-leech CDNs.
    let mut explicit: Vec<(String, String)> = Vec::new();
    if let Some(ua) = request.ua.clone() {
        explicit.push(("User-Agent".to_string(), ua));
    }
    if let Some(referer) = request.referer.clone() {
        explicit.push(("Referer".to_string(), referer));
    }
    if let Some(cookie) = request.cookie.clone() {
        explicit.push(("Cookie".to_string(), cookie));
    }
    // Config host rules fill in what the spider did not: a few CDNs only accept
    // their own UA/Referer (`media.example.com`, `*.example.com`), and without
    // them a perfectly valid m3u8 still answers 403.
    let headers = crate::netrules::with_defaults(
        &parsed,
        crate::netrules::merged_for(&effective_url, &explicit),
    );

    // The proxy re-applies the same rules, so only forward what the spider
    // explicitly asked for — otherwise the query string pins the default UA.
    let proxy_url = proxy::build_proxy_url(
        port,
        &effective_url,
        request.ua.as_deref(),
        request.referer.as_deref(),
        request.cookie.as_deref(),
    );

    tracing::debug!(site = %request.site_key, kind, "resolved play url");
    Ok(PlayResolved {
        url: effective_url,
        proxy_url,
        kind,
        headers,
    })
}

fn classify(url: &Url) -> &'static str {
    let path = url.path().to_ascii_lowercase();
    let full = format!("{}{}", path, url.query().unwrap_or_default()).to_ascii_lowercase();
    if full.contains(".m3u8") || full.contains("m3u8") {
        "hls"
    } else if full.contains(".flv") || full.contains("flv") {
        "flv"
    } else if [".mp4", ".mkv", ".ts", ".mov", ".webm"]
        .iter()
        .any(|ext| path.ends_with(ext))
    {
        "file"
    } else {
        "page"
    }
}

/// Hand the current URL to the system browser / default handler.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), AppError> {
    let parsed = Url::parse(&url)
        .map_err(|err| AppError::new(code::INVALID_ARGUMENT, "url is invalid").with_cause(err.to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            format!("scheme {} cannot be opened", parsed.scheme()),
        ));
    }

    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn();

    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg(&url).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = std::process::Command::new("xdg-open").arg(&url).spawn();

    status
        .map(|_| ())
        .map_err(|err| AppError::new(code::INTERNAL, "open external failed").with_cause(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_detects_stream_kinds() {
        let hls = Url::parse("http://127.0.0.1:8787/play.m3u8").unwrap();
        assert_eq!(classify(&hls), "hls");
        let flv = Url::parse("http://127.0.0.1:8787/live/room.flv?token=1").unwrap();
        assert_eq!(classify(&flv), "flv");
        let file = Url::parse("http://127.0.0.1:8787/a/b.mp4").unwrap();
        assert_eq!(classify(&file), "file");
        let page = Url::parse("http://127.0.0.1:8787/play?url=abc").unwrap();
        assert_eq!(classify(&page), "page");
    }
}
