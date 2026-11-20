use super::*;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("luma-db-test-{label}-{}", now_ms()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// 测试用的一行播放记录；`title_key` 与生产侧 `normalize_title` 同口径
/// （去掉**所有**空白字符 + 小写，含 Tab / 全角空格，不只是 ASCII 空格）。
fn sample_row(name: &str, id: &str) -> PlaybackRow {
    PlaybackRow {
        id: 0,
        title_key: name
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_lowercase(),
        title: name.into(),
        subscription_address: String::new(),
        subscription_id: String::new(),
        site_key: "cms".into(),
        site_name: "CMS".into(),
        vod_id: id.into(),
        line_name: String::new(),
        episode_name: String::new(),
        episode_number: None,
        play_url: String::new(),
        pic: String::new(),
        remarks: String::new(),
        douban_id: String::new(),
        position_ms: 0,
        duration_ms: 0,
        resolution: String::new(),
        rate: 0.0,
        skip_json: String::new(),
        prefs_json: "{}".into(),
        favorite: false,
        favorite_at: None,
        created_at: 1,
        updated_at: 1,
    }
}

#[test]
fn schema_and_config_activation_are_transactional() {
    let dir = temp_dir("config");
    let db = Db::at(dir.clone()).expect("open db");
    assert!(db.path().ends_with(DB_FILE));
    assert_eq!(db.config_rows().unwrap().len(), 0);

    db.activate_config(ConfigWrite {
        id: "box",
        name: "box",
        imported_at: "2026-11-10T00:00:00Z",
        imported_json: r#"{"id":"box"}"#,
        runtime_json: r#"{"id":"box","sites":[]}"#,
        source_json: r#"{"kind":"url","value":"https://example.invalid/box.json"}"#,
    })
    .unwrap();
    assert_eq!(db.active_config_id().unwrap().as_deref(), Some("box"));
    let rows = db.config_rows().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].runtime_json, r#"{"id":"box","sites":[]}"#);

    // Same id re-imports in place (no duplicate rows).
    db.activate_config(ConfigWrite {
        id: "box",
        name: "box2",
        imported_at: "2026-11-10T00:00:00Z",
        imported_json: r#"{"id":"box"}"#,
        runtime_json: "updated",
        source_json: "{}",
    })
    .unwrap();
    assert_eq!(db.config_rows().unwrap().len(), 1);
    assert_eq!(db.config_rows().unwrap()[0].runtime_json, "updated");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn deleting_the_active_config_promotes_the_newest_remaining_one() {
    let dir = temp_dir("delete");
    let db = Db::at(dir.clone()).expect("open db");
    for (id, stamp) in [
        ("old", "2026-01-01T00:00:00Z"),
        ("box", "2026-11-10T00:00:00Z"),
    ] {
        db.activate_config(ConfigWrite {
            id,
            name: id,
            imported_at: stamp,
            imported_json: "{}",
            runtime_json: "{}",
            source_json: "{}",
        })
        .unwrap();
    }
    assert_eq!(db.active_config_id().unwrap().as_deref(), Some("box"));
    let promoted = db.delete_config("box").unwrap();
    assert_eq!(promoted.as_deref(), Some("old"));
    assert_eq!(db.active_config_id().unwrap().as_deref(), Some("old"));
    assert!(db.delete_config("old").unwrap().is_none());
    assert_eq!(db.active_config_id().unwrap(), None);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 收藏只是播放记录上的 flag：取消收藏不删行，清记录保留收藏。
#[test]
fn favorite_is_a_flag_on_the_playback_row() {
    let dir = temp_dir("pb-fav");
    let db = Db::at(dir.clone()).expect("open db");
    let mut seed = sample_row("Sample", "1");
    seed.favorite = true;

    assert!(db.toggle_playback_favorite(&seed).unwrap());
    assert_eq!(db.favorite_playback().unwrap().len(), 1);
    assert_eq!(db.playback().unwrap().len(), 1);

    // 取消收藏：只改 flag，行还在。
    assert!(!db.toggle_playback_favorite(&seed).unwrap());
    assert!(db.favorite_playback().unwrap().is_empty());
    assert_eq!(db.playback().unwrap().len(), 1, "取消收藏不能删行");

    // 再收藏 → 清播放记录 → 收藏行连进度一起保留。
    assert!(db.toggle_playback_favorite(&seed).unwrap());
    db.clear_playback().unwrap();
    let rows = db.playback().unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].favorite);

    // 取消后再清，才会真的删掉。
    assert!(!db.toggle_playback_favorite(&seed).unwrap());
    db.clear_playback().unwrap();
    assert!(db.playback().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// 同名不同源只留一行；空值不覆盖已有封面。
#[test]
fn playback_upsert_dedupes_by_title_and_inherits_meta() {
    let dir = temp_dir("pb-title");
    let db = Db::at(dir.clone()).expect("open db");

    let mut a = sample_row("庆余年", "11");
    a.site_key = "cms_a".into();
    a.pic = "http://a/p.jpg".into();
    a.updated_at = 100;
    db.upsert_playback(&a).unwrap();

    let mut b = sample_row("庆余年", "22");
    b.site_key = "cms_b".into();
    b.episode_name = "第 2 集".into();
    b.position_ms = 2000;
    b.updated_at = 200;
    db.upsert_playback(&b).unwrap();

    let rows = db.playback().unwrap();
    assert_eq!(rows.len(), 1, "同名换源只留一行");
    assert_eq!(rows[0].site_key, "cms_b");
    assert_eq!(rows[0].episode_name, "第 2 集");
    assert_eq!(rows[0].pic, "http://a/p.jpg", "空封面不能覆盖已有封面");

    // 不同名各留一条。
    let mut c = sample_row("庆余年 第二季", "33");
    c.site_key = "cms_a".into();
    c.updated_at = 300;
    db.upsert_playback(&c).unwrap();
    assert_eq!(db.playback().unwrap().len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 分辨率空值（切集瞬间还没解码）不能抹掉已有值。
#[test]
fn resolution_survives_empty_upsert() {
    let dir = temp_dir("resolution");
    let db = Db::at(dir.clone()).expect("open db");

    let mut row = sample_row("Sample", "1");
    row.resolution = "1080P".into();
    row.position_ms = 100;
    row.updated_at = 100;
    db.upsert_playback(&row).unwrap();

    row.resolution = String::new();
    row.position_ms = 200;
    row.updated_at = 200;
    db.upsert_playback(&row).unwrap();

    let hit = &db.playback().unwrap()[0];
    assert_eq!(hit.resolution, "1080P");
    assert_eq!(hit.position_ms, 200);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 倍速 / 片头片尾跨源继承：空值=这次没带，`[]`=显式清空。
#[test]
fn rate_and_skip_survive_cross_source_writes() {
    let dir = temp_dir("rate-skip");
    let db = Db::at(dir.clone()).expect("open db");

    let mut a = sample_row("庆余年", "11");
    a.site_key = "cms_a".into();
    a.rate = 1.5;
    a.skip_json = "[{\"type\":\"opening\",\"start\":0,\"end\":90}]".into();
    a.updated_at = 100;
    db.upsert_playback(&a).unwrap();

    // 换源：这次既没带倍速也没带片段，应从旧行继承。
    let mut b = sample_row("庆余年", "22");
    b.site_key = "cms_b".into();
    b.updated_at = 200;
    db.upsert_playback(&b).unwrap();
    let hit = &db.playback().unwrap()[0];
    assert_eq!(hit.site_key, "cms_b");
    assert_eq!(hit.rate, 1.5);
    assert_eq!(
        hit.skip_json,
        "[{\"type\":\"opening\",\"start\":0,\"end\":90}]"
    );

    // 显式清空片段。
    let mut c = sample_row("庆余年", "22");
    c.site_key = "cms_b".into();
    c.skip_json = "[]".into();
    c.updated_at = 300;
    db.upsert_playback(&c).unwrap();
    assert_eq!(db.playback().unwrap()[0].skip_json, "[]");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 容量裁剪只裁非收藏，收藏永不因 500 条上限被删。
#[test]
fn capacity_trims_only_non_favorites() {
    let dir = temp_dir("cap");
    let db = Db::at(dir.clone()).expect("open db");

    let mut fav = sample_row("收藏的剧", "fav");
    fav.favorite = true;
    fav.favorite_at = Some(1);
    db.toggle_playback_favorite(&fav).unwrap();

    for index in 0..(MAX_HISTORY + 5) {
        let id = format!("v{index}");
        let mut row = sample_row(&format!("Sample {index}"), &id);
        row.updated_at = index as u64 + 10;
        db.upsert_playback(&row).unwrap();
    }

    let rows = db.playback().unwrap();
    assert_eq!(rows.len(), MAX_HISTORY + 1, "500 非收藏 + 1 收藏");
    assert!(rows.iter().any(|row| row.favorite && row.title_key == "收藏的剧"));
    assert_eq!(db.favorite_playback().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

/// 回填封面命中一行、空值不覆盖、且不动 `updated_at`（列表顺序不变）。
#[test]
fn patch_meta_fills_cover_without_reordering() {
    let dir = temp_dir("meta");
    let db = Db::at(dir.clone()).expect("open db");

    let mut one = sample_row("Sample 1", "1");
    one.updated_at = 100;
    db.upsert_playback(&one).unwrap();

    assert!(db
        .patch_playback_meta("sample1", "", "http://new/1.jpg", "HD", "CMS", "")
        .unwrap());
    let hit = &db.playback().unwrap()[0];
    assert_eq!(hit.pic, "http://new/1.jpg");
    assert_eq!(hit.remarks, "HD");
    assert_eq!(hit.updated_at, 100, "回填封面不能改更新时间");

    // 空参数不覆盖；不存在的 key 返回 false。
    assert!(db
        .patch_playback_meta("sample1", "", "", "", "", "")
        .unwrap());
    assert_eq!(db.playback().unwrap()[0].pic, "http://new/1.jpg");
    assert!(!db
        .patch_playback_meta("missing", "", "http://x/y.jpg", "", "", "")
        .unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}
