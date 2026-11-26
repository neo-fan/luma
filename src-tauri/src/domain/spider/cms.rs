//! CMS runtime: build the request, fetch the raw body, parse it in-process.
//!
//! Supported: type 0 (XML), type 1 (JSON), type 4 (remote API passthrough).
//! Field mapping lives in `spider/cms_parse.rs`; the reply is normalized here,
//! never sent through the adapter.

use crate::error::{code, AppError};
use crate::http::{self, FetchRequest};
use crate::spider::cms_parse;
use crate::spider::SpiderMethod;
use serde_json::{json, Value};
use std::collections::HashMap;

pub async fn invoke(site: &Value, method: SpiderMethod, args: &[Value]) -> Result<Value, AppError> {
    let api = site.get("api").and_then(Value::as_str).unwrap_or("");
    // 苹果 CMS 的 provide/vod 没有 `ac=play`：播放地址随 detailContent 的
    // `vod_play_url` 下发。playerContent 因此不发请求，只把前端传来的地址
    // 规范化成契约信封——绝对 URL 原样、相对地址基于站点 api 补全；拿不到
    // HTTP 地址时仍回空对象，让前端沿用详情地址、不把能力差异记成 IPC 失败。
    if matches!(method, SpiderMethod::PlayerContent) {
        return Ok(player_content(api, args));
    }
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

    tracing::debug!(
        parser = sidecar_method,
        bytes = response.body.len(),
        args = %extra,
        "cms parsed in-process"
    );
    match method {
        SpiderMethod::DetailContent => Ok(cms_parse::parse_detail(&response.body)),
        _ => cms_parse::parse_page(&response.body),
    }
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
            "cms.parseHome",
            json!({}),
        )),
        // CMS 协议没有独立的 homeVideoContent：它的 ac=list 一开始就同时返回
        // 分类与 list（见 cms_parse.rs 的 page_from_json）。alias 回同一请求，既复用
        // 解析、又不发明不存在的 ac 参数；也避免 siteKey="all" 聚合 / 前端兜底
        // 无差别调用时把 CMS 站记成 failed。
        SpiderMethod::HomeVideoContent => Ok((
            format!("{api}{separator}ac=list"),
            "cms.parseHome",
            json!({}),
        )),
        SpiderMethod::CategoryContent => {
            let tid = arg_str(0);
            let page = arg_page(1);
            // 第 4 参 extend 是 TVBox 筛选面板选中的条件（前端 api.category
            // 早已传 `[tid, pg, true, extend]`）。此前被丢弃，导致 CMS 站点
            // 在首页返回 filters 后筛选面板可见却点了没反应。约定与苹果 CMS
            // 的 provide/vod 一致：筛选键原样作为 query 参数（year / area /
            // sort_direct / isend / h / pagesize …），值走同一套百分号编码。
            let extend = args
                .get(3)
                .and_then(Value::as_object)
                .map(|map| {
                    let mut keys: Vec<_> = map.iter().collect();
                    keys.sort_by_key(|(key, _)| *key);
                    keys.into_iter()
                        .filter_map(|(key, value)| {
                            let text = match value {
                                Value::String(text) => text.clone(),
                                Value::Number(number) => number.to_string(),
                                Value::Bool(flag) => flag.to_string(),
                                _ => return None,
                            };
                            if text.is_empty() {
                                return None;
                            }
                            // ac / t / pg 由本方法独占；extend 里同名键会变成
                            // 重复 query，源站取第一个还是最后一个不可预测。
                            if matches!(key.as_str(), "ac" | "t" | "pg" | "wd") {
                                return None;
                            }
                            Some(format!("{}={}", encode(key), encode(&text)))
                        })
                        .collect::<Vec<_>>()
                        .join("&")
                })
                .unwrap_or_default();
            // 已知分页参数由 pg 唯一持有，避免 extend 里同名键把页码覆盖掉。
            let tail = if extend.is_empty() {
                String::new()
            } else {
                format!("&{extend}")
            };
            Ok((
                format!(
                    "{api}{separator}ac=videolist&t={}&pg={page}{tail}",
                    encode(&tid)
                ),
                "cms.parseCategory",
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
                "cms.parseSearch",
                json!({ "wd": keyword, "quick": quick, "pg": page }),
            ))
        }
        SpiderMethod::DetailContent => {
            let id = arg_str(0);
            Ok((
                format!("{api}{separator}ac=detail&ids={}", encode(&id)),
                "cms.parseDetail",
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
/// CMS `playerContent`：不请求网络，只把 detail 里已给出的地址规范化。
///
/// - 绝对 http(s) 地址：原样回吐（常常带签名 query，不能重编码）；
/// - 相对地址：以站点 api 为 base 补全，让 `resolve_play` 拿得到可访问 URL；
/// - 私有 token / 空串：回 `{}`，前端 `resolveEpisodeTarget` 保留原地址并
///   按既有规则判 unresolvable / rejected（CMS 没有独立解析接口，不臆造）。
fn player_content(api: &str, args: &[Value]) -> Value {
    let Some(raw) = args.get(1).and_then(Value::as_str) else {
        return json!({});
    };
    let raw = raw.trim();
    if raw.is_empty() {
        return json!({});
    }
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return json!({ "parse": 0, "url": raw });
    }
    // 私有 token（`CO4K_abc%2FX` / `6105_0_1`）与相对路径都过不了
    // `starts_with(http)`，但 `Url::join` 对两者都会「成功」——必须按形态
    // 区分，否则会把 token 拼成 `http://site/CO4K_abc%2FX` 骗过前端的
    // HTTP_URL 检查，把解不开的线路当成功线路（markLineGood）。
    let looks_like_path = raw.starts_with('/')
        || (raw.contains('/')
            && !raw.contains('%')
            && [".m3u8", ".mp4", ".ts", ".flv"]
                .iter()
                .any(|ext| raw.to_ascii_lowercase().ends_with(ext)));
    if looks_like_path {
        if let Ok(base) = url::Url::parse(api) {
            if let Ok(joined) = base.join(raw) {
                let text = joined.to_string();
                if text.starts_with("http://") || text.starts_with("https://") {
                    return json!({ "parse": 0, "url": text });
                }
            }
        }
    }
    json!({})
}

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
    // 与反代 / 豆瓣同一套百分号编码（`infra::pct`），不再各自抄一份。
    crate::pct::percent_encode(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separator_keeps_trailing_slash_for_extensionless_paths() {
        assert_eq!(separator_for("https://x.com/api.php/provide/vod"), "/?");
        assert_eq!(separator_for("https://x.com/api.php"), "?");
        assert_eq!(
            separator_for("https://x.com/api.php/provide/vod?token=1"),
            "&"
        );
        assert_eq!(separator_for("http://127.0.0.1:8787/cms/vod"), "/?");
    }

    #[test]
    fn search_accepts_both_std_and_legacy_arg_shapes() {
        let (url, method, extra) = build(
            "https://x.com/api.php/provide/vod",
            SpiderMethod::SearchContent,
            &[json!("庆余年"), json!(false), json!(3)],
        )
        .expect("three-arg search must build");
        assert_eq!(method, "cms.parseSearch");
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
    async fn player_content_normalizes_detail_urls_without_network() {
        // CMS 的播放地址随 detailContent 下发；playerContent 不请求网络，
        // 只把地址规范化成契约信封，拿不到 HTTP 地址才回空对象。
        let site = json!({"key": "c", "type": 1, "api": "http://127.0.0.1:1/cms/vod/"});

        let absolute = invoke(
            &site,
            SpiderMethod::PlayerContent,
            &[json!("m3u8"), json!("https://cdn.example/a.m3u8?token=x"), json!([])],
        )
        .await
        .expect("absolute url must not fail");
        assert_eq!(absolute, json!({"parse": 0, "url": "https://cdn.example/a.m3u8?token=x"}));

        let relative = invoke(
            &site,
            SpiderMethod::PlayerContent,
            &[json!("m3u8"), json!("2024/1.m3u8"), json!([])],
        )
        .await
        .expect("relative url must not fail");
        assert_eq!(relative, json!({"parse": 0, "url": "http://127.0.0.1:1/cms/vod/2024/1.m3u8"}));

        // 私有 token / 空串仍回空对象，交前端按既有规则判 unresolvable。
        let token = invoke(
            &site,
            SpiderMethod::PlayerContent,
            &[json!("CO4K"), json!("CO4K_abc%2FX"), json!([])],
        )
        .await
        .expect("token must not fail");
        assert_eq!(token, json!({}));

        // No api at all must behave the same (no network attempt).
        let bare = json!({"key": "c", "type": 1});
        let out = invoke(&bare, SpiderMethod::PlayerContent, &[]).await;
        assert_eq!(out.expect("no api is fine here"), json!({}));
    }

    #[test]
    fn category_extend_is_forwarded_without_overwriting_paging() {
        let (url, _, _) = build(
            "https://x.com/api.php/provide/vod",
            SpiderMethod::CategoryContent,
            &[
                json!("1"),
                json!(3),
                json!(true),
                json!({"year": "2024", "area": "内地", "pg": "99", "ac": "hack"}),
            ],
        )
        .expect("extend must not break build");
        assert!(url.contains("pg=3"), "{url}");
        assert!(!url.contains("pg=99"), "{url}");
        assert!(!url.contains("ac=hack"), "{url}");
        assert!(url.contains("area=%E5%86%85%E5%9C%B0"), "{url}");
        assert!(url.contains("year=2024"), "{url}");
    }

    #[test]
    fn home_video_content_aliases_to_list() {
        // CMS 协议没有独立方法：homeVideoContent 必须 alias 回 ac=list，复用
        // cms 解析，避免 siteKey="all" 无差别调用时把 CMS 站记成 failed。
        let (url, method, extra) = build("http://x/vod", SpiderMethod::HomeVideoContent, &[])
            .expect("homeVideoContent must build for cms");
        assert!(url.contains("ac=list"), "{url}");
        assert_eq!(method, "cms.parseHome");
        assert_eq!(extra, json!({}));
    }
}
