//! Local HTTP reverse proxy (spec 7.5 / T-08).
//!
//! Binds `127.0.0.1:9978`; when the port is taken it falls back to an
//! ephemeral port and publishes the real one through `proxy_status`.
//! Only loopback is bound. Targets are validated against a whitelist that
//! rejects loopback / private / link-local / multicast addresses, unless
//! `LUMA_PROXY_ALLOW_LOCAL=1` is set (development and stub tests only).

use crate::error::{code, AppError};
use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;
use url::Url;

pub const DEFAULT_PORT: u16 = 9978;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(20);
// The fallback UA and the "fill in defaults" helper live in `netrules` so the
// resolver and the proxy cannot drift apart. Some CDNs answer garbage (or a
// 403 body that hls.js reports as `fragParsingError`) when no UA is present.

/// Headers copied from the browser to the upstream request.
const PASSTHROUGH: [&str; 5] = [
    "range",
    "if-range",
    "accept",
    "accept-language",
    "if-modified-since",
];

/// Headers copied from the upstream response back to the client.
const DOWNSTREAM: [&str; 10] = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "last-modified",
    "etag",
    "content-disposition",
    "date",
    "expires",
];

pub struct ProxyState {
    port: AtomicU16,
    allow_local: bool,
    client: reqwest::Client,
}

/// Port the proxy actually bound. Sidecars need it to build
/// `getProxyUrl()` / `proxy?do=…` URLs; the requested `PROXY_PORT` is only a
/// preference (a busy port falls back to an ephemeral one).
static ACTIVE_PORT: AtomicU16 = AtomicU16::new(0);

pub fn active_port() -> u16 {
    match ACTIVE_PORT.load(Ordering::Relaxed) {
        0 => DEFAULT_PORT,
        port => port,
    }
}

impl ProxyState {
    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(UPSTREAM_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    pub fn allow_local(&self) -> bool {
        self.allow_local
    }
}

#[derive(Debug, Deserialize)]
struct ProxyQuery {
    url: String,
    ua: Option<String>,
    referer: Option<String>,
    cookie: Option<String>,
    /// Base64 payload of extra headers as a JSON object, used by py/js/jar
    /// runtimes that need more than ua/referer/cookie.
    h: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    pub port: u16,
    pub base_url: String,
    pub allow_local: bool,
}

/// Start the proxy on the Tauri runtime; failures are surfaced to the caller.
pub fn start() -> Result<Arc<ProxyState>, AppError> {
    let allow_local = crate::env::is_enabled("PROXY_ALLOW_LOCAL");

    let listener = bind_listener()?;
    let port = listener
        .local_addr()
        .map_err(|err| AppError::new(code::INTERNAL, "proxy local_addr failed").with_cause(err.to_string()))?
        .port();

    let state = Arc::new(ProxyState {
        port: AtomicU16::new(port),
        allow_local,
        client: ProxyState::client(),
    });
    ACTIVE_PORT.store(port, Ordering::Relaxed);

    let shared = state.clone();
    // `setup` runs outside the Tokio context, so the std listener is handed to
    // the async task and adopted there.
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(err) => {
                tracing::error!(error = %err, "proxy could not adopt listener");
                return;
            }
        };
        let router = Router::new()
            .route("/proxy", get(handle_proxy).options(handle_options))
            .route("/image", get(handle_image).options(handle_options))
            .route("/health", get(handle_health))
            .with_state(shared.clone());
        if let Err(err) = axum::serve(listener, router).await {
            tracing::error!(error = %err, "local proxy stopped");
        }
    });

    tracing::info!(port, allow_local, "local proxy listening on 127.0.0.1");
    Ok(state)
}

fn bind_listener() -> Result<std::net::TcpListener, AppError> {
    let primary = format!("127.0.0.1:{DEFAULT_PORT}");
    match std::net::TcpListener::bind(&primary) {
        Ok(listener) => {
            listener
                .set_nonblocking(true)
                .map_err(|err| AppError::new(code::INTERNAL, "proxy set_nonblocking failed").with_cause(err.to_string()))?;
            Ok(listener)
        }
        Err(err) => {
            tracing::warn!(port = DEFAULT_PORT, error = %err, "proxy port busy, falling back to ephemeral port");
            let listener = std::net::TcpListener::bind("127.0.0.1:0")
                .map_err(|err| AppError::new(code::INTERNAL, "proxy bind failed").with_cause(err.to_string()))?;
            listener
                .set_nonblocking(true)
                .map_err(|err| AppError::new(code::INTERNAL, "proxy set_nonblocking failed").with_cause(err.to_string()))?;
            Ok(listener)
        }
    }
}

