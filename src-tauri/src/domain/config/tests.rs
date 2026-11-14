use super::*;
use super::derive::*;
use super::naming::*;

    fn snapshot(id: &str, keys: &[&str]) -> ConfigSnapshot {
        let sites: Vec<Value> = keys
            .iter()
            .map(|key| json!({ "key": key, "name": key }))
            .collect();
        serde_json::from_value(json!({
            "id": id,
            "name": id,
            "importedAt": "2026-01-01T00:00:00Z",
            "sites": sites,
        }))
        .expect("snapshot fixture")
    }

    /// 站点体检 fixture：带上 `api` / `runtime` / `enabled`，区别于 `snapshot`
    /// 造出的仅 key/name 的占位站点。
    fn site_snapshot(sites: Vec<Value>) -> ConfigSnapshot {
        let mut snap = snapshot("box", &[]);
        snap.sites = sites;
        snap
    }

    fn site_by_key<'a>(sites: &'a [Value], key: &str) -> &'a Value {
        sites
            .iter()
            .find(|site| site.get("key").and_then(Value::as_str) == Some(key))
            .expect("site present")
    }

    fn text_source() -> ConfigSource {
        ConfigSource {
            kind: "text".into(),
            value: String::new(),
            name: None,
        }
    }

    /// Each test owns a separate SQLite file. `LUMA_DATA_DIR` is process-wide,
    /// so the guard is held for the whole test, not just during setup.
    static DATA_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    fn isolate_data_dir() -> (std::sync::MutexGuard<'static, ()>, std::path::PathBuf) {
        let guard = DATA_DIR_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "luma-config-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        crate::env::set("DATA_DIR", &dir);
        (guard, dir)
    }

    /// Fresh process-like state: open the DB and rebuild the in-memory cache.
    fn store_at(dir: &std::path::Path) -> ConfigStore {
        let db = Arc::new(Db::at(dir.to_path_buf()).expect("open sqlite db"));
        ConfigStore::load(db).expect("load config store")
    }

    #[test]
    fn fanout_is_scoped_to_the_active_config() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        let source = ConfigSource {
            kind: "text".into(),
            value: String::new(),
            name: None,
        };
        store.insert(snapshot("old", &["stub_a"]), source.clone()).unwrap();
        assert_eq!(store.all_sites().len(), 1);

        store.insert(snapshot("new", &["real_a", "real_b"]), source).unwrap();
        let keys: Vec<String> = store
            .all_sites()
            .iter()
            .filter_map(|site| site.get("key").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert_eq!(keys, vec!["real_a".to_string(), "real_b".to_string()]);
        // Detail/playback lookups stay global: an old favourite must still open.
        assert!(store.find_site("stub_a").is_ok());

        store.remove("new").expect("remove active config");
        assert_eq!(store.all_sites().len(), 1, "active falls back to the remaining config");
    }

    #[test]
    fn newest_import_wins_over_read_dir_order() {
        let source = ConfigSource {
            kind: "text".into(),
            value: String::new(),
            name: None,
        };
        let mut stale = snapshot("old", &["stub_a"]);
        stale.imported_at = "2026-01-01T00:00:00Z".into();
        let mut current = snapshot("box", &["real_a", "real_b"]);
        current.imported_at = "2026-11-10T09:14:17Z".into();
        // Deliberately put the stale entry last: that is exactly how read_dir
        // ordered `old.json` after the real config on this machine.
        let entries = vec![
            StoredConfig {
                imported: current,
                runtime: None,
                source: source.clone(),
            },
            StoredConfig {
                imported: stale,
                runtime: None,
                source,
            },
        ];
        assert_eq!(newest_id(&entries).as_deref(), Some("box"));
    }

    #[test]
    fn derive_runtime_blocks_only_jar_and_keeps_js_runnable() {
        let mut imported = snapshot("box", &[]);
        imported.sites = vec![
            json!({"key": "cms", "runtime": "cms", "enabled": true}),
            json!({"key": "py", "runtime": "python", "enabled": true}),
            json!({"key": "jar", "runtime": "jvm", "enabled": true}),
            json!({"key": "js", "runtime": "quickjs", "enabled": true}),
            json!({"key": "divider", "runtime": "none", "enabled": false}),
        ];
        let before = imported.sites.clone();
        let runtime = derive_runtime(&imported);

        // The import is the source of truth: the transform must be read-only.
        assert_eq!(imported.sites, before);
        let site = |key: &str| -> Value {
            runtime
                .sites
                .iter()
                .find(|site| site.get("key").and_then(Value::as_str) == Some(key))
                .expect("site present")
                .clone()
        };
        // jar / Android dex is the only blocked runtime now.
        assert_eq!(site("jar").get("enabled").and_then(Value::as_bool), Some(false));
        assert!(site("jar").get("disabledReason").and_then(Value::as_str).is_some());
        // JS sources have a real runtime (ESM loader + assets://), so they must
        // stay enabled with no disabledReason. This is the regression guard for
        // the old runtime==quickjs blanket block.
        for key in ["cms", "py", "js"] {
            assert_eq!(site(key).get("enabled").and_then(Value::as_bool), Some(true));
            assert!(site(key).get("disabledReason").is_none());
        }
        assert_eq!(blocked_reason(&site("js")), None);
        assert_eq!(site("divider").get("enabled").and_then(Value::as_bool), Some(false));
        // Config-level fields are inherited, not rebuilt from scratch.
        assert_eq!(runtime.id, imported.id);
        assert_eq!(runtime.headers, imported.headers);
        // Re-deriving from the same import is idempotent (no stacked policy).
        assert_eq!(derive_runtime(&imported).sites, runtime.sites);
    }

    #[test]
    fn policy_replay_unblocks_js_but_keeps_manual_disables() {
        let mut runtime = snapshot("box", &[]);
        runtime.sites = vec![
            json!({"key": "js", "runtime": "quickjs", "enabled": false,
                   "disabledReason": "JS 源（drpy2 / ES 模块）暂不支持"}),
            json!({"key": "js_manual", "runtime": "quickjs", "enabled": false,
                   "disabledReason": "已在站点体检中手动禁用"}),
            json!({"key": "jar", "runtime": "jvm", "enabled": true}),
            json!({"key": "cms", "runtime": "cms", "enabled": true}),
        ];
        assert!(refresh_policy(&mut runtime));
        let site = |key: &str| -> Value {
            runtime
                .sites
                .iter()
                .find(|site| site.get("key").and_then(Value::as_str) == Some(key))
                .expect("site present")
                .clone()
        };
        // Retired JS block is reverted.
        assert_eq!(site("js").get("enabled").and_then(Value::as_bool), Some(true));
        assert!(site("js").get("disabledReason").is_none());
        // A user disable is not a policy row and must survive.
        assert_eq!(
            site("js_manual").get("enabled").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            site("js_manual").get("disabledReason").and_then(Value::as_str),
            Some("已在站点体检中手动禁用")
        );
        // jvm is still blocked and gets the current reason.
        assert_eq!(site("jar").get("enabled").and_then(Value::as_bool), Some(false));
        assert!(site("jar").get("disabledReason").and_then(Value::as_str).is_some());
        assert_eq!(site("cms").get("enabled").and_then(Value::as_bool), Some(true));
        // Idempotent: nothing left to replay.
        assert!(!refresh_policy(&mut runtime));
    }

    #[test]
    fn active_config_survives_restart_and_deletion() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        let source = ConfigSource {
            kind: "text".into(),
            value: String::new(),
            name: None,
        };
        let mut stale = snapshot("old", &["stub_a"]);
        stale.imported_at = "2026-01-01T00:00:00Z".into();
        let mut current = snapshot("box", &["real_a", "real_b"]);
        current.imported_at = "2026-11-10T09:14:17Z".into();
        store.insert(stale, source.clone()).unwrap();
        store.insert(current, source).unwrap();

        let restarted = store_at(&dir);
        assert_eq!(restarted.list().len(), 2);
        assert_eq!(restarted.active_snapshot().unwrap().id, "box");
        assert_eq!(restarted.all_sites().len(), 2);

        restarted.remove("box").unwrap();
        let after = store_at(&dir);
        assert_eq!(after.list().len(), 1);
        assert_eq!(after.active_snapshot().unwrap().id, "old");
        assert_eq!(after.all_sites().len(), 1);
        assert!(after.remove("missing").is_err(), "unknown id is rejected");
    }

    #[test]
    fn default_name_uses_the_domain_for_urls() {
        let url = |value: &str| ConfigSource {
            kind: "url".into(),
            value: value.into(),
            name: None,
        };
        // `www.` and the path are noise; the registrable host is the label.
        // Chinese domains must stay readable: `url::Url` would IDNA them into
        // `xn--…`, which is unusable in the UI.
        assert_eq!(
            default_name(&url("https://www.例子.测试/tv/box.json"), "box"),
            "例子.测试"
        );
        assert_eq!(default_name(&url("http://example.com:8080/api"), "box"), "example.com");
        // No host to show: keep what the normalizer derived.
        assert_eq!(default_name(&url("not a url"), "box"), "box");
        assert_eq!(
            default_name(
                &ConfigSource {
                    kind: "text".into(),
                    value: "{}".into(),
                    name: None,
                },
                "本地配置"
            ),
            "本地配置"
        );
    }

    #[test]
    fn clean_name_trims_and_caps_length() {
        assert_eq!(clean_name("  我的配置 \n"), "我的配置");
        assert_eq!(clean_name("   "), "");
        assert_eq!(clean_name(&"x".repeat(80)).chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn activate_switches_the_live_config_and_persists_it() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        let source = ConfigSource {
            kind: "text".into(),
            value: String::new(),
            name: None,
        };
        let mut first = snapshot("aaa", &["site_a"]);
        first.imported_at = "2026-01-01T00:00:00Z".into();
        let mut second = snapshot("bbb", &["site_b", "site_c"]);
        second.imported_at = "2026-02-01T00:00:00Z".into();
        store.insert(first, source.clone()).unwrap();
        // The newest import becomes active, so switching back is a real change.
        store.insert(second, source).unwrap();
        assert_eq!(store.active_snapshot().unwrap().id, "bbb");

        let snapshot = store.activate("aaa").unwrap();
        assert_eq!(snapshot.id, "aaa");
        assert_eq!(snapshot.sites.len(), 1);
        assert!(store.activate("missing").is_err(), "unknown id is rejected");

        // Active id is the DB's business: a restart must keep the choice.
        let restarted = store_at(&dir);
        assert_eq!(restarted.active_snapshot().unwrap().id, "aaa");
        assert_eq!(restarted.all_sites().len(), 1);
    }

    #[test]
    fn rename_touches_both_snapshots_without_switching_active() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        let source = ConfigSource {
            kind: "url".into(),
            value: "https://example.com/box.json".into(),
            name: None,
        };
        let mut first = snapshot("aaa", &["site_a"]);
        first.imported_at = "2026-01-01T00:00:00Z".into();
        let mut second = snapshot("bbb", &["site_b"]);
        second.imported_at = "2026-02-01T00:00:00Z".into();
        store.insert(first, source.clone()).unwrap();
        store.insert(second, source).unwrap();

        let meta = store.rename("aaa", "  家里的配置  ").unwrap();
        assert_eq!(meta.name, "家里的配置");
        assert_eq!(store.name_of("aaa").as_deref(), Some("家里的配置"));
        // Renaming the non-active config must not steal the active marker.
        assert_eq!(store.active_snapshot().unwrap().id, "bbb");
        assert!(store.rename("aaa", "   ").is_err(), "empty name is rejected");

        let restarted = store_at(&dir);
        assert_eq!(restarted.name_of("aaa").as_deref(), Some("家里的配置"));
        assert_eq!(restarted.active_snapshot().unwrap().id, "bbb");
        // Both snapshots were rewritten, so the runtime view carries the name.
        let entry = restarted
            .entries
            .read()
            .unwrap()
            .iter()
            .find(|entry| entry.imported.id == "aaa")
            .map(|entry| entry.runtime.as_ref().unwrap().name.clone());
        assert_eq!(entry.as_deref(), Some("家里的配置"));
    }

    #[test]
    fn manual_disable_changes_only_the_runtime_snapshot() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        store
            .insert(
                site_snapshot(vec![json!({
                    "key": "a", "name": "a", "runtime": "cms", "api": "http://x", "enabled": true
                })]),
                text_source(),
            )
            .unwrap();

        let runtime = store.set_site_enabled("a", false).expect("disable site");
        let site = site_by_key(&runtime.sites, "a");
        assert_eq!(site.get("enabled").and_then(Value::as_bool), Some(false));
        assert_eq!(
            site.get("disabledReason").and_then(Value::as_str),
            Some("已在站点体检中手动禁用")
        );

        // imported 原件没被碰过：手动禁用只活在 runtime_json。
        let import = store
            .entries
            .read()
            .unwrap()
            .iter()
            .find(|entry| entry.imported.id == "box")
            .unwrap()
            .imported
            .clone();
        let imp = site_by_key(&import.sites, "a");
        assert_eq!(imp.get("enabled").and_then(Value::as_bool), Some(true));
        assert!(imp.get("disabledReason").is_none());
        // 从原件重新派生的结果里该站仍 enabled=true，证明禁用不在 imported 层。
        let derived = derive_runtime(&import);
        let d = site_by_key(&derived.sites, "a");
        assert_eq!(d.get("enabled").and_then(Value::as_bool), Some(true));
        assert!(d.get("disabledReason").is_none());

        // 未知站点按契约拒绝。
        let err = store.set_site_enabled("missing", false).unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.message, "site missing not found");
    }

    #[test]
    fn manual_disable_survives_restart() {
        let (_guard, dir) = isolate_data_dir();
        {
            let store = store_at(&dir);
            store
                .insert(
                    site_snapshot(vec![json!({
                        "key": "a", "name": "a", "runtime": "cms", "api": "http://x", "enabled": true
                    })]),
                    text_source(),
                )
                .unwrap();
            store.set_site_enabled("a", false).unwrap();
        }

        // 新开的 store 只读持久化的 runtime_json（非空，不重新派生），
        // 所以禁用 + 原因都还在；imported 仍是 enabled=true。
        let restarted = store_at(&dir);
        let snap = restarted.active_snapshot().expect("active snapshot");
        let site = site_by_key(&snap.sites, "a");
        assert_eq!(site.get("enabled").and_then(Value::as_bool), Some(false));
        assert_eq!(
            site.get("disabledReason").and_then(Value::as_str),
            Some("已在站点体检中手动禁用")
        );
        let import = restarted
            .entries
            .read()
            .unwrap()
            .iter()
            .find(|entry| entry.imported.id == "box")
            .unwrap()
            .imported
            .clone();
        assert_eq!(
            site_by_key(&import.sites, "a")
                .get("enabled")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn re_enabling_removes_the_manual_disable_reason() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        store
            .insert(
                site_snapshot(vec![json!({
                    "key": "a", "name": "a", "runtime": "cms", "api": "http://x", "enabled": true
                })]),
                text_source(),
            )
            .unwrap();
        store.set_site_enabled("a", false).unwrap();

        let runtime = store.set_site_enabled("a", true).expect("enable site");
        let site = site_by_key(&runtime.sites, "a");
        assert_eq!(site.get("enabled").and_then(Value::as_bool), Some(true));
        assert!(site.get("disabledReason").is_none());

        // 内存缓存和重启后的磁盘视图都要一致（disabledReason 确实被删掉）。
        let restarted = store_at(&dir);
        let snap = restarted.active_snapshot().expect("active snapshot");
        let site = site_by_key(&snap.sites, "a");
        assert_eq!(site.get("enabled").and_then(Value::as_bool), Some(true));
        assert!(site.get("disabledReason").is_none());
    }

    #[test]
    fn manual_enable_is_rejected_for_blocked_jvm_sources() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        store
            .insert(
                site_snapshot(vec![json!({
                    "key": "jar", "name": "jar", "runtime": "jvm",
                    "api": "http://x/csp.jar", "enabled": true
                })]),
                text_source(),
            )
            .unwrap();

        // derive_runtime 已把 jvm 源禁用；手动启用必须被拒绝，
        // 否则用户会重新把一个跑不通的源放回 fan-out。
        let err = store.set_site_enabled("jar", true).expect_err("jvm enable rejected");
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.message, "该源不受支持，无法启用");

        // 禁用仍然允许。
        let runtime = store.set_site_enabled("jar", false).expect("disable still allowed");
        assert_eq!(
            site_by_key(&runtime.sites, "jar")
                .get("enabled")
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    // ---- 订阅刷新 ----------------------------------------------------------

    #[test]
    fn signature_ignores_name_and_import_time() {
        let mut a = snapshot("box", &["site_a"]);
        let mut b = snapshot("box", &["site_a"]);
        a.name = "我的订阅".into();
        b.name = "别人的订阅".into();
        b.imported_at = "2027-09-09T00:00:00Z".into();
        assert_eq!(content_signature(&a), content_signature(&b));
    }

    #[test]
    fn signature_detects_content_change() {
        let a = snapshot("box", &["site_a", "site_b"]);
        let b = snapshot("box", &["site_a", "site_c"]);
        assert_ne!(content_signature(&a), content_signature(&b));

        // 同一个站点的 api 变了也算内容变化（换域名的常见情形）。
        let mut c = site_snapshot(vec![json!({ "key": "a", "name": "a", "api": "http://old" })]);
        let mut d = site_snapshot(vec![json!({ "key": "a", "name": "a", "api": "http://new" })]);
        c.imported_at = "one".into();
        d.imported_at = "two".into();
        assert_ne!(content_signature(&c), content_signature(&d));
    }

    #[test]
    fn signature_is_key_order_independent() {
        // 同一个站点，json! 字面量里字段顺序不同：签名必须一致，否则每次
        // normalize 输出顺序一抖动，用户就会看到「每天都有更新」。
        let a = site_snapshot(vec![json!({ "key": "a", "name": "a", "api": "http://x", "type": 3 })]);
        let b = site_snapshot(vec![json!({ "type": 3, "api": "http://x", "name": "a", "key": "a" })]);
        assert_eq!(content_signature(&a), content_signature(&b));
    }

    #[test]
    fn refresh_due_respects_interval() {
        let hour = 3_600_000u64;
        // 关闭时永不到期。
        assert!(!refresh_due(0, None, 1_000));
        // 从未检查过 → 立即到期（启动后检查一次订阅）。
        assert!(refresh_due(12, None, 1_000));
        // 12 小时间隔：差 1 分钟不算到期，整 12 小时算。
        assert!(!refresh_due(12, Some(0), 12 * hour - 60_000));
        assert!(refresh_due(12, Some(0), 12 * hour));
    }

    #[test]
    fn manual_disables_survive_rerivation() {
        // runtime 里用户手动禁用了 slow；订阅刷新重新派生后必须仍然禁用，
        // 同时新增的 jvm 源按策略自动禁用、其它源保持可用。
        let old_runtime = site_snapshot(vec![
            json!({ "key": "slow", "name": "slow", "api": "http://x", "enabled": false, "disabledReason": MANUAL_DISABLE_REASON }),
            json!({ "key": "fast", "name": "fast", "api": "http://y", "enabled": true }),
        ]);
        let manual = manual_disabled_keys(&old_runtime);
        assert_eq!(manual, vec!["slow".to_string()]);

        let fresh = site_snapshot(vec![
            json!({ "key": "slow", "name": "slow", "api": "http://x" }),
            json!({ "key": "fast", "name": "fast", "api": "http://y" }),
            json!({ "key": "jar", "name": "jar", "api": "http://z/csp.jar", "runtime": "jvm" }),
        ]);
        let mut next = derive_runtime(&fresh);
        // 派生阶段先按策略禁掉 jvm，但还不知道手动禁用。
        assert_eq!(
            site_by_key(&next.sites, "slow").get("enabled").and_then(Value::as_bool),
            None
        );
        apply_manual_disables(&mut next, &manual);
        assert_eq!(
            site_by_key(&next.sites, "slow").get("enabled").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            site_by_key(&next.sites, "slow")
                .get("disabledReason")
                .and_then(Value::as_str),
            Some(MANUAL_DISABLE_REASON)
        );
        assert_eq!(
            site_by_key(&next.sites, "fast").get("enabled").and_then(Value::as_bool),
            None
        );
        // jvm 仍按导入策略禁用：两种原因不能互相覆盖。
        assert_eq!(
            site_by_key(&next.sites, "jar").get("enabled").and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn refresh_rejects_non_url_sources() {
        let err = ensure_refreshable(&text_source()).expect_err("text cannot refresh");
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert_eq!(err.message, "只有网络地址导入的配置支持自动刷新");
        assert!(ensure_refreshable(&ConfigSource {
            kind: "url".into(),
            value: "https://example.com/box.json".into(),
            name: None,
        })
        .is_ok());
    }

    #[test]
    fn refresh_interval_defaults_to_twelve_hours_and_clamps() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        assert_eq!(store.refresh_interval_hours(), DEFAULT_REFRESH_HOURS);
        assert_eq!(store.set_refresh_interval(0).unwrap().interval_hours, 0);
        assert_eq!(store.refresh_interval_hours(), 0);
        // 超过一周被夹到上限，避免「设了 1000 小时」这种永不到期值。
        assert_eq!(
            store.set_refresh_interval(1000).unwrap().interval_hours,
            MAX_REFRESH_HOURS
        );
    }

    /// 导入预算必须比爬虫的默认预算宽：1.0.2 之前两者都是 15s，导入刚好排在
    /// 一个占满 worker 的爬虫调用后面时，用户只会看到「config.decrypt exceeded
    /// 15000ms」，一点余量都没有。
    #[test]
    fn config_budget_is_wider_than_the_spider_default() {
        assert!(super::import::CONFIG_CALL_TIMEOUT > crate::process::DEFAULT_CALL_TIMEOUT);
    }

    #[test]
    fn due_only_for_active_url_config_that_reached_interval() {
        let (_guard, dir) = isolate_data_dir();
        let store = store_at(&dir);
        let url_source = ConfigSource {
            kind: "url".into(),
            value: "https://example.com/box.json".into(),
            name: None,
        };
        store.insert(snapshot("box", &["a"]), url_source).unwrap();

        // 刚导入即以「已检查」起算，12 小时间隔下不该马上到期。
        store.set_refresh_interval(12).unwrap();
        assert!(store.due_config_id().is_none());

        // 把上次检查挪到 13 小时前 → 到期。
        let now = crate::store::now_ms();
        store
            .write_refresh_state(
                "box",
                &RefreshState {
                    checked_at: now.saturating_sub(13 * 3_600_000),
                    changed_at: None,
                    error: None,
                },
            )
            .unwrap();
        assert_eq!(store.due_config_id().as_deref(), Some("box"));

        // 关闭后不再到期，即使状态是旧的。
        store.set_refresh_interval(0).unwrap();
        assert!(store.due_config_id().is_none());
    }
