//! CMS runtime: build the request, fetch the raw body, let Python parse it.
//!
//! Supported: type 0 (XML), type 1 (JSON), type 4 (remote API passthrough).
//! Field mapping stays in `sidecars/py/cms.py`; Rust never duplicates it.

use crate::bridge;
use crate::error::{code, AppError};
use crate::http::{self, FetchRequest};
use crate::spider::SpiderMethod;
use serde_json::{json, Value};
use std::collections::HashMap;

pub async fn invoke(
    site: &Value,
    method: SpiderMethod,
    args: &[Value],
) -> Result<Value, AppError> {
    // CMS has no `playerContent`: play URLs ship inside `detailContent`'s
    // `vod_play_url`. Return an empty object rather than INVALID_ARGUMENT —
    // the caller (usePlayResolution) then keeps the detail URL, and the app
    // log stops reporting a capability gap as a failed IPC call.
    if matches!(&method, SpiderMethod::PlayerContent) {
        return Ok(json!({}));
    }
    let api = site.get("api").and_then(Value::as_str).unwrap_or("");
    if api.is_empty() {
        return Err(AppError::new(code::INVALID_ARGUMENT, "cms site has no api"));
    }

    let (url, sidecar_method, extra) = build(api, method, args)?;
    tracing::debug!(method = method.as_str(), %url, "cms request");

    let headers = site.get("headers").and_then(Value::as_object).map(|map| {
        map.iter()
            .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
            .collect::<HashMap<String, String>>()
    });
    let timeout_ms = site.get("timeoutMs").and_then(Value::as_u64);

    let response = http::fetch(FetchRequest {
        url,
        method: None,
        headers,
        body: None,
        timeout_ms,
    })
    .await?;

    let mut payload = json!({ "site": site, "raw": response.body });
    if let Value::Object(extra_fields) = extra {
        for (key, value) in extra_fields {
            payload[key] = value;
        }
    }
    bridge::call(sidecar_method, payload).await
}

fn build(
    api: &str,
    method: SpiderMethod,
    args: &[Value],
) -> Result<(String, &'static str, Value), AppError> {
    let separator = separator_for(api);
    // CMS payloads carry `vod_id` as a JSON number; stringifying keeps
    // `ac=detail&ids=` from being sent empty (which makes the site fall back to
    // an unrelated default item).
    let arg_str = |index: usize| match args.get(index) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    };
    let arg_page = |index: usize| args.get(index).and_then(Value::as_u64).unwrap_or(1);

    match method {
        SpiderMethod::HomeContent => Ok((
            format!("{api}{separator}ac=list"),
            "site.parseHome",
            json!({}),
        )),
        // CMS 协议没有独立的 homeVideoContent：它的 ac=list 一开始就同时返回
        // 分类与 list（见 cms.py 的 _page_from_json）。alias 回同一请求，既复用
        // 解析、又不发明不存在的 ac 参数；也避免 siteKey="all" 聚合 / 前端兜底
        // 无差别调用时把 CMS 站记成 failed。
        SpiderMethod::HomeVideoContent => Ok((
            format!("{api}{separator}ac=list"),
            "site.parseHome",
            json!({}),
        )),
        SpiderMethod::CategoryContent => {
            let tid = arg_str(0);
            let page = arg_page(1);
            Ok((
                format!("{api}{separator}ac=videolist&t={}&pg={page}", encode(&tid)),
                "site.parseCategory",
                json!({ "tid": tid, "pg": page }),
            ))
        }
        SpiderMethod::SearchContent => {
            let keyword = arg_str(0);
            // Unified TVBox signature is (key, quick, pg); older callers still
            // pass the two-argument (key, pg) form.
            let (quick, page) = if args.len() >= 3 {
                (
                    args.get(1).and_then(Value::as_bool).unwrap_or(false),
                    arg_page(2),
                )
            } else {
                (false, arg_page(1))
            };
            Ok((
                format!(
                    "{api}{separator}wd={}&ac=videolist&pg={page}",
                    encode(&keyword)
                ),
                "site.parseSearch",
                json!({ "wd": keyword, "quick": quick, "pg": page }),
            ))
        }
        SpiderMethod::DetailContent => {
            let id = arg_str(0);
            Ok((
                format!("{api}{separator}ac=detail&ids={}", encode(&id)),
                "site.parseDetail",
                json!({}),
            ))
        }
        other => Err(AppError::new(
            code::INVALID_ARGUMENT,
            format!("method {other:?} is not handled by the cms runtime"),
        )),
    }
}