async fn handle_health(State(state): State<Arc<ProxyState>>) -> Response {
    let body = format!(r#"{{"ok":true,"port":{}}}"#, state.port());
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn handle_options() -> Response {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header("access-control-allow-origin", "*")
        .header("access-control-allow-methods", "GET,HEAD,OPTIONS")
        .header("access-control-allow-headers", "*")
        .header("access-control-expose-headers", "*")
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::NO_CONTENT.into_response())
}

async fn handle_proxy(
    State(state): State<Arc<ProxyState>>,
    RawQuery(raw): RawQuery,
    headers: HeaderMap,
) -> Response {
    // TVBox sources hand back `proxy?do=py&type=m3u8&url=…` (sometimes with a
    // duplicated `url`), so parse the raw query and keep the last value.
    let pairs: Vec<(String, String)> = raw
        .as_deref()
        .map(|text| {
            url::form_urlencoded::parse(text.as_bytes())
                .into_owned()
                .collect()
        })
        .unwrap_or_default();
    let get = |key: &str| {
        pairs
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    };

    if let Some(kind) = get("do").filter(|value| !value.is_empty()) {
        return handle_spider_proxy(&kind, &pairs).await;
    }

    let query = ProxyQuery {
        url: get("url").unwrap_or_default(),
        ua: get("ua"),
        referer: get("referer"),
        cookie: get("cookie"),
        h: get("h"),
    };

    let target = match Url::parse(&query.url) {
        Ok(url) => url,
        Err(err) => return deny(StatusCode::BAD_REQUEST, &format!("invalid url: {err}")),
    };

    if let Err(reason) = check_target(&target, state.allow_local).await {
        return deny(StatusCode::FORBIDDEN, &reason);
    }

    let fwd = Fwd {
        ua: query.ua.clone(),
        referer: query.referer.clone(),
        cookie: query.cookie.clone(),
        extra: query.h.clone(),
    };

    let mut request = state.client.get(target.clone());
    // Config-level host headers (TVBox `headers[]`) come first so an explicit
    // ua/referer/cookie from the spider still wins. Building one list keeps
    // `RequestBuilder::header` from appending a duplicate User-Agent.
    // Config-level host rules come first, explicit ua/referer/cookie win, and
    // defaults fill only the gaps. `netrules` owns all three steps so the
    // resolver (play.rs) and this proxy cannot disagree about the UA; keeping
    // one list also stops `RequestBuilder::header` appending a second UA.
    let mut explicit: Vec<(String, String)> = Vec::with_capacity(3);
    if let Some(ua) = fwd.ua.as_deref() {
        explicit.push(("User-Agent".into(), ua.into()));
    }
    if let Some(referer) = fwd.referer.as_deref() {
        explicit.push(("Referer".into(), referer.into()));
    }
    if let Some(cookie) = fwd.cookie.as_deref() {
        explicit.push(("Cookie".into(), cookie.into()));
    }
    let forwarded = crate::netrules::with_defaults(
        &target,
        crate::netrules::merged_for(target.as_str(), &explicit),
    );
    for (name, value) in forwarded {
        request = request.header(name, value);
    }
    for (name, value) in extra_headers(query.h.as_deref()) {
        request = request.header(name, value);
    }
    for name in PASSTHROUGH {
        if let Some(value) = headers.get(name) {
            if let Ok(text) = value.to_str() {
                request = request.header(name, text);
            }
        }
    }

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            let status = if err.is_timeout() {
                StatusCode::GATEWAY_TIMEOUT
            } else {
                StatusCode::BAD_GATEWAY
            };
            return deny(status, &format!("upstream failed: {err}"));
        }
    };

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let is_playlist = target.path().to_ascii_lowercase().ends_with(".m3u8")
        || content_type.to_ascii_lowercase().contains("mpegurl");

    if is_playlist && status.is_success() {
        // Relative segment URIs must be rewritten, otherwise hls.js resolves
        // them against 127.0.0.1:9978 and every segment 404s.
        let body = match upstream.bytes().await {
            Ok(bytes) => bytes,
            Err(err) => return deny(StatusCode::BAD_GATEWAY, &format!("playlist read failed: {err}")),
        };
        let text = String::from_utf8_lossy(&body);
        let rewritten = rewrite_playlist(&text, &target, state.port(), &fwd);
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/vnd.apple.mpegurl")
            .header("cache-control", "no-store")
            .header("access-control-allow-origin", "*")
            .header("access-control-expose-headers", "*")
            .header("x-tvbox-proxy", "playlist")
            .body(Body::from(rewritten))
            .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "response build failed"));
    }

    let mut builder = Response::builder().status(status);
    for name in DOWNSTREAM {
        if let Some(value) = upstream.headers().get(name) {
            if let Ok(text) = value.to_str() {
                builder = builder.header(name, text);
            }
        }
    }

    let stream = upstream.bytes_stream();
    builder
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", "*")
        .header("x-tvbox-proxy", "1")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "response build failed"))
}

