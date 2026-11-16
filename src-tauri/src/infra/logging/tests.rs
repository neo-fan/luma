use super::report::civil_from_days;
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
fn env_filter_accepts_levels_and_module_directives() {
    let assert_level = |raw: &str, expected: LevelFilter| {
        let filter = EnvFilter::builder()
            .with_default_directive(LevelFilter::INFO.into())
            .parse_lossy(raw);
        assert_eq!(filter.max_level_hint(), Some(expected), "raw = {raw}");
    };
    assert_level("debug", LevelFilter::DEBUG);
    assert_level("WARN", LevelFilter::WARN);
    assert_level("off", LevelFilter::OFF);
    // 空的 `LUMA_LOG` 不该把过滤关掉，也不该报错，落到默认 INFO。
    assert_level("", LevelFilter::INFO);
    // 模块级指令只放宽了指定模块，全局仍是 INFO。
    assert_level("luma_lib::spider=debug", LevelFilter::DEBUG);
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
fn redact_urls_is_idempotent_so_double_gates_are_free() {
    // 前端通道先 `sanitize`、落盘时 `CappedWriter` 再过一遍：第二遍必须是
    // no-op，否则「已脱敏」的 URL 会被再裁一次（截断符号叠加会弄脏日志）。
    let once = redact_urls("get https://cdn.test/x.m3u8?token=*** failed");
    let twice = redact_urls(&once);
    assert_eq!(once, "get https://cdn.test/x.m3u8 failed");
    assert_eq!(once, twice);
}

#[test]
fn capped_writer_redacts_before_hitting_the_disk() {
    // 落盘闸：宿主通道的日志体里带签名 query 时，磁盘上只能看到 scheme+host+path。
    // 这条测试就是 2026-11-16 评审 P1（诊断导出外泄令牌）的回归守卫。
    let dir = std::env::temp_dir().join(format!("luma-log-redact-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create dir");
    let appender = appender(&dir, Channel::App).expect("appender");
    let mut writer = CappedWriter::new(appender, dir.join(Channel::App.dir_name()), Channel::App.file_prefix());
    let line = b"proxy upstream failed: https://cdn.test/seg.ts?sign=SECRET-TOKEN&exp=1 (503)\n";
    writer.write_all(line).expect("write");
    writer.flush().expect("flush");

    let text: String = fs::read_dir(dir.join(Channel::App.dir_name()))
        .expect("read dir")
        .flatten()
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .collect::<Vec<_>>()
        .join("");
    let _ = fs::remove_dir_all(&dir);

    assert!(text.contains("https://cdn.test/seg.ts"), "{text}");
    assert!(!text.contains("SECRET-TOKEN"), "query token leaked to disk: {text}");
    assert!(!text.contains("exp=1"), "query leaked to disk: {text}");
}

#[test]
fn capped_writer_survives_tiny_fragments() {
    // fmt 层是按参数分开写的：一个字段值可能单独成一次 write。
    // 短于 7 字节的缓冲区不得 panic（`windows` 的硬约束），含完整 URL 的
    // 片段必须被裁掉 query。
    let dir = std::env::temp_dir().join(format!("luma-log-frag-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("create dir");
    let appender = appender(&dir, Channel::App).expect("appender");
    let mut writer = CappedWriter::new(appender, dir.join(Channel::App.dir_name()), Channel::App.file_prefix());
    // write_all 会反复调 write()：这里同时验证「返回值必须按输入长度消费」，
    // 否则脱敏后变短会让 write_all 把原文尾巴继续灌进来。
    writer.write_all(b"ab").expect("tiny fragment");
    writer
        .write_all(b"url=https://cdn.test/x.ts?t=SECRET\n")
        .expect("url fragment");
    writer.flush().expect("flush");

    let text: String = fs::read_dir(dir.join(Channel::App.dir_name()))
        .expect("read dir")
        .flatten()
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .collect::<Vec<_>>()
        .join("");
    let _ = fs::remove_dir_all(&dir);

    assert!(text.contains("ab"), "{text}");
    assert!(text.contains("url=https://cdn.test/x.ts"), "{text}");
    assert!(!text.contains("SECRET"), "query leaked: {text}");
}

#[test]
fn config_diagnostics_counts_runtime_and_blocked() {
    // infra 侧只见中性摘要（`ConfigDigest`）：快照 → 摘要的折算在
    // `domain/diagnostics.rs`，那层的口径有它自己的单测。
    let sites = serde_json::json!([
        {"key": "a", "runtime": "cms", "enabled": true},
        {"key": "b", "runtime": "python", "enabled": true},
        {"key": "c", "runtime": "jvm", "enabled": false, "disabledReason": "android dex"},
        {"key": "d", "runtime": "quickjs", "enabled": false, "disabledReason": "quickjs host"},
        {"key": "e", "runtime": "cms", "enabled": false}
    ]);
    let digest = ConfigDigest {
        id: "cfg".to_string(),
        name: "box".to_string(),
        sites: sites.as_array().cloned().unwrap(),
        lives: 1,
        parses: 1,
        headers: 1,
    };
    let info = diagnostics::config_diagnostics(Some(digest)).unwrap();
    assert_eq!(info.sites, 5);
    assert_eq!(info.enabled, 2);
    assert_eq!(info.blocked, 2);
    assert_eq!(info.jvm, 1);
    assert_eq!(info.quickjs, 1);
    assert_eq!(info.lives, 1);
    assert_eq!(info.parses, 1);
    assert_eq!(info.headers, 1);
}
