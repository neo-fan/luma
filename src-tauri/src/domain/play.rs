//! Playback resolution and external player fallback (spec 10 / T-09).
//!
//! The webview never talks to a third-party host directly: every playable
//! URL is wrapped into the local proxy so anti-leech headers survive.

use crate::config::ConfigStore;
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

/// Split a TVBox `scheme://target` parse link.
///
/// Returns `None` for plain `http`/`https` URLs (resolved directly through the
/// proxy) and for anything without a `://`. For a custom scheme (e.g.
/// `huangdou2://https://...`) it returns `(scheme, target)` so the caller can
/// look the scheme up as a parser name in `parses[]`. We split on the first
/// `://` deliberately instead of using `Url::parse`: `Url::parse` treats
/// `huangdou2://https://...` as a relative reference and rewrites the scheme to
/// `https`, which would split off the wrong target.
fn split_scheme_link(url: &str) -> Option<(String, String)> {
    let idx = url.find("://")?;
    let scheme = &url[..idx];
    // RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ).
    // Without this check a URL with an embedded `://` in its query — e.g.
    // `magnet:?xt=...&tr=udp://tracker.example` — is mistaken for a named
    // parse link and produces a bogus "available parsers" error.
    let mut chars = scheme.chars();
    if !matches!(chars.next(), Some(c) if c.is_ascii_alphabetic()) {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
        return None;
    }
    if scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let target = url[idx + 3..].to_string();
    Some((scheme.to_string(), target))
}

