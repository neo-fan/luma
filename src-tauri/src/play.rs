//! Playback resolution and external player fallback (spec 10 / T-09).
//!
//! The webview never talks to a third-party host directly: every playable
//! URL is wrapped into the local proxy so anti-leech headers survive.

use crate::error::{code, AppError};
use crate::proxy::{self, ProxyState};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use url::Url;

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
pub fn resolve_play(
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

    let Some(host) = parsed.host_str() else {
        return Err(AppError::new(code::INVALID_ARGUMENT, "play url has no host"));
    };
    let referer = request
        .referer
        .clone()
        .or_else(|| Some(format!("{}://{host}/", parsed.scheme())));
    let ua = request.ua.clone().or_else(|| Some("okhttp/3.15".to_string()));

    let proxy_url = proxy::build_proxy_url(
        state.port(),
        &request.url,
        ua.as_deref(),
        referer.as_deref(),
        request.cookie.as_deref(),
    );

    let kind = classify(&parsed).to_string();
    let mut headers = Vec::new();
    if let Some(ua) = ua.clone() {
        headers.push(("User-Agent".to_string(), ua));
    }
    if let Some(referer) = referer.clone() {
        headers.push(("Referer".to_string(), referer));
    }
    if let Some(cookie) = request.cookie.clone() {
        headers.push(("Cookie".to_string(), cookie));
    }

    tracing::debug!(site = %request.site_key, kind, "resolved play url");
    Ok(PlayResolved {
        url: request.url,
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
