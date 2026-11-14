use super::*;

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("luma-db-test-{label}-{}", now_ms()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
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
    for (id, stamp) in [("old", "2026-01-01T00:00:00Z"), ("box", "2026-11-10T00:00:00Z")] {
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

#[test]
fn favourites_and_history_use_primary_keys_and_cap() {
    let dir = temp_dir("library");
    let db = Db::at(dir.clone()).expect("open db");
    let fav = FavoriteRow {
        site_key: "cms".into(),
        vod_id: "1".into(),
        name: "Sample".into(),
        pic: String::new(),
        remarks: String::new(),
        site_name: "CMS".into(),
        added_at: 1,
    };
    assert!(db.toggle_favorite(&fav).unwrap());
    assert_eq!(db.favorites().unwrap().len(), 1);
    assert!(!db.toggle_favorite(&fav).unwrap());
    assert!(db.favorites().unwrap().is_empty());

    for index in 0..(MAX_HISTORY + 5) {
        db.upsert_history(&HistoryRow {
            site_key: "cms".into(),
            vod_id: index.to_string(),
            // 每条是不同剧：历史按剧名去重，同名样本会被合并成一条，
            // 那样就测不出 500 条上限了。
            name: format!("Sample {index}"),
            pic: String::new(),
            remarks: String::new(),
            site_name: "CMS".into(),
            play_url: String::new(),
            episode_name: format!("第 {index} 集"),
            play_from: "线路A".into(),
            resolution: String::new(),
            position_ms: 100,
            duration_ms: 1000,
            updated_at: index as u64,
        })
        .unwrap();
    }
    assert_eq!(db.history().unwrap().len(), MAX_HISTORY);
    // UPSERT must update in place, not create a second row.
    db.upsert_history(&HistoryRow {
        site_key: "cms".into(),
        vod_id: "0".into(),
        name: "Sample 0".into(),
        pic: String::new(),
        remarks: String::new(),
        site_name: "CMS".into(),
        play_url: String::new(),
        episode_name: "第 5 集".into(),
        play_from: "线路B".into(),
        resolution: String::new(),
        position_ms: 999,
        duration_ms: 1000,
        updated_at: 9999,
    })
    .unwrap();
    assert_eq!(db.history().unwrap().len(), MAX_HISTORY);
    // 集数与线路名随 UPSERT 一起更新，历史页才能显示「看到第几集」。
    let top = db
        .history()
        .unwrap()
        .into_iter()
        .find(|row| row.vod_id == "0")
        .expect("row 0 survives the cap");
    assert_eq!(top.episode_name, "第 5 集");
    assert_eq!(top.play_from, "线路B");
    db.clear_history().unwrap();
    assert!(db.history().unwrap().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

/// 一部剧只留一条历史：换源（site_key / vod_id 都变）时按剧名完全匹配合并，
/// 且保留封面 / 进度等元数据，续播才能跨源接上。
#[test]
fn history_dedupes_by_exact_title_across_sources() {
    let dir = temp_dir("history-title");
    let db = Db::at(dir.clone()).expect("open db");
    let row = |site: &str, id: &str, name: &str, pic: &str, episode: &str, pos: u64| {
        HistoryRow {
            site_key: site.into(),
            vod_id: id.into(),
            name: name.into(),
            pic: pic.into(),
            remarks: String::new(),
            site_name: "CMS".into(),
            play_url: format!("http://x/{id}"),
            episode_name: episode.into(),
            play_from: "线路A".into(),
            resolution: String::new(),
            position_ms: pos,
            duration_ms: 60000,
            updated_at: pos,
        }
    };

    db.upsert_history(&row("cms_a", "11", "庆余年", "http://a/p.jpg", "第 1 集", 1000))
        .unwrap();
    // 同名、不同站点不同 id：换源后只应保留这一条。
    db.upsert_history(&row("cms_b", "22", "庆余年", "", "第 2 集", 2000))
        .unwrap();
    // 剧名不完全相同的不能被合并。
    db.upsert_history(&row("cms_a", "33", "庆余年 第二季", "", "第 1 集", 3000))
        .unwrap();

    let rows = db.history().unwrap();
    assert_eq!(rows.len(), 2, "同名合并、不同名各留一条");
    let hit = rows.iter().find(|r| r.name == "庆余年").unwrap();
    assert_eq!(hit.site_key, "cms_b");
    assert_eq!(hit.vod_id, "22");
    assert_eq!(hit.episode_name, "第 2 集");
    assert_eq!(hit.position_ms, 2000);
    // 换源这条没有封面，旧封面要继承下来（空值不覆盖语义）。
    assert_eq!(hit.pic, "http://a/p.jpg");

    // 重开库仍只有这两条（去重落在 SQLite，不是内存里做的）。
    assert_eq!(
        Db::at(dir.clone())
            .expect("reopen db")
            .history()
            .unwrap()
            .len(),
        2
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// 分辨率只有真出画后才拿得到：后续进度写入带空值时不能把已有值抹掉。
#[test]
fn history_resolution_survives_empty_upsert() {
    let dir = temp_dir("resolution");
    let db = Db::at(dir.clone()).expect("open db");
    let row = |resolution: &str, position_ms: u64| HistoryRow {
        site_key: "cms".into(),
        vod_id: "1".into(),
        name: "Sample".into(),
        pic: String::new(),
        remarks: String::new(),
        site_name: "CMS".into(),
        play_url: String::new(),
        episode_name: String::new(),
        play_from: String::new(),
        resolution: resolution.into(),
        position_ms,
        duration_ms: 1000,
        updated_at: position_ms,
    };
    db.upsert_history(&row("1080P", 100)).unwrap();
    // 切集瞬间 videoWidth 还是 0，这时写入的是空串 —— 不能退回空白。
    db.upsert_history(&row("", 200)).unwrap();
    let hit = db
        .history()
        .unwrap()
        .into_iter()
        .find(|item| item.vod_id == "1")
        .expect("row exists");
    assert_eq!(hit.resolution, "1080P");
    assert_eq!(hit.position_ms, 200);
    // 换到 4K 线路时正常覆盖。
    db.upsert_history(&row("4K", 300)).unwrap();
    let hit = db
        .history()
        .unwrap()
        .into_iter()
        .find(|item| item.vod_id == "1")
        .expect("row exists");
    assert_eq!(hit.resolution, "4K");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 回填封面：补到该补的行、空值不覆盖、而且绝不能改变历史顺序或收藏顺序。
#[test]
fn meta_patch_fills_cover_without_reordering() {
    let dir = temp_dir("meta");
    let db = Db::at(dir.clone()).expect("open db");
    let history = |id: &str, pic: &str, updated_at: u64| HistoryRow {
        site_key: "cms".into(),
        vod_id: id.into(),
        // 两条必须是不同的剧，否则按剧名去重会只留一条。
        name: format!("Sample {id}"),
        pic: pic.into(),
        remarks: String::new(),
        site_name: "CMS".into(),
        play_url: String::new(),
        episode_name: String::new(),
        play_from: String::new(),
        resolution: String::new(),
        position_ms: 0,
        duration_ms: 0,
        updated_at,
    };
    db.upsert_history(&history("1", "", 100)).unwrap();
    db.upsert_history(&history("2", "http://old/2.jpg", 200)).unwrap();

    // 详情页回填：命中一行，`updated_at` 不变（否则老记录会被顶到最前）。
    assert!(db
        .patch_history_meta("cms", "1", "", "http://new/1.jpg", "HD", "CMS")
        .unwrap());
    let rows = db.history().unwrap();
    let one = rows.iter().find(|row| row.vod_id == "1").unwrap();
    assert_eq!(one.pic, "http://new/1.jpg");
    assert_eq!(one.remarks, "HD");
    assert_eq!(one.updated_at, 100);

    // 空参数不覆盖已有值；不存在的行返回 false。
    assert!(db
        .patch_history_meta("cms", "2", "", "", "", "")
        .unwrap());
    let rows = db.history().unwrap();
    let two = rows.iter().find(|row| row.vod_id == "2").unwrap();
    assert_eq!(two.pic, "http://old/2.jpg");
    assert!(!db
        .patch_history_meta("cms", "missing", "", "http://x/y.jpg", "", "")
        .unwrap());

    // 播放页在详情没到时写的空封面不能把已有封面清掉。
    db.upsert_history(&history("2", "", 300)).unwrap();
    let rows = db.history().unwrap();
    let two = rows.iter().find(|row| row.vod_id == "2").unwrap();
    assert_eq!(two.pic, "http://old/2.jpg");

    let fav = FavoriteRow {
        site_key: "cms".into(),
        vod_id: "1".into(),
        name: "Sample".into(),
        pic: String::new(),
        remarks: String::new(),
        site_name: "CMS".into(),
        added_at: 7,
    };
    assert!(db.toggle_favorite(&fav).unwrap());
    assert!(db
        .patch_favorite_meta("cms", "1", "", "http://new/1.jpg", "", "")
        .unwrap());
    let favorites = db.favorites().unwrap();
    assert_eq!(favorites[0].pic, "http://new/1.jpg");
    assert_eq!(favorites[0].added_at, 7, "backfill must not reorder favourites");
    let _ = std::fs::remove_dir_all(&dir);
}

/// 老版本库只有 10 列：打开时必须补齐集数 / 线路 / 分辨率列，且旧行照常可读。
#[test]
fn legacy_history_table_gains_extra_columns() {
    let dir = temp_dir("migrate");
    std::fs::create_dir_all(&dir).expect("create temp dir");
    {
        let conn = Connection::open(dir.join(DB_FILE)).expect("open legacy db");
        conn.execute_batch(
            "CREATE TABLE history (
                 site_key    TEXT NOT NULL,
                 vod_id      TEXT NOT NULL,
                 name        TEXT NOT NULL,
                 pic         TEXT NOT NULL DEFAULT '',
                 remarks     TEXT NOT NULL DEFAULT '',
                 site_name   TEXT NOT NULL DEFAULT '',
                 play_url    TEXT NOT NULL DEFAULT '',
                 position_ms INTEGER NOT NULL DEFAULT 0,
                 duration_ms INTEGER NOT NULL DEFAULT 0,
                 updated_at  INTEGER NOT NULL,
                 PRIMARY KEY (site_key, vod_id)
             );
             INSERT INTO history VALUES
                 ('cms', '1', 'Old', '', '', 'CMS', 'http://x', 1000, 2000, 5);",
        )
        .expect("create legacy schema");
    }
    let db = Db::at(dir.clone()).expect("open db");
    let rows = db.history().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].position_ms, 1000);
    assert_eq!(rows[0].episode_name, "");
    assert_eq!(rows[0].play_from, "");
    // 新列由迁移补上，老行取默认空串（没播过就没有分辨率）。
    assert_eq!(rows[0].resolution, "");
    drop(db);
    // 第二次打开：列已存在，ALTER 不能重复执行。
    assert!(Db::at(dir.clone()).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}