/// Decode a percent-encoded fragment (TVBox embeds URL-encoded header values,
/// e.g. `User-Agent=Mozilla/5.0%20(...)`). Hand-rolled to avoid pulling in a
/// new dependency: `%XX` -> byte, `+` stays literal (header values, not form
/// data), then UTF-8 decode. Invalid UTF-8 falls back to the raw input rather
/// than rejecting the header.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| -> Option<u8> {
                match b {
                    b'0'..=b'9' => Some(b - b'0'),
                    b'a'..=b'f' => Some(b - b'a' + 10),
                    b'A'..=b'F' => Some(b - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

/// Parse a TVBox `vod_pic` that may carry inline request headers.
///
/// Community sources (e.g. Douban) append `@Referer=...`, `@User-Agent=...`,
/// `@Cookie=...` or a URL-encoded `@Headers={json}` to the real image URL so
/// the host can bypass hotlink protection. This mirrors the native host's
/// `ImgUtil.getUrl` (FongMi) / `VodImages.parseVodPicUrl` (AVBox): the image
/// layer strips the suffix and injects the headers into the request. WebView2
/// `<img>` cannot set custom headers, so our local `/image` proxy plays the
/// role of that native interceptor.
///
/// Returns `None` for `data:` URIs and URLs without an inline header, meaning
/// "no parsing needed" — the caller falls back to a plain upstream fetch.
/// Header names go through `fix_header` aliases (`ua`/`referer`/`cookie`).
pub(crate) fn parse_vod_pic_url(raw: &str) -> Option<(String, Vec<(String, String)>)> {
    if raw.starts_with("data:") || !raw.contains('@') {
        return None;
    }
    // Values are taken up to the next '@' (the separator has no escaping in
    // the TVBox convention). '=' is safe inside a value.
    let grab = |key: &str| -> Option<String> {
        let needle = format!("@{key}=");
        raw.split(&needle)
            .nth(1)
            .map(|rest| rest.split('@').next().unwrap_or("").to_string())
    };
    let url = raw.split('@').next().unwrap_or("").to_string();
    if url.is_empty() {
        return None;
    }
    let fix_header = |key: &str| -> String {
        match key.to_ascii_lowercase().as_str() {
            "user-agent" | "ua" => "User-Agent".into(),
            "referer" | "referrer" => "Referer".into(),
            "cookie" => "Cookie".into(),
            _ => key.to_string(),
        }
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    // @Headers is a percent-encoded JSON object; expand it first so explicit
    // @Referer/@User-Agent below can still override individual keys.
    if let Some(json) = grab("Headers") {
        if let Ok(map) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&percent_decode(&json)) {
            for (key, value) in map {
                if let Some(text) = value.as_str().filter(|v| !v.is_empty()) {
                    headers.push((fix_header(&key), text.to_string()));
                }
            }
        }
    }
    // Canonical header -> accepted inline aliases. Native `fixHeader` maps
    // `ua` -> User-Agent etc.; sources in the wild use both spellings.
    for (canonical, aliases) in [
        ("Cookie", &["Cookie", "cookie"][..]),
        ("User-Agent", &["User-Agent", "ua", "user-agent"][..]),
        ("Referer", &["Referer", "referer", "referrer"][..]),
    ] {
        let value = aliases
            .iter()
            .find_map(|key| grab(key))
            .map(|v| percent_decode(&v))
            .filter(|v| !v.is_empty());
        if let Some(value) = value {
            // Replace an existing (case-normalized) key from @Headers.
            let normalized = fix_header(canonical);
            headers.retain(|(name, _)| name != &normalized);
            headers.push((normalized, value));
        }
    }
    Some((url, headers))
}

/// Image proxy: the WebView2 equivalent of the native image interceptor.
///
/// The browser sends the original `vod_pic` (with TVBox `@header` suffix) as
/// `?url=`; we parse the inline headers, validate the pure URL against the
/// same whitelist as `/proxy`, inject headers (inline > config `headers[]` >
/// defaults), then stream the image back with a long cache lifetime.
async fn handle_image(
    State(state): State<Arc<ProxyState>>,
    RawQuery(raw): RawQuery,
) -> Response {
    let pairs: Vec<(String, String)> = raw
        .as_deref()
        .map(|text| url::form_urlencoded::parse(text.as_bytes()).into_owned().collect())
        .unwrap_or_default();
    let pic = pairs.iter().rev().find(|(name, _)| name == "url").map(|(_, v)| v.clone()).unwrap_or_default();

    let (pure, inline) = match parse_vod_pic_url(&pic) {
        Some((url, headers)) => (url, headers),
        None => (pic.clone(), Vec::new()),
    };
    let target = match Url::parse(&pure) {
        Ok(url) => url,
        Err(err) => return deny(StatusCode::BAD_REQUEST, &format!("invalid url: {err}")),
    };
    if let Err(reason) = check_target(&target, state.allow_local).await {
        return deny(StatusCode::FORBIDDEN, &reason);
    }

    // Inline headers win over the config-level host table; defaults fill gaps.
    let forwarded = crate::netrules::with_defaults(
        &target,
        crate::netrules::merged_for(target.as_str(), &inline),
    );
    let mut request = state.client.get(target.clone());
    for (name, value) in forwarded {
        request = request.header(name, value);
    }

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(err) => {
            let status = if err.is_timeout() { StatusCode::GATEWAY_TIMEOUT } else { StatusCode::BAD_GATEWAY };
            return deny(status, &format!("upstream failed: {err}"));
        }
    };
    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    // Only serve real images; refuse to turn the proxy into a generic file
    // fetcher (and stop a mislabeled playlist/script from reaching <img>).
    if !status.is_success() || !content_type.to_ascii_lowercase().starts_with("image/") {
        return deny(StatusCode::BAD_GATEWAY, &format!("not an image (status {status}, type {content_type})"));
    }

    let stream = upstream.bytes_stream();
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type)
        .header("cache-control", "public, max-age=604800")
        .header("access-control-allow-origin", "*")
        .header("access-control-expose-headers", "*")
        .header("x-tvbox-proxy", "image")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "response build failed"))
}

