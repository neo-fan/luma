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
    let api = site.get("api").and_then(Value::as_str).unwrap_or("");
    if api.is_empty() {
        return Err(AppError::new(code::INVALID_ARGUMENT, "cms site has no api"));
    }

    let (url, sidecar_method, extra) = build(api, method, args)?;

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
    let separator = if api.contains('?') { '&' } else { '?' };
    let arg_str = |index: usize| {
        args.get(index)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let arg_page = |index: usize| args.get(index).and_then(Value::as_u64).unwrap_or(1);

    match method {
        SpiderMethod::HomeContent => Ok((
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
            let page = arg_page(1);
            Ok((
                format!(
                    "{api}{separator}wd={}&ac=videolist&pg={page}",
                    encode(&keyword)
                ),
                "site.parseSearch",
                json!({ "wd": keyword, "quick": false, "pg": page }),
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
