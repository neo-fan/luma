//! Live playlist entry (spec 7.2 `live.parseM3u` / 8.x 直播).
//!
//! Rust fetches the m3u/txt list (per-entry UA from the config), the Python
//! adapter does the parsing — the same split used for CMS.

use crate::bridge;
use crate::error::{code, AppError};
use crate::http;
use serde_json::{json, Value};
use std::collections::HashMap;

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