/// TVBox local proxy for spider-owned resources (`/proxy?do=py|jar|js`).
///
/// Sources that implement `Spider.proxy(Map)` return URLs pointing at this
/// route; the query map is handed to the spider and its
/// `[contentType, headers, bytes]` answer becomes the HTTP response.
async fn handle_spider_proxy(kind: &str, pairs: &[(String, String)]) -> Response {
    let Some(site) = crate::spider::last_play_site() else {
        return deny(
            StatusCode::SERVICE_UNAVAILABLE,
            "no active play source; open a title before using the spider proxy",
        );
    };

    let mut params: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (name, value) in pairs {
        params.insert(name.clone(), value.clone());
    }
    let timeout = std::time::Duration::from_millis(
        params
            .get("timeoutMs")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(20_000)
            .clamp(3_000, 60_000),
    );

    match crate::spider::proxy_call(&site, params, timeout).await {
        Ok(payload) => {
            let mut builder = Response::builder().status(StatusCode::OK);
            for (name, value) in payload.headers.iter() {
                // Framing headers from the spider would corrupt our response.
                if matches!(
                    name.to_ascii_lowercase().as_str(),
                    "content-length"
                        | "transfer-encoding"
                        | "connection"
                        | "content-encoding"
                        | "content-type"
                ) {
                    continue;
                }
                builder = builder.header(name, value);
            }
            // Spiders frequently return application/octet-stream even for
            // playlists; hls.js sniffs the body, but a correct type keeps
            // browsers/proxies from treating it as a download.
            let mut content_type = payload.content_type.clone();
            if content_type.is_empty() || content_type == "application/octet-stream" {
                if payload.body.starts_with(b"#EXTM3U") {
                    content_type = "application/vnd.apple.mpegurl".to_string();
                }
            }
            builder
                .header("content-type", content_type)
                .header("cache-control", "no-store")
                .header("access-control-allow-origin", "*")
                .header("access-control-expose-headers", "*")
                .header("x-tvbox-proxy", format!("spider-{kind}"))
                .body(Body::from(payload.body))
                .unwrap_or_else(|_| deny(StatusCode::BAD_GATEWAY, "proxy response build failed"))
        }
        Err(err) => deny(
            StatusCode::BAD_GATEWAY,
            &format!("spider proxy failed: {} {}", err.code, err.message),
        ),
    }
}

