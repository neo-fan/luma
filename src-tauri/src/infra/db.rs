//! SQLite persistence layer.
//!
//! One database (`<data dir>/luma.db`) is the single source of truth for
//! configs, the active-config marker, favourites and playback history. Rust
//! still keeps in-memory read caches (parsing a 100-site snapshot on every
//! keystroke would be wasteful), but every write goes through a transaction
//! here first; a failed write never leaves the cache diverged from disk.
//!
//! Config snapshots are stored as JSON documents because they are deeply
//! nested TVBox dialect objects whose shape is owned by the Python normalizer.
//! Favourites/history use real columns so UPSERT, indexes and the 500-row cap
//! are handled by SQLite instead of ad-hoc Vec rewriting.

use crate::error::{code, AppError};
use crate::store::now_ms;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) const DB_FILE: &str = "luma.db";
const META_ACTIVE: &str = "active_config_id";
pub const MAX_HISTORY: usize = 500;

/// A row of `configs`. `runtime_json` is written on every import; an empty
/// value still triggers a derivation pass in `ConfigStore::load` so a policy
/// change can be replayed from the untouched `imported_json`.
#[derive(Debug, Clone)]
pub struct ConfigRow {
    pub id: String,
    pub name: String,
    pub imported_at: String,
    pub imported_json: String,
    pub runtime_json: String,
    pub source_json: String,
}

/// Borrowed view used when writing a config row (avoids cloning the JSON text).
#[derive(Debug, Clone, Copy)]
pub struct ConfigWrite<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub imported_at: &'a str,
    pub imported_json: &'a str,
    pub runtime_json: &'a str,
    pub source_json: &'a str,
}

#[derive(Debug, Clone)]
pub struct FavoriteRow {
    pub site_key: String,
    pub vod_id: String,
    pub name: String,
    pub pic: String,
    pub remarks: String,
    pub site_name: String,
    pub added_at: u64,
}

#[derive(Debug, Clone)]
pub struct HistoryRow {
    pub site_key: String,
    pub vod_id: String,
    pub name: String,
    pub pic: String,
    pub remarks: String,
    pub site_name: String,
    pub play_url: String,
    /// 最近观看的集数名（源自己给的剧集标题）。
    pub episode_name: String,
    /// 线路名，即 TVBox `vod_play_from` 里的一段。
    pub play_from: String,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub updated_at: u64,
}

/// One connection guarded by a mutex. `rusqlite::Connection` is `Send` but not
/// `Sync`, so the mutex is what makes `Db` shareable as Tauri state.
pub struct Db {
    path: PathBuf,
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open() -> Result<Self, AppError> {
        // Luma has never shipped a previous release, so there is no legacy
        // data directory or JSON store to import. SQLite is created fresh.
        Self::at(crate::store::data_dir())
    }

    /// Open (or create) the database rooted at `dir`; used by tests to stay
    /// isolated via `LUMA_DATA_DIR` without touching the user's real data.
    pub fn at(dir: PathBuf) -> Result<Self, AppError> {
        std::fs::create_dir_all(&dir).map_err(|err| {
            AppError::new(code::INTERNAL, "create data dir failed").with_cause(err.to_string())
        })?;
        let path = dir.join(DB_FILE);
        let conn = Connection::open(&path).map_err(|err| {
            AppError::new(code::INTERNAL, "open sqlite database failed").with_cause(err.to_string())
        })?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             PRAGMA foreign_keys=ON;",
        )
        .map_err(|err| {
            AppError::new(code::INTERNAL, "configure sqlite failed").with_cause(err.to_string())
        })?;
        let db = Self {
            path,
            conn: Mutex::new(conn),
        };
        db.create_schema()?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn with<T>(
        &self,
        context: &str,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, AppError> {
        let mut conn = self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut conn).map_err(|err| {
            AppError::new(code::INTERNAL, format!("sqlite {context} failed"))
                .with_cause(err.to_string())
        })
    }