/// Protocols a WebView-based player cannot open. Report them explicitly instead
/// of sending them through the parse pool / sniffer (which only wastes 15s).
fn non_web_media_scheme(url: &str) -> Option<&'static str> {
    const BLOCKED: &[&str] = &["magnet:", "ed2k:", "thunder:", "ftp:", "file:", "qbittorrent:"];
    let lower = url.trim_start().to_ascii_lowercase();
    BLOCKED.iter().copied().find(|prefix| lower.starts_with(prefix))
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
    configs: tauri::State<'_, ConfigStore>,
    request: PlayRequest,
) -> Result<PlayResolved, AppError> {
    // Explicit headers the spider supplied (and any the source parser returns
    // later) flow through here so config host rules can fill the rest.
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

    // A play URL whose scheme is not http/https is a TVBox parse link: the
    // scheme names a parser in `parses[]` and the remainder is the target page
    // (e.g. `huangdou2://<real page>`). Resolve it through the parse pool first.
    let mut effective_url = request.url.clone();
    if let Some((scheme, target)) = split_scheme_link(&request.url) {
        if target.is_empty() {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                format!("play url scheme {} has no target after '://'", scheme),
            ));
        }
        let base: HashMap<String, String> = explicit.iter().cloned().collect();
        match crate::parse::resolve_scheme_link(&app, &configs.active_parses(), &scheme, &target, base).await
        {
            Ok(hit) => {
                effective_url = hit.url.clone();
                // Parser-provided headers (UA/Referer/Cookie for the stream)
                // take precedence; dedupe case-insensitively keeping the last.
                for (k, v) in &hit.headers {
                    if let Some(slot) = explicit
                        .iter_mut()
                        .find(|(key, _)| key.eq_ignore_ascii_case(k))
                    {
                        slot.1 = v.clone();
                    } else {
                        explicit.push((k.clone(), v.clone()));
                    }
                }
                tracing::info!(scheme = %scheme, parser = %hit.parser, "resolved scheme parse link");
            }
            Err(err) => {
                let names = configs
                    .active_parses()
                    .iter()
                    .filter_map(|p| p.get("name").and_then(|n| n.as_str()))
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(AppError::new(
                    code::RUNTIME_UNAVAILABLE,
                    format!(
                        "play url scheme `{}` could not be resolved; available parsers: [{}]",
                        scheme, names
                    ),
                )
                .with_cause(err.message));
            }
        }
    }

    if let Some(prefix) = non_web_media_scheme(&effective_url) {
        return Err(AppError::new(
            code::PLAY_RESOLVE_FAIL,
            format!(
                "源返回 {} 链接，桌面播放器不支持，请换源",
                prefix.trim_end_matches(':')
            ),
        ));
    }

    let parsed = Url::parse(&effective_url)
        .map_err(|err| AppError::new(code::INVALID_ARGUMENT, "play url is invalid").with_cause(err.to_string()))?;

    // Some sources hand back TVBox's own local proxy URL already
    // (`http://127.0.0.1:<port>/proxy?do=py&...`). That endpoint is playable by
    // itself — wrapping it in another proxy layer would 403.
    if matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost"))
        && parsed.path() == "/proxy"
    {
        return Ok(PlayResolved {
            url: effective_url.clone(),
            proxy_url: effective_url.clone(),
            kind: kind_of(&effective_url),
            headers: explicit,
        });
    }

    if parsed.host_str().is_none() {
        return Err(AppError::new(code::INVALID_ARGUMENT, "play url has no host"));
    }
    let port = state.port();

    // Levels 1-3 already ran inside the spider (the URL we get here is either a
    // direct stream or a play page). A `page` URL means all of them failed, so
    // this is where level 4 kicks in.
    let mut kind = classify(&parsed).to_string();
    if kind == "page" {
        let cached = cached_sniff(&effective_url);
        let media = match cached {
            Some(media) => Some(media),
            None => match crate::sniff::sniff(&app, &effective_url, SNIFF_TIMEOUT).await {
                Ok(media) => {
                    remember_sniff(&effective_url, &media);
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

    // `explicit` already carries the spider-supplied headers (and any the source
    // parser returned). Config host rules fill in what was not supplied: a few
    // CDNs only accept their own UA/Referer, and without them a perfectly valid
    // m3u8 still answers 403.
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

    #[test]
    fn split_scheme_link_handles_parse_links() {
        assert_eq!(
            split_scheme_link("huangdou2://https://example.com/page"),
            Some(("huangdou2".to_string(), "https://example.com/page".to_string()))
        );
        assert_eq!(
            split_scheme_link("huangdou2://page-only"),
            Some(("huangdou2".to_string(), "page-only".to_string()))
        );
        // Empty target is still split out; the caller rejects it explicitly.
        assert_eq!(
            split_scheme_link("huangdou2://"),
            Some(("huangdou2".to_string(), "".to_string()))
        );
        // Plain http/https are resolved directly, not as parse links.
        assert_eq!(split_scheme_link("http://example.com/x"), None);
        assert_eq!(split_scheme_link("https://example.com/x"), None);
        assert_eq!(split_scheme_link("HTTP://example.com/x"), None);
        // No scheme separator at all.
        assert_eq!(split_scheme_link("just-a-relative-path"), None);
    }

    #[test]
    fn split_scheme_link_rejects_embedded_scheme_in_query() {
        // A `://` buried in a query string is not a scheme separator.
        assert_eq!(
            split_scheme_link("magnet:?xt=urn:btih:abc&tr=udp://tracker.example.com/announce"),
            None
        );
        assert_eq!(
            split_scheme_link("https://a.example/x?next=https://b.example/y"),
            None
        );
        // RFC 3986 scheme syntax: must start with a letter, no separators.
        assert_eq!(split_scheme_link("1bad://target"), None);
        assert_eq!(split_scheme_link("bad_scheme://target"), None);
        assert_eq!(split_scheme_link("bad?query://target"), None);
        // `+` / `-` / `.` are legal inside a scheme.
        assert_eq!(
            split_scheme_link("json+player://page"),
            Some(("json+player".to_string(), "page".to_string()))
        );
    }

    #[test]
    fn non_web_media_schemes_get_an_actionable_error() {
        assert_eq!(non_web_media_scheme("magnet:?xt=urn:btih:abc"), Some("magnet:"));
        assert_eq!(non_web_media_scheme("ED2K://|file|abc|/"), Some("ed2k:"));
        assert_eq!(non_web_media_scheme("  thunder://abc"), Some("thunder:"));
        assert_eq!(non_web_media_scheme("https://example.com/a.m3u8"), None);
        assert_eq!(non_web_media_scheme("huangdou2://https://example.com/p"), None);
    }
}