/// Headers/params that must travel with every rewritten playlist URI.
#[derive(Clone, Default)]
struct Fwd {
    ua: Option<String>,
    referer: Option<String>,
    cookie: Option<String>,
    extra: Option<String>,
}

impl Fwd {
    fn suffix(&self) -> String {
        let mut out = String::new();
        for (key, value) in [
            ("ua", self.ua.as_deref()),
            ("referer", self.referer.as_deref()),
            ("cookie", self.cookie.as_deref()),
            ("h", self.extra.as_deref()),
        ] {
            if let Some(value) = value.filter(|text| !text.is_empty()) {
                out.push_str(&format!("&{key}={}", urlencode(value)));
            }
        }
        out
    }
}

fn wrap_url(port: u16, target: &str, fwd: &Fwd) -> String {
    format!("http://127.0.0.1:{port}/proxy?url={}{}", urlencode(target), fwd.suffix())
}

/// Resolve a playlist URI against the manifest URL. Absolute http(s) URLs are
/// already final and must pass through unchanged (they often carry signed query
/// parameters); everything else is joined with the manifest's base.
fn absolutize(base: &Url, uri: &str) -> String {
    let trimmed = uri.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    base.join(trimmed)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| trimmed.to_string())
}

/// Wrap every media line of an HLS playlist into the local proxy. Without this
/// the webview would request segments (and `#EXT-X-KEY` URIs) directly from the
/// CDN, losing the anti-leech headers and hitting CORS.
fn rewrite_playlist(text: &str, base: &Url, port: u16, fwd: &Fwd) -> String {
    let mut out = String::with_capacity(text.len() + 256);
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }
        if trimmed.starts_with('#') {
            if trimmed.contains("URI=\"") {
                out.push_str(&rewrite_tag_uris(trimmed, base, port, fwd));
            } else {
                out.push_str(trimmed);
            }
            out.push('\n');
            continue;
        }
        out.push_str(&wrap_url(port, &absolutize(base, trimmed), fwd));
        out.push('\n');
    }
    out
}

/// Rewrite every `URI="..."` in an HLS tag (e.g. `#EXT-X-KEY`) to point at the
/// local proxy. One tag can carry more than one URI, so the scan resumes at the
/// closing quote instead of returning after the first hit.
fn rewrite_tag_uris(line: &str, base: &Url, port: u16, fwd: &Fwd) -> String {
    let mut out = String::with_capacity(line.len() + 64);
    let mut rest = line;
    while let Some(position) = rest.find("URI=\"") {
        // +5 skips the literal `URI="`; `tail` now starts at the value.
        let (head, tail) = rest.split_at(position + 5);
        out.push_str(head);
        if let Some(end) = tail.find('"') {
            let uri = &tail[..end];
            out.push_str(&wrap_url(port, &absolutize(base, uri), fwd));
            rest = &tail[end..];
        } else {
            // Unterminated quote: keep the original tail verbatim rather than
            // emitting a broken playlist.
            rest = tail;
            break;
        }
    }
    out.push_str(rest);
    out
}