/// Some CMS deployments route on the trailing slash: `.../vod?ac=detail` silently
/// falls back to the default list, while `.../vod/?ac=detail` honours it. So a
/// path whose last segment has no extension gets `/` before the query string.
fn separator_for(api: &str) -> &'static str {
    if api.contains('?') {
        return "&";
    }
    let path = api.split("://").nth(1).unwrap_or(api);
    let last = path.rsplit('/').next().unwrap_or("");
    if last.is_empty() || last.contains('.') {
        "?"
    } else {
        "/?"
    }
}

fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separator_keeps_trailing_slash_for_extensionless_paths() {
        assert_eq!(separator_for("https://x.com/api.php/provide/vod"), "/?");
        assert_eq!(separator_for("https://x.com/api.php"), "?");
        assert_eq!(separator_for("https://x.com/api.php/provide/vod?token=1"), "&");
        assert_eq!(separator_for("http://127.0.0.1:8787/cms/vod"), "/?");
    }

    #[test]
    fn search_accepts_both_tvbox_and_legacy_arg_shapes() {
        let (url, method, extra) = build(
            "https://x.com/api.php/provide/vod",
            SpiderMethod::SearchContent,
            &[json!("庆余年"), json!(false), json!(3)],
        )
        .expect("three-arg search must build");
        assert_eq!(method, "site.parseSearch");
        assert!(url.contains("pg=3"), "{url}");
        assert_eq!(extra["quick"], false);
        assert_eq!(extra["pg"], 3);

        let (legacy, _, extra) = build(
            "https://x.com/api.php",
            SpiderMethod::SearchContent,
            &[json!("庆余年"), json!(2)],
        )
        .expect("two-arg search must still build");
        assert!(legacy.contains("pg=2"), "{legacy}");
        assert_eq!(extra["pg"], 2);
    }

    #[tokio::test]
    async fn player_content_is_an_empty_result_not_an_error() {
        // CMS 的播放地址随 detailContent 下发；这里必须返回空对象，让前端
        // 沿用详情地址，也避免把能力缺口记成一次失败的 IPC。
        let site = json!({"key": "c", "type": 1, "api": "http://127.0.0.1:1/cms"});
        let out = invoke(
            &site,
            SpiderMethod::PlayerContent,
            &[json!("line"), json!("id"), json!([])],
        )
        .await
        .expect("playerContent must not fail for CMS");
        assert_eq!(out, json!({}));
        // No api at all must behave the same (no network attempt).
        let bare = json!({"key": "c", "type": 1});
        let out = invoke(&bare, SpiderMethod::PlayerContent, &[]).await;
        assert_eq!(out.expect("no api is fine here"), json!({}));
    }

    #[test]
    fn home_video_content_aliases_to_list() {
        // CMS 协议没有独立方法：homeVideoContent 必须 alias 回 ac=list，复用
        // site.parseHome 解析，避免 siteKey="all" 无差别调用时把 CMS 站记成 failed。
        let (url, method, extra) = build("http://x/vod", SpiderMethod::HomeVideoContent, &[])
            .expect("homeVideoContent must build for cms");
        assert!(url.contains("ac=list"), "{url}");
        assert_eq!(method, "site.parseHome");
        assert_eq!(extra, json!({}));
    }
}
