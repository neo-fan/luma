//! Generic parse pool (`parses[]`) — spec 8.6 level 3.
//!
//! A spider that cannot hand out a playable URL returns `parse=1` (or `jx=1`)
//! from `playerContent` together with the play page. TVBox then runs that page
//! through a pool of configured parsers. The `type` numbers are magic numbers
//! upstream; the semantics below match both FongMi/TV and the older Box forks,
//! which agree on 0..4:
//!
//! | type | meaning | request |
//! |------|---------|---------|
//! | 0 | webview sniff | open `rule.url + playUrl`, sniff the stream |
//! | 1 | JSON API | `GET rule.url + playUrl`, read `url` (fallback `data.url`) |
//! | 2/3 | JAR reflection (`com.github.catvod.parser.Json*`) | out of scope |
//! | 4 | race | run every type-1 and type-0 candidate, first success wins |
//!
//! Two upstream details worth keeping: the play URL is **appended verbatim**
//! (no percent-encoding), and `ext.flag` only narrows the candidate list —
//! when nothing matches, the full list is used instead. There is no "try them
//! in order" behaviour: candidates either race or one is used alone.

use crate::config::ConfigStore;
use crate::error::{code, AppError};
use crate::http::{self, FetchRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;

/// Upstream uses a 15s budget for the whole pool (`Constant.TIMEOUT_PARSE_DEF`).
const TOTAL_BUDGET: Duration = Duration::from_secs(15);
/// Per-candidate ceiling so one dead parser cannot eat the whole budget.
const PER_CANDIDATE: Duration = Duration::from_secs(12);
/// Stream suffixes we accept from a JSON parser. Anything else is treated as
/// another page and kept going through the webview path instead.
const STREAM_HINTS: [&str; 8] = [
    ".m3u8", ".flv", ".mp4", ".mkv", ".ts", ".mov", ".webm", "m3u8",
];
/// Every web candidate opens its own hidden WebView2 and sniffing is
/// serialised, so a pool with a dozen web parsers would queue a dozen windows.
/// Upstream races them as iframes inside a single window; we cap the race.
const MAX_WEB_CANDIDATES: usize = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseRequest {
    pub site_key: String,
    /// The play page / line value returned by `playerContent`.
    pub url: String,
    /// Line name (`vod_play_from`); used for `ext.flag` matching.
    #[serde(default)]
    pub flag: String,
    /// Site headers, used when a rule does not declare its own.
    #[serde(default)]
    pub headers: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseResolved {
    pub url: String,
    /// Name of the parser that produced `url`, for the "解析来自" hint.
    pub parser: String,
    /// `json` or `webview` — where the answer came from.
    pub kind: String,
    pub headers: Vec<(String, String)>,
    /// Parsers that were tried and failed, as `name: reason`.
    pub tried: Vec<String>,
}

#[derive(Debug, Clone)]
struct Rule {
    name: String,
    kind: u8,
    url: String,
    header: HashMap<String, String>,
    flags: Vec<String>,
}

fn str_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn parse_rules(parses: &[Value]) -> Vec<Rule> {
    let mut out = Vec::new();
    for item in parses {
        if !item.is_object() {
            continue;
        }
        let url = str_at(item, "url");
        if url.is_empty() {
            continue;
        }
        // 用 saturating 转换而非 `as u8`：外部配置若给 type=256+，`as` 会回绕成
        // 0/1/4 等合法值，把未知类型误判成 webview/json/super。钳到 u8::MAX(255)
        // 这个「谁都不匹配」的哨兵，交给下面的默认分支处理。
        let kind = u8::try_from(
            item.get("type")
                .and_then(|value| {
                    value
                        .as_u64()
                        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
                })
                .unwrap_or(0),
        )
        .unwrap_or(u8::MAX);
        let ext = item.get("ext").cloned().unwrap_or(Value::Null);
        let header = ext
            .get("header")
            .and_then(Value::as_object)
            .map(|map| {
                map.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let flags = ext
            .get("flag")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        out.push(Rule {
            name: {
                let name = str_at(item, "name");
                if name.is_empty() {
                    format!("parser-{kind}")
                } else {
                    name
                }
            },
            kind,
            url,
            header,
            flags,
        });
    }
    out
}

/// TVBox appends the play URL as-is. Rules that already end in `=` (the common
/// `...?url=` form) get a plain concatenation; anything else gets a query key.
fn join_target(rule: &str, play: &str) -> String {
    if rule.contains("{url}") {
        return rule.replace("{url}", play);
    }
    if rule.ends_with('=') {
        return format!("{rule}{play}");
    }
    let separator = if rule.contains('?') { '&' } else { '?' };
    format!("{rule}{separator}url={play}")
}

/// `ext.flag` narrows the list only when it matches; otherwise keep everything
/// (upstream `VodConfig.getParses(type, flag)`).
fn narrow<'a>(rules: Vec<&'a Rule>, flag: &str) -> Vec<&'a Rule> {
    if flag.is_empty() {
        return rules;
    }
    let matched: Vec<&Rule> = rules
        .iter()
        .copied()
        .filter(|rule| {
            rule.flags
                .iter()
                .any(|item| item.eq_ignore_ascii_case(flag))
        })
        .collect();
    if matched.is_empty() {
        rules
    } else {
        matched
    }
}

fn looks_like_stream(url: &str) -> bool {
    let lowered = url.to_ascii_lowercase();
    STREAM_HINTS.iter().any(|hint| lowered.contains(hint))
}

async fn json_candidate(
    rule: Rule,
    play: String,
    base_headers: HashMap<String, String>,
) -> Result<ParseResolved, String> {
    let target = join_target(&rule.url, &play);
    // Upstream: a rule's own header replaces the site header wholesale.
    let headers = if rule.header.is_empty() {
        base_headers
    } else {
        rule.header.clone()
    };
    let response = http::fetch(FetchRequest {
        url: target,
        method: Some("GET".to_string()),
        headers: Some(headers.clone()),
        body: None,
        timeout_ms: Some(PER_CANDIDATE.as_millis() as u64),
    })
    .await
    .map_err(|err| err.message)?;

    if response.status >= 400 {
        return Err(format!("HTTP {}", response.status));
    }
    let body: Value = serde_json::from_str(&response.body).map_err(|_| "not JSON".to_string())?;
    let resolved = body
        .get("url")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            body.get("data")
                .and_then(|data| data.get("url"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| "no url in response".to_string())?;

    // The response may carry its own UA/Referer/Cookie for the stream request.
    let mut out_headers: Vec<(String, String)> = Vec::new();
    if let Some(object) = body.as_object() {
        for (name, value) in object {
            let lower = name.to_ascii_lowercase();
            if !matches!(lower.as_str(), "user-agent" | "referer" | "cookie" | "ua") {
                continue;
            }
            if let Some(text) = value.as_str().filter(|text| !text.is_empty()) {
                let canonical = if lower == "ua" {
                    "User-Agent"
                } else {
                    name.as_str()
                };
                out_headers.push((canonical.to_string(), text.to_string()));
            }
        }
    }
    if out_headers.is_empty() {
        out_headers = headers.into_iter().collect();
    }

    if !resolved.starts_with("http") {
        // Some pools answer with another share link; keep it as a page.
        return Err(format!(
            "non-http result: {}",
            &resolved[..resolved.len().min(40)]
        ));
    }
    if !looks_like_stream(resolved) {
        // A JSON parser that returns a page is useless to us; let the webview
        // candidates (or the caller's fallback) have a go instead.
        return Err("result is not a stream".to_string());
    }

    Ok(ParseResolved {
        url: resolved.to_string(),
        parser: rule.name,
        kind: "json".to_string(),
        headers: out_headers,
        tried: Vec::new(),
    })
}

async fn web_candidate(
    app: tauri::AppHandle,
    rule: Rule,
    play: String,
) -> Result<ParseResolved, String> {
    let target = join_target(&rule.url, &play);
    let media = crate::sniff::sniff(&app, &target, PER_CANDIDATE)
        .await
        .map_err(|err| err.message)?;
    Ok(ParseResolved {
        url: media,
        parser: rule.name,
        kind: "webview".to_string(),
        headers: rule.header.into_iter().collect(),
        tried: Vec::new(),
    })
}

/// Run a set of already-selected parse rules against `request.url`. JSON rules
/// (type 1) hit the API; webview rules (type 0) sniff. This is the shared core
/// used by both the flag-based `parse_resolve` pool and the `scheme://` link
/// resolver. Web candidates are capped because each opens a hidden WebView2.
async fn run_pool(
    app: &tauri::AppHandle,
    json_rules: Vec<&Rule>,
    web_rules: Vec<&Rule>,
    base_headers: HashMap<String, String>,
    play: String,
) -> Result<ParseResolved, AppError> {
    if json_rules.is_empty() && web_rules.is_empty() {
        return Err(AppError::new(
            code::PLAY_RESOLVE_FAIL,
            "no usable parser candidates for this request",
        ));
    }
    let web_rules: Vec<&Rule> = web_rules.into_iter().take(MAX_WEB_CANDIDATES).collect();

    let (tx, mut rx) = mpsc::channel::<(String, Result<ParseResolved, String>)>(16);
    let mut tasks = Vec::new();
    for rule in json_rules {
        let tx = tx.clone();
        let rule = rule.clone();
        let play = play.clone();
        let headers = base_headers.clone();
        tasks.push(tokio::spawn(async move {
            let name = rule.name.clone();
            let outcome = json_candidate(rule, play, headers).await;
            let _ = tx.send((name, outcome)).await;
        }));
    }
    for rule in web_rules {
        let tx = tx.clone();
        let rule = rule.clone();
        let play = play.clone();
        let app = app.clone();
        tasks.push(tokio::spawn(async move {
            let name = rule.name.clone();
            let outcome = web_candidate(app, rule, play).await;
            let _ = tx.send((name, outcome)).await;
        }));
    }
    drop(tx);

    let mut tried = Vec::new();
    let deadline = tokio::time::Instant::now() + TOTAL_BUDGET;
    let winner = loop {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some((name, Ok(hit)))) => break Some((name, hit)),
            Ok(Some((name, Err(reason)))) => tried.push(format!("{name}: {reason}")),
            Ok(None) => break None,
            Err(_) => {
                tried.push(format!("budget: exceeded {}s", TOTAL_BUDGET.as_secs()));
                break None;
            }
        }
    };

    for task in tasks {
        task.abort();
    }

    match winner {
        Some((_, mut hit)) => {
            hit.tried = tried;
            Ok(hit)
        }
        None => Err(AppError::new(
            code::PLAY_RESOLVE_FAIL,
            format!("all {} parsers failed", tried.len()),
        )
        .with_details(serde_json::json!({ "tried": tried }))),
    }
}

/// Run the pool. Split from the command so it can be exercised without a
/// window for the JSON-only paths.
async fn resolve_with(
    app: &tauri::AppHandle,
    parses: &[Value],
    request: &ParseRequest,
) -> Result<ParseResolved, AppError> {
    let rules = parse_rules(parses);
    if rules.is_empty() {
        return Err(AppError::new(
            code::PLAY_RESOLVE_FAIL,
            "config declares no usable parsers",
        ));
    }

    let flag = request.flag.as_str();
    let json_rules = narrow(rules.iter().filter(|rule| rule.kind == 1).collect(), flag);
    let web_rules = narrow(rules.iter().filter(|rule| rule.kind == 0).collect(), flag);
    let has_super = rules.iter().any(|rule| rule.kind == 4);

    // Type 4 is "race everything"; when the pool only has one flavour we still
    // race within it, which matches observed upstream behaviour closely enough
    // and never picks a worse parser than the config order would.
    let mut runs_json = json_rules.clone();
    let mut runs_web = web_rules.clone();
    if !has_super && runs_json.is_empty() && runs_web.is_empty() {
        // Only type 2/3 (JAR) parsers exist — nothing we can execute.
        return Err(AppError::new(
            code::RUNTIME_UNAVAILABLE,
            "only JAR-based parsers configured (type 2/3); unsupported",
        ));
    }
    if !has_super {
        // Non-super pools use one flavour: prefer JSON (cheap, no window).
        if !runs_json.is_empty() {
            runs_web.clear();
        } else {
            runs_json.clear();
        }
    }

    let base_headers = request.headers.clone().unwrap_or_default();
    run_pool(app, runs_json, runs_web, base_headers, request.url.clone()).await
}

/// Resolve a `scheme://` style parse link (e.g. `huangdou2://<page>`).
///
/// In TVBox a play URL whose scheme is neither `http` nor `https` names a parser
/// from `parses[]`: the scheme *is* the parser `name`, and the text after
/// `scheme://` is the target page to hand to that parser. Some configs ship the
/// parser under a different name, so when no parser matches the scheme we fall
/// back to the whole `parses[]` pool — any universal parser the config carries
/// can still resolve the link.
pub async fn resolve_scheme_link(
    app: &tauri::AppHandle,
    parses: &[Value],
    scheme: &str,
    target: &str,
    headers: HashMap<String, String>,
) -> Result<ParseResolved, AppError> {
    let rules = parse_rules(parses);
    let matched: Vec<&Rule> = rules
        .iter()
        .filter(|rule| rule.name.eq_ignore_ascii_case(scheme))
        .collect();

    let request = ParseRequest {
        site_key: String::new(),
        url: target.to_string(),
        flag: String::new(),
        headers: Some(headers.clone()),
    };

    if !matched.is_empty() {
        // Mirror resolve_with's one-flavour preference when only a single kind
        // is present for the named parser.
        let json_rules: Vec<&Rule> = matched.iter().copied().filter(|r| r.kind == 1).collect();
        let web_rules: Vec<&Rule> = matched.iter().copied().filter(|r| r.kind == 0).collect();
        let (runs_json, runs_web) = if json_rules.is_empty() {
            (Vec::new(), web_rules)
        } else if web_rules.is_empty() {
            (json_rules, Vec::new())
        } else {
            (json_rules, Vec::new())
        };
        return run_pool(app, runs_json, runs_web, headers, request.url.clone()).await;
    }

    // No parser named after the scheme: let the full pool have a go.
    resolve_with(app, parses, &request).await
}

#[tauri::command]
pub async fn parse_resolve(
    app: tauri::AppHandle,
    config: tauri::State<'_, ConfigStore>,
    request: ParseRequest,
) -> Result<ParseResolved, AppError> {
    let parses = config.active_parses();
    match resolve_with(&app, &parses, &request).await {
        Ok(hit) => {
            tracing::info!(
                site = %request.site_key,
                parser = %hit.parser,
                kind = %hit.kind,
                "parse pool resolved"
            );
            Ok(hit)
        }
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn join_appends_verbatim_after_equals() {
        assert_eq!(
            join_target("https://jx.example/?url=", "https://v.qq.com/x/1.html"),
            "https://jx.example/?url=https://v.qq.com/x/1.html"
        );
    }

    #[test]
    fn join_adds_query_key_when_rule_has_none() {
        assert_eq!(
            join_target("https://jx.example/parse", "https://v.qq.com/x"),
            "https://jx.example/parse?url=https://v.qq.com/x"
        );
        assert_eq!(
            join_target("https://jx.example/parse?a=1", "https://v.qq.com/x"),
            "https://jx.example/parse?a=1&url=https://v.qq.com/x"
        );
    }

    #[test]
    fn join_expands_placeholder() {
        assert_eq!(
            join_target("https://jx.example/?target={url}", "https://v.qq.com/x"),
            "https://jx.example/?target=https://v.qq.com/x"
        );
    }

    #[test]
    fn rules_are_read_from_config_shape() {
        let parses = vec![
            json!({ "name": "a", "type": 1, "url": "https://a/?url=",
                    "ext": { "flag": ["qq"], "header": { "User-Agent": "ua-a" } } }),
            json!({ "name": "b", "type": "0", "url": "https://b/?url=" }),
            json!({ "name": "c", "type": 4, "url": "https://c/?url=" }),
            json!({ "name": "no-url", "type": 1 }),
        ];
        let rules = parse_rules(&parses);
        assert_eq!(rules.len(), 3, "rule without url must be dropped");
        assert_eq!(rules[0].kind, 1);
        assert_eq!(rules[1].kind, 0, "string type must parse");
        assert_eq!(rules[0].flags, vec!["qq".to_string()]);
        assert_eq!(
            rules[0].header.get("User-Agent").map(String::as_str),
            Some("ua-a")
        );
    }

    #[test]
    fn flag_narrows_only_on_match() {
        let rules = vec![
            Rule {
                name: "qq".into(),
                kind: 1,
                url: String::new(),
                header: Default::default(),
                flags: vec!["qq".into()],
            },
            Rule {
                name: "all".into(),
                kind: 1,
                url: String::new(),
                header: Default::default(),
                flags: vec![],
            },
        ];
        let refs: Vec<&Rule> = rules.iter().collect();
        let hit = narrow(refs.clone(), "qq");
        assert_eq!(hit.len(), 1, "matching flag narrows the pool");
        let miss = narrow(refs, "youku");
        assert_eq!(miss.len(), 2, "no match falls back to the full pool");
    }

    #[test]
    fn stream_hint_accepts_common_suffixes() {
        assert!(looks_like_stream("https://cdn/x/index.m3u8?t=1"));
        assert!(looks_like_stream("https://cdn/a.mp4"));
        assert!(!looks_like_stream("https://v.qq.com/x/cover/abc.html"));
    }
}