fn extra_headers(payload: Option<&str>) -> Vec<(HeaderName, String)> {
    let Some(payload) = payload else { return Vec::new() };
    let Ok(decoded) = base64_decode(payload) else { return Vec::new() };
    let Ok(map) = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&decoded) else {
        return Vec::new();
    };
    map.into_iter()
        .filter_map(|(key, value)| {
            let text = value.as_str()?.to_string();
            let name = HeaderName::from_bytes(key.as_bytes()).ok()?;
            Some((name, text))
        })
        .collect()
}

pub(crate) fn base64_decode(input: &str) -> Result<Vec<u8>, ()> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u8;
    let mut seen_pad = false;
    for byte in input.bytes() {
        if byte == b'=' {
            seen_pad = true;
            continue;
        }
        if byte.is_ascii_whitespace() {
            continue;
        }
        if seen_pad {
            return Err(());
        }
        let index = TABLE.iter().position(|c| *c == byte).ok_or(())? as u32;
        buffer = (buffer << 6) | index;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

async fn check_target(url: &Url, allow_local: bool) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("scheme {} not allowed", url.scheme()));
    }
    let host = url.host_str().ok_or_else(|| "url has no host".to_string())?;
    if allow_local {
        return Ok(());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return if is_blocked(ip) {
            Err(format!("target {ip} is not allowed"))
        } else {
            Ok(())
        };
    }
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|err| format!("resolve {host} failed: {err}"))?;
    for addr in addrs {
        if is_blocked(addr.ip()) {
            return Err(format!("target {host} resolves to blocked address {}", addr.ip()));
        }
    }
    Ok(())
}

fn is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
        }
    }
}

fn deny(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("access-control-allow-origin", "*")
        .body(Body::from(message.to_string()))
        .unwrap_or_else(|_| status.into_response())
}

/// Build the player-facing proxy URL for one playable item (spec 7.5).
pub fn build_proxy_url(
    port: u16,
    url: &str,
    ua: Option<&str>,
    referer: Option<&str>,
    cookie: Option<&str>,
) -> String {
    let mut out = format!("http://127.0.0.1:{port}/proxy?url={}", urlencode(url));
    if let Some(ua) = ua.filter(|value| !value.is_empty()) {
        out.push_str(&format!("&ua={}", urlencode(ua)));
    }
    if let Some(referer) = referer.filter(|value| !value.is_empty()) {
        out.push_str(&format!("&referer={}", urlencode(referer)));
    }
    if let Some(cookie) = cookie.filter(|value| !value.is_empty()) {
        out.push_str(&format!("&cookie={}", urlencode(cookie)));
    }
    out
}

