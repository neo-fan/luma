use super::*;

#[test]
fn civil_dates_round_trip_known_days() {
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(civil_from_days(11_017), (2000, 3, 1));
    // 2024-02-29（闰日）与 2026-11-11。
    assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    assert_eq!(civil_from_days(20_768), (2026, 11, 11));
}

#[test]
fn level_filter_accepts_common_names() {
    assert_eq!(level_filter("debug"), LevelFilter::DEBUG);
    assert_eq!(level_filter("WARN"), LevelFilter::WARN);
    assert_eq!(level_filter("off"), LevelFilter::OFF);
    assert_eq!(level_filter("nonsense"), LevelFilter::INFO);
}

#[test]
fn redact_url_drops_query_and_fragment() {
    assert_eq!(
        redact_url("https://cdn.example.com/a/b.m3u8?token=secret#frag"),
        "https://cdn.example.com/a/b.m3u8"
    );
    assert_eq!(redact_url("  https://x.test/p  "), "https://x.test/p");
}

#[test]
fn sanitize_redacts_urls_inside_text() {
    let raw = "play failed: https://cdn.test/x.m3u8?sign=abc&expires=1 (upstream 503)";
    let out = sanitize(raw);
    assert!(out.contains("https://cdn.test/x.m3u8"));
    assert!(!out.contains("sign=abc"));
    assert!(out.contains("upstream 503"));
}

#[test]
fn truncate_chars_keeps_utf8_boundaries() {
    assert_eq!(truncate_chars("一二三四五", 3), "一二三…");
    assert_eq!(truncate_chars("abc", 5), "abc");
}

#[test]
fn config_diagnostics_counts_runtime_and_blocked() {
    let sites = serde_json::json!([
        {"key": "a", "runtime": "cms", "enabled": true},
        {"key": "b", "runtime": "python", "enabled": true},
        {"key": "c", "runtime": "jvm", "enabled": false, "disabledReason": "android dex"},
        {"key": "d", "runtime": "quickjs", "enabled": false, "disabledReason": "quickjs host"},
        {"key": "e", "runtime": "cms", "enabled": false}
    ]);
    let snapshot: crate::config::ConfigSnapshot = serde_json::from_value(serde_json::json!({
        "id": "cfg",
        "name": "box",
        "importedAt": "2026-11-11",
        "sites": sites,
        "lives": [{"name": "l"}],
        "parses": [{"name": "p"}],
        "headers": [{"host": "h"}]
    }))
    .unwrap();
    let info = diagnostics::config_diagnostics(Some(snapshot)).unwrap();
    assert_eq!(info.sites, 5);
    assert_eq!(info.enabled, 2);
    assert_eq!(info.blocked, 2);
    assert_eq!(info.jvm, 1);
    assert_eq!(info.quickjs, 1);
    assert_eq!(info.lives, 1);
    assert_eq!(info.parses, 1);
    assert_eq!(info.headers, 1);
}
