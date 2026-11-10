//! Local HTTP reverse proxy (spec 7.5 / T-08).
//!
//! Binds `127.0.0.1:9978`; when the port is taken it falls back to an
//! ephemeral port and publishes the real one through `proxy_status`.
//! Only loopback is bound. Targets are validated against a whitelist that
//! rejects loopback / private / link-local / multicast addresses, unless
//! `TVBOX_PROXY_ALLOW_LOCAL=1` is set (development and stub tests only).

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
/// Same fallback the TVBox clients send. Some CDNs answer garbage (or a 403
/// body that hls.js reports as `fragParsingError`) when no UA is present.
const DEFAULT_UA: &str = "okhttp/3.15";
const ALLOW_LOCAL_ENV: &str = "TVBOX_PROXY_ALLOW_LOCAL";

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
    let allow_local = std::env::var(ALLOW_LOCAL_ENV)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

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
    let mut forwarded: Vec<(String, String)> = crate::netrules::headers_for(target.as_str());
    fn put(list: &mut Vec<(String, String)>, name: &str, value: &str) {
        match list
            .iter_mut()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
        {
            Some(slot) => slot.1 = value.to_string(),
            None => list.push((name.to_string(), value.to_string())),
        }
    }
    if let Some(ua) = fwd.ua.as_deref() {
        put(&mut forwarded, "User-Agent", ua);
    }
    if let Some(referer) = fwd.referer.as_deref() {
        put(&mut forwarded, "Referer", referer);
    }
    if let Some(cookie) = fwd.cookie.as_deref() {
        put(&mut forwarded, "Cookie", cookie);
    }
    // Defaults come last so the config table and the spider both win, but the
    // upstream still always sees a UA and an origin Referer — dropping them
    // makes some CDNs return an error page that surfaces as fragParsingError.
    if !forwarded
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("user-agent"))
    {
        forwarded.push(("User-Agent".to_string(), DEFAULT_UA.to_string()));
    }
    if !forwarded
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("referer"))
    {
        if let Some(host) = target.host_str() {
            forwarded.push(("Referer".to_string(), format!("{}://{host}/", target.scheme())));
        }
    }
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

fn absolutize(base: &Url, uri: &str) -> String {
    let trimmed = uri.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    base.join(trimmed)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| trimmed.to_string())
}

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

fn rewrite_tag_uris(line: &str, base: &Url, port: u16, fwd: &Fwd) -> String {
    let mut out = String::with_capacity(line.len() + 64);
    let mut rest = line;
    while let Some(position) = rest.find("URI=\"") {
        let (head, tail) = rest.split_at(position + 5);
        out.push_str(head);
        if let Some(end) = tail.find('"') {
            let uri = &tail[..end];
            out.push_str(&wrap_url(port, &absolutize(base, uri), fwd));
            rest = &tail[end..];
        } else {
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