fn urlencode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[tauri::command]
pub fn proxy_status(state: tauri::State<'_, Arc<ProxyState>>) -> ProxyStatus {
    let port = state.port();
    ProxyStatus {
        port,
        base_url: format!("http://127.0.0.1:{port}"),
        allow_local: state.allow_local(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_keeps_unreserved_only() {
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(urlencode("http://a b/?x=1&y=2"), "http%3A%2F%2Fa%20b%2F%3Fx%3D1%26y%3D2");
    }

    #[test]
    fn parse_vod_pic_plain_and_data_are_not_parsed() {
        assert!(parse_vod_pic_url("https://img/x.jpg").is_none());
        assert!(parse_vod_pic_url("").is_none());
        assert!(parse_vod_pic_url("data:image/png;base64,AAAA").is_none());
        assert!(parse_vod_pic_url("@Referer=http://x").is_none()); // empty url
    }

    #[test]
    fn parse_vod_pic_douban_inline_headers() {
        // The exact shape produced by douban.py PIC_SUFFIX, incl. %20 in UA.
        let raw = "https://img3.doubanio.com/p.jpg@Referer=https://api.douban.com/@User-Agent=Mozilla/5.0%20(Windows%20NT%2010.0)";
        let (url, headers) = parse_vod_pic_url(raw).expect("inline header");
        assert_eq!(url, "https://img3.doubanio.com/p.jpg");
        assert_eq!(headers.len(), 2);
        assert!(headers.iter().any(|(k, v)| k == "Referer" && v == "https://api.douban.com/"));
        assert!(headers.iter().any(|(k, v)| k == "User-Agent" && v == "Mozilla/5.0 (Windows NT 10.0)"));
    }

    #[test]
    fn parse_vod_pic_cookie_and_header_aliases() {
        let raw = "https://cdn/x.png@ua=okhttp%2F3.15@referer=https%3A%2F%2Fh%2F@Cookie=a%3D1%3Bb%3D2";
        let (url, headers) = parse_vod_pic_url(raw).expect("aliases");
        assert_eq!(url, "https://cdn/x.png");
        assert!(headers.iter().any(|(k, v)| k == "User-Agent" && v == "okhttp/3.15"));
        assert!(headers.iter().any(|(k, v)| k == "Referer" && v == "https://h/"));
        assert!(headers.iter().any(|(k, v)| k == "Cookie" && v == "a=1;b=2"));
    }

    #[test]
    fn parse_vod_pic_headers_json_and_explicit_override() {
        // @Headers is URL-encoded JSON; an explicit @Referer must override it.
        let raw = "https://cdn/x.webp@Headers=%7B%22Referer%22%3A%22https%3A%2F%2Fjson%2F%22%2C%22X-Token%22%3A%22abc%22%7D@Referer=https%3A%2F%2Fexplicit%2F";
        let (url, headers) = parse_vod_pic_url(raw).expect("headers json");
        assert_eq!(url, "https://cdn/x.webp");
        let get = |k: &str| headers.iter().find(|(name, _)| name == k).map(|(_, v)| v.as_str());
        assert_eq!(get("Referer"), Some("https://explicit/")); // explicit wins, single entry
        assert_eq!(get("X-Token"), Some("abc"));
        assert_eq!(headers.iter().filter(|(name, _)| name == "Referer").count(), 1);
    }

    #[test]
    fn percent_decode_handles_invalid_utf8_gracefully() {
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("%FF%FE"), "%FF%FE"); // invalid UTF-8 -> raw
    }

    #[test]
    fn proxy_url_includes_optional_headers() {
        let url = build_proxy_url(9978, "http://cdn/x.m3u8", Some("okhttp/3.15"), Some("http://ref/"), None);
        assert!(url.starts_with("http://127.0.0.1:9978/proxy?url=http%3A%2F%2Fcdn%2Fx.m3u8"));
        assert!(url.contains("ua=okhttp%2F3.15"));
        assert!(url.contains("referer=http%3A%2F%2Fref%2F"));
        assert!(!url.contains("cookie="));
    }

    #[test]
    fn blocked_ranges_cover_private_and_loopback() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.1.1", "::1", "fd00::1"] {
            assert!(is_blocked(ip.parse().unwrap()), "{ip} should be blocked");
        }
        for ip in ["8.8.8.8", "1.1.1.1"] {
            assert!(!is_blocked(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn playlist_rewrites_relative_segments_and_key_uris() {
        let base = Url::parse("https://cdn.example/x/playlist.m3u8").unwrap();
        let fwd = Fwd {
            ua: Some("okhttp/3.15".into()),
            referer: Some("https://ref.example/".into()),
            cookie: None,
            extra: None,
        };
        let source = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:2,\nseg0.ts\n#EXTINF:2,\nhttps://other.example/seg1.ts\n";
        let out = rewrite_playlist(source, &base, 9978, &fwd);
        assert!(out.contains("http://127.0.0.1:9978/proxy?url=https%3A%2F%2Fcdn.example%2Fx%2Fseg0.ts"), "{out}");
        assert!(out.contains("URI=\"http://127.0.0.1:9978/proxy?url=https%3A%2F%2Fcdn.example%2Fx%2Fkey.bin"), "{out}");
        assert!(out.contains("url=https%3A%2F%2Fother.example%2Fseg1.ts"), "{out}");
        assert!(out.contains("ua=okhttp%2F3.15"), "{out}");
        assert!(out.contains("#EXTM3U"), "{out}");
    }

    #[test]
    fn base64_roundtrip_for_extra_headers() {
        let payload = "eyJYLVN0dWIiOiIxIn0=";
        let decoded = base64_decode(payload).expect("decode");
        assert_eq!(String::from_utf8(decoded).unwrap(), r#"{"X-Stub":"1"}"#);
    }
}
