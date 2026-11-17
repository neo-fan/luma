//! Local HTTP reverse proxy (spec 7.5 / T-08).
//!
//! Binds `127.0.0.1:9978`; when the port is taken it falls back to an
//! ephemeral port and publishes the real one through `proxy_status`.
//! Only loopback is bound. Targets are validated against a whitelist that
//! rejects loopback / private / link-local / multicast addresses, unless
//! `LUMA_PROXY_ALLOW_LOCAL=1` is set (development and stub tests only).

use crate::error::{code, AppError};
use axum::body::{Body, Bytes};
use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{stream, StreamExt};
use reqwest_middleware::ClientWithMiddleware;
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
    /// 分片/清单客户端：原样搬运（禁自动解压），带每跳重定向守卫与
    /// 已审查 IP 钉住的 DNS resolver（见 guard）。
    client: reqwest::Client,
    /// 封面专用：带 HTTP 缓存中间件（cacache 磁盘后端），守卫同上。
    image_client: Arc<ClientWithMiddleware>,
}

/// 「原样搬运」的流式客户端构造。绝不能打开 gzip/brotli 自动解码：
/// reqwest 在客户端解码、但 `content-length` / `range` 仍是我们透传上游
/// 头，长度对不上会让播放器截断分片。压缩只开在 `infra/http.rs` 的取数
/// 客户端上（配置 / CMS / 豆瓣）。
fn streaming_builder(allow_local: bool) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .pool_idle_timeout(Duration::from_secs(60))
        .redirect(guard::redirect_guard(allow_local))
        .dns_resolver(guard::pinned_resolver())
        .no_gzip()
        .no_brotli()
        .no_zstd()
}

fn wrap_image(base: reqwest::Client, dir: &std::path::Path) -> ClientWithMiddleware {
    reqwest_middleware::ClientBuilder::new(base)
        .with(http_cache_reqwest::Cache(http_cache_reqwest::HttpCache {
            mode: http_cache_reqwest::CacheMode::Default,
            manager: http_cache_reqwest::CACacheManager::new(dir.to_path_buf(), false),
            options: http_cache_reqwest::HttpCacheOptions::default(),
        }))
        .build()
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
    /// 测试入口：独立构建一个带守卫与钉住 resolver 的封面客户端，
    /// 让用例能指向临时缓存目录而不共享进程级单例。
    #[cfg(test)]
    fn image_client_in(dir: &std::path::Path) -> ClientWithMiddleware {
        let base = reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(60))
            .redirect(guard::redirect_guard(false))
            .dns_resolver(guard::pinned_resolver())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        wrap_image(base, dir)
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
        .map_err(|err| {
            AppError::new(code::INTERNAL, "proxy local_addr failed").with_cause(err.to_string())
        })?
        .port();

    let image_dir = crate::store::data_dir().join("cache").join("http-images");
    let image_base = reqwest::Client::builder()
        .pool_idle_timeout(Duration::from_secs(60))
        .redirect(guard::redirect_guard(allow_local))
        .dns_resolver(guard::pinned_resolver())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let state = Arc::new(ProxyState {
        port: AtomicU16::new(port),
        allow_local,
        client: streaming_builder(allow_local)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new()),
        image_client: Arc::new(wrap_image(image_base, &image_dir)),
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
            // 播放器 HUD 的吞吐读数；只读、无副作用，和 /health 一样不设鉴权。
            .route("/meter", get(handle_meter))
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
            listener.set_nonblocking(true).map_err(|err| {
                AppError::new(code::INTERNAL, "proxy set_nonblocking failed")
                    .with_cause(err.to_string())
            })?;
            Ok(listener)
        }
        Err(err) => {
            tracing::warn!(port = DEFAULT_PORT, error = %err, "proxy port busy, falling back to ephemeral port");
            let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|err| {
                AppError::new(code::INTERNAL, "proxy bind failed").with_cause(err.to_string())
            })?;
            listener.set_nonblocking(true).map_err(|err| {
                AppError::new(code::INTERNAL, "proxy set_nonblocking failed")
                    .with_cause(err.to_string())
            })?;
            Ok(listener)
        }
    }
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
    // 唯一实现在 `infra::pct`（与 CMS 查询串、豆瓣内联头共用同一套转义口径）。
    crate::pct::percent_encode(input)
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

// ---- 子模块 ---------------------------------------------------------------
// 命令层留在本文件（Tauri 的 `generate_handler!` 需要宏在同一模块作用域，
// 跨模块 re-export 会把 `__cmd__*` 宏漏掉）；子模块只放实现与 DTO。
mod guard;
mod handlers;
mod playlist;
mod speed;

use guard::*;
pub(crate) use handlers::base64_decode;
use handlers::*;
use playlist::*;

#[cfg(test)]
mod tests;
