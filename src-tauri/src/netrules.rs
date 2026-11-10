//! Config-level `headers[]`: per-host request headers (TVBox's top-level field).
//!
//! Community configs ship a small host → header table so CDN endpoints that
//! reject the default UA still work, e.g. `media.example.com` expects
//! `okHttp/Mod-1.5.0.0` and `hls.example.com` expects
//! `bingcha/1.1`. Without it those streams answer 403 even though the play URL
//! resolved fine.
//!
//! The table is global and replaced wholesale on every config import: it
//! describes the active config, not per-site state.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

#[derive(Debug, Clone, Default)]
struct HostHeaders {
    /// Lowercase host (or `*.suffix` / `.suffix`) → header name/value pairs.
    rules: HashMap<String, Vec<(String, String)>>,
}

static RULES: OnceLock<RwLock<HostHeaders>> = OnceLock::new();

fn store() -> &'static RwLock<HostHeaders> {
    RULES.get_or_init(|| RwLock::new(HostHeaders::default()))
}

/// Entries look like `{"host": "cdn.example", "header": {"User-Agent": "..."}}`.
pub fn replace(rules: &[Value]) {
    let mut next = HostHeaders::default();
    for item in rules {
        if !item.is_object() {
            continue;
        }
        let host = item
            .get("host")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if host.is_empty() {
            continue;
        }
        let header = item.get("header").and_then(Value::as_object);
        let pairs: Vec<(String, String)> = header
            .map(|map| {
                map.iter()
                    .filter_map(|(name, value)| {
                        value.as_str().map(|text| (name.clone(), text.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if pairs.is_empty() {
            continue;
        }
        next.rules.insert(host, pairs);
    }
    let count = next.rules.len();
    match store().write() {
        Ok(mut guard) => *guard = next,
        Err(poisoned) => *poisoned.into_inner() = next,
    }
    tracing::info!(count, "host header rules loaded");
}

/// Header pairs that apply to `url`. Exact host match wins, otherwise a
/// wildcard rule (`*.example.com` or `.example.com`).
pub fn headers_for(url: &str) -> Vec<(String, String)> {
    let Ok(parsed) = url::Url::parse(url) else {
        return Vec::new();
    };
    let Some(host) = parsed.host_str() else {
        return Vec::new();
    };
    let host = host.to_ascii_lowercase();
    let guard = match store().read() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(pairs) = guard.rules.get(&host) {
        return pairs.clone();
    }
    for (pattern, pairs) in guard.rules.iter() {
        let suffix = pattern
            .strip_prefix("*.")
            .or_else(|| pattern.strip_prefix('.'));
        if let Some(suffix) = suffix {
            if host == suffix || host.ends_with(&format!(".{suffix}")) {
                return pairs.clone();
            }
        }
    }
    Vec::new()
}

/// Merge host rules under explicit headers: the caller's values win, because a
/// spider that returned its own UA knows better than the config table.
pub fn merged_for(url: &str, explicit: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = headers_for(url);
    for (name, value) in explicit {
        let lower = name.to_ascii_lowercase();
        if let Some(slot) = out.iter_mut().find(|(key, _)| key.to_ascii_lowercase() == lower) {
            slot.1 = value.clone();
        } else {
            out.push((name.clone(), value.clone()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn load(rules: Value) {
        replace(rules.as_array().map(Vec::as_slice).unwrap_or(&[]));
    }

    /// The rule table is process-global, so tests must not run concurrently.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn exact_host_match() {
        let _guard = serial();
        load(json!([{
            "host": "media.example.com",
            "header": { "User-Agent": "okHttp/Mod-1.5.0.0", "Referer": "https://media.example.com/" }
        }]));
        let hit = headers_for("https://media.example.com/live/a.m3u8?t=1");
        assert_eq!(hit.len(), 2);
        assert!(hit.iter().any(|(k, v)| k == "User-Agent" && v == "okHttp/Mod-1.5.0.0"));
        assert!(headers_for("https://other.example/a.m3u8").is_empty());
    }

    #[test]
    fn host_match_ignores_case() {
        let _guard = serial();
        load(json!([{ "host": "CDN.Example.COM", "header": { "User-Agent": "ua" } }]));
        assert_eq!(headers_for("https://cdn.example.com/x.m3u8").len(), 1);
    }

    #[test]
    fn wildcard_matches_subdomains_only() {
        let _guard = serial();
        load(json!([{ "host": "*.example.com", "header": { "User-Agent": "bingcha/1.1" } }]));
        assert_eq!(headers_for("https://hls.example.com/a.m3u8").len(), 1);
        assert_eq!(headers_for("https://example.com/a.m3u8").len(), 1);
        assert!(headers_for("https://notexample.com/a.m3u8").is_empty());
    }

    #[test]
    fn explicit_headers_override_table() {
        let _guard = serial();
        load(json!([{ "host": "cdn.example", "header": { "User-Agent": "from-table" } }]));
        let merged = merged_for(
            "https://cdn.example/x.m3u8",
            &[("User-Agent".to_string(), "from-spider".to_string())],
        );
        assert_eq!(merged.len(), 1, "no duplicate entries");
        assert_eq!(merged[0].1, "from-spider");
    }

    #[test]
    fn entries_without_header_or_host_are_skipped() {
        let _guard = serial();
        load(json!([
            { "host": "a.example" },
            { "host": "", "header": { "User-Agent": "x" } },
            { "host": "b.example", "header": { "User-Agent": "y" } }
        ]));
        assert!(headers_for("https://a.example/x").is_empty());
        assert_eq!(headers_for("https://b.example/x").len(), 1);
    }
}