    fn create_schema(&self) -> Result<(), AppError> {
        self.with("create schema", |conn| {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS meta (
                     key   TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS configs (
                     id            TEXT PRIMARY KEY,
                     name          TEXT NOT NULL,
                     imported_at   TEXT NOT NULL,
                     imported_json TEXT NOT NULL,
                     runtime_json  TEXT NOT NULL DEFAULT '',
                     source_json   TEXT NOT NULL,
                     updated_at    INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS favorites (
                     site_key  TEXT NOT NULL,
                     vod_id    TEXT NOT NULL,
                     name      TEXT NOT NULL,
                     pic       TEXT NOT NULL DEFAULT '',
                     remarks   TEXT NOT NULL DEFAULT '',
                     site_name TEXT NOT NULL DEFAULT '',
                     added_at  INTEGER NOT NULL,
                     PRIMARY KEY (site_key, vod_id)
                 );
                 CREATE TABLE IF NOT EXISTS history (
                     site_key    TEXT NOT NULL,
                     vod_id      TEXT NOT NULL,
                     name        TEXT NOT NULL,
                     pic         TEXT NOT NULL DEFAULT '',
                     remarks     TEXT NOT NULL DEFAULT '',
                     site_name   TEXT NOT NULL DEFAULT '',
                     play_url    TEXT NOT NULL DEFAULT '',
                     episode_name TEXT NOT NULL DEFAULT '',
                     play_from   TEXT NOT NULL DEFAULT '',
                     position_ms INTEGER NOT NULL DEFAULT 0,
                     duration_ms INTEGER NOT NULL DEFAULT 0,
                     updated_at  INTEGER NOT NULL,
                     PRIMARY KEY (site_key, vod_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_favorites_added
                     ON favorites(added_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_history_updated
                     ON history(updated_at DESC);",
            )?;
            // `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a
            // database created before episode/line tracking keeps its 10-column
            // `history` until the columns are added explicitly.
            Self::ensure_history_columns(conn)
        })
    }

    /// Additive, idempotent migration for `history`.
    fn ensure_history_columns(conn: &Connection) -> rusqlite::Result<()> {
        let existing: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(history)")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for column in ["episode_name", "play_from"] {
            if !existing.iter().any(|name| name == column) {
                conn.execute(
                    &format!("ALTER TABLE history ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"),
                    [],
                )?;
            }
        }
        Ok(())
    }

    // ---- meta -------------------------------------------------------------

    fn meta_get(&self, key: &str) -> Result<Option<String>, AppError> {
        self.with("read meta", |conn| {
            conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| {
                row.get::<_, String>(0)
            })
            .optional()
        })
    }

    fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    fn meta_delete(conn: &Connection, key: &str) -> rusqlite::Result<()> {
        conn.execute("DELETE FROM meta WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// 通用 meta 读：订阅刷新把「上次检查/上次变化/错误」存在 meta 里，
    /// 而不是给 `configs` 加列——这三项是运行时状态，不是配置本体，也不
    /// 参与 imported/runtime 双快照语义。
    pub fn meta_read(&self, key: &str) -> Result<Option<String>, AppError> {
        self.meta_get(key)
    }

    pub fn meta_write(&self, key: &str, value: &str) -> Result<(), AppError> {
        self.with("write meta", |conn| Self::meta_set(conn, key, value))
    }

    pub fn meta_remove(&self, key: &str) -> Result<(), AppError> {
        self.with("remove meta", |conn| Self::meta_delete(conn, key))
    }

    /// 按键前缀批量读取（`refresh_state:` 一次取全部配置的刷新状态，
    /// 避免配置列表逐行查库）。
    pub fn meta_scan(&self, prefix: &str) -> Result<Vec<(String, String)>, AppError> {
        self.with("scan meta", |conn| {
            let mut stmt = conn.prepare("SELECT key, value FROM meta WHERE key LIKE ?1")?;
            let rows = stmt.query_map(params![format!("{prefix}%")], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    pub fn active_config_id(&self) -> Result<Option<String>, AppError> {
        self.meta_get(META_ACTIVE)
    }

    pub fn set_active_config_id(&self, id: Option<&str>) -> Result<(), AppError> {
        self.with("set active config", |conn| match id {
            Some(id) => Self::meta_set(conn, META_ACTIVE, id),
            None => Self::meta_delete(conn, META_ACTIVE),
        })
    }

    // ---- configs ----------------------------------------------------------

    pub fn config_rows(&self) -> Result<Vec<ConfigRow>, AppError> {
        self.with("load configs", |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, imported_at, imported_json, runtime_json, source_json
                 FROM configs ORDER BY updated_at ASC, rowid ASC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(ConfigRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    imported_at: row.get(2)?,
                    imported_json: row.get(3)?,
                    runtime_json: row.get(4)?,
                    source_json: row.get(5)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    fn upsert_config(conn: &Connection, row: ConfigWrite<'_>) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO configs
                 (id, name, imported_at, imported_json, runtime_json, source_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name,
                 imported_at = excluded.imported_at,
                 imported_json = excluded.imported_json,
                 runtime_json = excluded.runtime_json,
                 source_json = excluded.source_json,
                 updated_at = excluded.updated_at",
            params![
                row.id,
                row.name,
                row.imported_at,
                row.imported_json,
                row.runtime_json,
                row.source_json,
                now_ms() as i64,
            ],
        )?;
        Ok(())
    }

    /// Rewrite one config row **without** touching the active marker.
    ///
    /// Used by rename: the row's `imported`/`runtime` JSON both carry the name,
    /// so the caller re-serialises them, but renaming must never switch which
    /// config is live.
    pub fn update_config(&self, row: ConfigWrite<'_>) -> Result<(), AppError> {
        self.with("update config", |conn| {
            let tx = conn.transaction()?;
            Self::upsert_config(&tx, row)?;
            tx.commit()
        })
    }

    /// Write a config AND switch the active id in one transaction. Previously
    /// these were two separate files, so a crash between them could leave the
    /// active marker pointing at a config that was never there.
    pub fn activate_config(&self, row: ConfigWrite<'_>) -> Result<(), AppError> {
        self.with("activate config", |conn| {
            let tx = conn.transaction()?;
            Self::upsert_config(&tx, row)?;
            Self::meta_set(&tx, META_ACTIVE, row.id)?;
            tx.commit()
        })
    }

    /// Remove a config; when it was active, atomically pick the newest
    /// remaining one. Returns the id that should become active (if any).
    pub fn delete_config(&self, id: &str) -> Result<Option<String>, AppError> {
        self.with("delete config", |conn| {
            let tx = conn.transaction()?;
            tx.execute("DELETE FROM configs WHERE id = ?1", params![id])?;
            let was_active = tx
                .query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    params![META_ACTIVE],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .as_deref()
                == Some(id);
            let next = if was_active {
                let candidate = tx
                    .query_row(
                        "SELECT id FROM configs ORDER BY imported_at DESC, updated_at DESC LIMIT 1",
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                match &candidate {
                    Some(next_id) => Self::meta_set(&tx, META_ACTIVE, next_id)?,
                    None => Self::meta_delete(&tx, META_ACTIVE)?,
                }
                candidate
            } else {
                None
            };
            tx.commit()?;
            Ok(next)
        })
    }

    /// Persist a runtime derivation (see `ConfigStore::load`).
    pub fn set_runtime_json(&self, id: &str, runtime_json: &str) -> Result<(), AppError> {
        self.with("save runtime snapshot", |conn| {
            conn.execute(
                "UPDATE configs SET runtime_json = ?2 WHERE id = ?1",
                params![id, runtime_json],
            )?;
            Ok(())
        })
    }

    // ---- favourites -------------------------------------------------------

    pub fn favorites(&self) -> Result<Vec<FavoriteRow>, AppError> {
        self.with("load favourites", |conn| {
            let mut stmt = conn.prepare(
                "SELECT site_key, vod_id, name, pic, remarks, site_name, added_at
                 FROM favorites",
            )?;
            let rows = stmt.query_map([], favorite_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    /// Returns `true` when the row ended up favourited. The existence check and
    /// the mutation share one transaction, so two rapid toggles cannot both see
    /// the same old state.
    pub fn toggle_favorite(&self, row: &FavoriteRow) -> Result<bool, AppError> {
        self.with("toggle favourite", |conn| {
            let tx = conn.transaction()?;
            let exists = tx
                .query_row(
                    "SELECT 1 FROM favorites WHERE site_key = ?1 AND vod_id = ?2",
                    params![row.site_key, row.vod_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            if exists {
                tx.execute(
                    "DELETE FROM favorites WHERE site_key = ?1 AND vod_id = ?2",
                    params![row.site_key, row.vod_id],
                )?;
            } else {
                tx.execute(
                    "INSERT INTO favorites
                         (site_key, vod_id, name, pic, remarks, site_name, added_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        row.site_key,
                        row.vod_id,
                        row.name,
                        row.pic,
                        row.remarks,
                        row.site_name,
                        row.added_at as i64,
                    ],
                )?;
            }
            tx.commit()?;
            Ok(!exists)
        })
    }

    /// 只补元数据（封面 / 备注 / 站点名 / 片名），用于列表页回填早先没存
    /// 封面的记录。**空参数不覆盖已有值**，也不碰 `added_at`：收藏顺序不能
    /// 因为一次补封面就整体重排。
    pub fn patch_favorite_meta(
        &self,
        site_key: &str,
        vod_id: &str,
        name: &str,
        pic: &str,
        remarks: &str,
        site_name: &str,
    ) -> Result<bool, AppError> {
        self.with("patch favourite meta", |conn| {
            let changed = conn.execute(
                "UPDATE favorites SET
                     name = CASE WHEN ?3 <> '' THEN ?3 ELSE name END,
                     pic = CASE WHEN ?4 <> '' THEN ?4 ELSE pic END,
                     remarks = CASE WHEN ?5 <> '' THEN ?5 ELSE remarks END,
                     site_name = CASE WHEN ?6 <> '' THEN ?6 ELSE site_name END
                 WHERE site_key = ?1 AND vod_id = ?2",
                params![site_key, vod_id, name, pic, remarks, site_name],
            )?;
            Ok(changed > 0)
        })
    }

    // ---- history ----------------------------------------------------------

    pub fn history(&self) -> Result<Vec<HistoryRow>, AppError> {
        self.with("load history", |conn| {
            let mut stmt = conn.prepare(
                "SELECT site_key, vod_id, name, pic, remarks, site_name,
                        play_url, position_ms, duration_ms, updated_at,
                        episode_name, play_from
                 FROM history",
            )?;
            let rows = stmt.query_map([], history_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })
    }

    pub fn upsert_history(&self, row: &HistoryRow) -> Result<(), AppError> {
        self.with("upsert history", |conn| {
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO history
                     (site_key, vod_id, name, pic, remarks, site_name,
                      play_url, position_ms, duration_ms, updated_at,
                      episode_name, play_from)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(site_key, vod_id) DO UPDATE SET
                     name = excluded.name,
                     -- 详情还没拉到时写入的是空封面；不能用空串覆盖掉库里已有的
                     -- 封面 / 备注 / 站点名，否则一次「先播放后详情」就把列表打回空白。
                     pic = CASE WHEN excluded.pic <> '' THEN excluded.pic ELSE pic END,
                     remarks = CASE WHEN excluded.remarks <> '' THEN excluded.remarks ELSE remarks END,
                     site_name = CASE WHEN excluded.site_name <> '' THEN excluded.site_name ELSE site_name END,
                     play_url = excluded.play_url,
                     position_ms = excluded.position_ms,
                     duration_ms = excluded.duration_ms,
                     updated_at = excluded.updated_at,
                     episode_name = excluded.episode_name,
                     play_from = excluded.play_from",
                params![
                    row.site_key,
                    row.vod_id,
                    row.name,
                    row.pic,
                    row.remarks,
                    row.site_name,
                    row.play_url,
                    row.position_ms as i64,
                    row.duration_ms as i64,
                    row.updated_at as i64,
                    row.episode_name,
                    row.play_from,
                ],
            )?;
            // Keep the newest MAX_HISTORY rows instead of rebuilding a Vec.
            tx.execute(
                "DELETE FROM history WHERE rowid NOT IN
                     (SELECT rowid FROM history ORDER BY updated_at DESC LIMIT ?1)",
                params![MAX_HISTORY as i64],
            )?;
            tx.commit()
        })
    }

    /// 历史记录补元数据（封面 / 备注 / 站点名 / 片名）。与收藏同理：空参数
    /// 不覆盖，**`updated_at` 保持不变**——回填封面不能把老记录顶到列表最前。
    pub fn patch_history_meta(
        &self,
        site_key: &str,
        vod_id: &str,
        name: &str,
        pic: &str,
        remarks: &str,
        site_name: &str,
    ) -> Result<bool, AppError> {
        self.with("patch history meta", |conn| {
            let changed = conn.execute(
                "UPDATE history SET
                     name = CASE WHEN ?3 <> '' THEN ?3 ELSE name END,
                     pic = CASE WHEN ?4 <> '' THEN ?4 ELSE pic END,
                     remarks = CASE WHEN ?5 <> '' THEN ?5 ELSE remarks END,
                     site_name = CASE WHEN ?6 <> '' THEN ?6 ELSE site_name END
                 WHERE site_key = ?1 AND vod_id = ?2",
                params![site_key, vod_id, name, pic, remarks, site_name],
            )?;
            Ok(changed > 0)
        })
    }

    pub fn clear_history(&self) -> Result<(), AppError> {
        self.with("clear history", |conn| {
            conn.execute("DELETE FROM history", [])?;
            Ok(())
        })
    }

    /// 删除单条历史（历史页的「删除」按钮）。
    pub fn remove_history(&self, site_key: &str, vod_id: &str) -> Result<(), AppError> {
        self.with("remove history", |conn| {
            conn.execute(
                "DELETE FROM history WHERE site_key = ?1 AND vod_id = ?2",
                params![site_key, vod_id],
            )?;
            Ok(())
        })
    }

}

fn favorite_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FavoriteRow> {
    Ok(FavoriteRow {
        site_key: row.get(0)?,
        vod_id: row.get(1)?,
        name: row.get(2)?,
        pic: row.get(3)?,
        remarks: row.get(4)?,
        site_name: row.get(5)?,
        added_at: row.get::<_, i64>(6)? as u64,
    })
}

fn history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryRow> {
    Ok(HistoryRow {
        site_key: row.get(0)?,
        vod_id: row.get(1)?,
        name: row.get(2)?,
        pic: row.get(3)?,
        remarks: row.get(4)?,
        site_name: row.get(5)?,
        play_url: row.get(6)?,
        position_ms: row.get::<_, i64>(7)? as u64,
        duration_ms: row.get::<_, i64>(8)? as u64,
        updated_at: row.get::<_, i64>(9)? as u64,
        episode_name: row.get(10)?,
        play_from: row.get(11)?,
    })
}

#[cfg(test)]
mod tests {
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
                name: "Sample".into(),
                pic: String::new(),
                remarks: String::new(),
                site_name: "CMS".into(),
                play_url: String::new(),
                episode_name: format!("第 {index} 集"),
                play_from: "线路A".into(),
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
            name: "Sample".into(),
            pic: String::new(),
            remarks: String::new(),
            site_name: "CMS".into(),
            play_url: String::new(),
            episode_name: "第 5 集".into(),
            play_from: "线路B".into(),
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

    /// 回填封面：补到该补的行、空值不覆盖、而且绝不能改变历史顺序或收藏顺序。
    #[test]
    fn meta_patch_fills_cover_without_reordering() {
        let dir = temp_dir("meta");
        let db = Db::at(dir.clone()).expect("open db");
        let history = |id: &str, pic: &str, updated_at: u64| HistoryRow {
            site_key: "cms".into(),
            vod_id: id.into(),
            name: "Sample".into(),
            pic: pic.into(),
            remarks: String::new(),
            site_name: "CMS".into(),
            play_url: String::new(),
            episode_name: String::new(),
            play_from: String::new(),
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

    /// 老版本库只有 10 列：打开时必须补齐集数/线路列，且旧行照常可读。
    #[test]
    fn legacy_history_table_gains_episode_and_line_columns() {
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
        drop(db);
        // 第二次打开：列已存在，ALTER 不能重复执行。
        assert!(Db::at(dir.clone()).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
