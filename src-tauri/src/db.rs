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
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub(crate) const DB_FILE: &str = "luma.db";
const META_ACTIVE: &str = "active_config_id";
const META_MIGRATED: &str = "legacy_migrated";
pub const MAX_HISTORY: usize = 500;

/// A row of `configs`. `runtime_json` is empty for legacy rows that still need
/// a derivation pass in `ConfigStore::load`.
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
        let dir = crate::store::data_dir();
        // One-shot upgrade from the pre-rename data directory. A failed
        // migration must not stop the app from starting with a fresh DB.
        if let Err(err) = crate::migrate::from_tvbox(&dir, &dir.join(DB_FILE), None) {
            tracing::warn!(error = %err, "legacy data migration failed");
        }
        Self::at(dir)
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
        // Legacy JSON files are kept on disk as a backup; importing them is
        // idempotent (INSERT OR IGNORE) and gated by a meta marker.
        if let Err(err) = db.migrate_legacy(&dir) {
            tracing::warn!(error = %err, "legacy json -> sqlite migration incomplete");
        }
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
                     position_ms INTEGER NOT NULL DEFAULT 0,
                     duration_ms INTEGER NOT NULL DEFAULT 0,
                     updated_at  INTEGER NOT NULL,
                     PRIMARY KEY (site_key, vod_id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_favorites_added
                     ON favorites(added_at DESC);
                 CREATE INDEX IF NOT EXISTS idx_history_updated
                     ON history(updated_at DESC);",
            )
        })
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

    /// Persist a runtime derivation for a legacy row (see `ConfigStore::load`).
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

    // ---- history ----------------------------------------------------------

    pub fn history(&self) -> Result<Vec<HistoryRow>, AppError> {
        self.with("load history", |conn| {
            let mut stmt = conn.prepare(
                "SELECT site_key, vod_id, name, pic, remarks, site_name,
                        play_url, position_ms, duration_ms, updated_at
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
                      play_url, position_ms, duration_ms, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(site_key, vod_id) DO UPDATE SET
                     name = excluded.name,
                     pic = excluded.pic,
                     remarks = excluded.remarks,
                     site_name = excluded.site_name,
                     play_url = excluded.play_url,
                     position_ms = excluded.position_ms,
                     duration_ms = excluded.duration_ms,
                     updated_at = excluded.updated_at",
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

    pub fn clear_history(&self) -> Result<(), AppError> {
        self.with("clear history", |conn| {
            conn.execute("DELETE FROM history", [])?;
            Ok(())
        })
    }

    // ---- one-time migration from the old JSON files ------------------------

    fn migrate_legacy(&self, dir: &Path) -> Result<(), AppError> {
        if self.meta_get(META_MIGRATED)?.is_some() {
            return Ok(());
        }
        let legacy = read_legacy(dir);
        self.with("migrate legacy json", |conn| {
            let tx = conn.transaction()?;
            for row in &legacy.configs {
                tx.execute(
                    "INSERT OR IGNORE INTO configs
                         (id, name, imported_at, imported_json, runtime_json, source_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
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
            }
            if tx
                .query_row(
                    "SELECT 1 FROM meta WHERE key = ?1",
                    params![META_ACTIVE],
                    |_| Ok(()),
                )
                .optional()?
                .is_none()
            {
                if let Some(id) = &legacy.active {
                    Self::meta_set(&tx, META_ACTIVE, id)?;
                }
            }
            for row in &legacy.favorites {
                tx.execute(
                    "INSERT OR IGNORE INTO favorites
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
            for row in &legacy.history {
                tx.execute(
                    "INSERT OR IGNORE INTO history
                         (site_key, vod_id, name, pic, remarks, site_name,
                          play_url, position_ms, duration_ms, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
                    ],
                )?;
            }
            Self::meta_set(&tx, META_MIGRATED, "1")?;
            tx.commit()
        })?;
        tracing::info!(
            configs = legacy.configs.len(),
            favourites = legacy.favorites.len(),
            history = legacy.history.len(),
            "legacy json migrated into sqlite"
        );
        Ok(())
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
    })
}

#[derive(Default)]
struct LegacyData {
    configs: Vec<ConfigRow>,
    active: Option<String>,
    favorites: Vec<FavoriteRow>,
    history: Vec<HistoryRow>,
}

fn str_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn num_field(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn read_legacy(dir: &Path) -> LegacyData {
    let mut out = LegacyData::default();

    // `<data>/configs/<id>.json`: {imported|snapshot, runtime?, source}
    if let Ok(entries) = std::fs::read_dir(dir.join("configs")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(doc) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            let Some(imported) = doc
                .get("imported")
                .filter(|v| !v.is_null())
                .or_else(|| doc.get("snapshot"))
                .cloned()
            else {
                continue;
            };
            let id = str_field(&imported, "id");
            if id.is_empty() {
                continue;
            }
            // An empty runtime_json tells ConfigStore::load to derive it, so a
            // policy upgrade re-runs even for configs written before the split.
            let runtime_json = doc
                .get("runtime")
                .filter(|v| !v.is_null())
                .and_then(|v| serde_json::to_string(v).ok())
                .unwrap_or_default();
            let source_json = doc
                .get("source")
                .filter(|v| !v.is_null())
                .and_then(|v| serde_json::to_string(v).ok())
                .unwrap_or_else(|| json!({"kind": "text", "value": ""}).to_string());
            out.configs.push(ConfigRow {
                id,
                name: str_field(&imported, "name"),
                imported_at: str_field(&imported, "importedAt"),
                imported_json: serde_json::to_string(&imported).unwrap_or_default(),
                runtime_json,
                source_json,
            });
        }
    }

    // `<data>/active.json` is a bare id string.
    out.active = std::fs::read_to_string(dir.join("active.json"))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|id| !id.is_empty());

    if let Some(items) = read_json_array(&dir.join("favorites.json")) {
        for item in items {
            let site_key = str_field(&item, "siteKey");
            let vod_id = str_field(&item, "vodId");
            if site_key.is_empty() || vod_id.is_empty() {
                continue;
            }
            out.favorites.push(FavoriteRow {
                site_key,
                vod_id,
                name: str_field(&item, "name"),
                pic: str_field(&item, "pic"),
                remarks: str_field(&item, "remarks"),
                site_name: str_field(&item, "siteName"),
                added_at: num_field(&item, "addedAt"),
            });
        }
    }
    if let Some(items) = read_json_array(&dir.join("history.json")) {
        for item in items {
            let site_key = str_field(&item, "siteKey");
            let vod_id = str_field(&item, "vodId");
            if site_key.is_empty() || vod_id.is_empty() {
                continue;
            }
            out.history.push(HistoryRow {
                site_key,
                vod_id,
                name: str_field(&item, "name"),
                pic: str_field(&item, "pic"),
                remarks: str_field(&item, "remarks"),
                site_name: str_field(&item, "siteName"),
                play_url: str_field(&item, "playUrl"),
                position_ms: num_field(&item, "positionMs"),
                duration_ms: num_field(&item, "durationMs"),
                updated_at: num_field(&item, "updatedAt"),
            });
        }
    }
    out
}

fn read_json_array(path: &Path) -> Option<Vec<Value>> {
    let text = std::fs::read_to_string(path).ok()?;
    let doc: Value = serde_json::from_str(&text).ok()?;
    doc.get("items")?.as_array().cloned()
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
            position_ms: 999,
            duration_ms: 1000,
            updated_at: 9999,
        })
        .unwrap();
        assert_eq!(db.history().unwrap().len(), MAX_HISTORY);
        db.clear_history().unwrap();
        assert!(db.history().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_json_is_imported_once_and_never_overwrites_new_rows() {
        let dir = temp_dir("migration");
        let configs = dir.join("configs");
        std::fs::create_dir_all(&configs).unwrap();
        // Written before the imported/runtime split: only `snapshot`.
        std::fs::write(
            configs.join("legacy.json"),
            serde_json::to_string(&json!({
                "snapshot": {
                    "id": "legacy", "name": "legacy", "importedAt": "2026-11-10T00:00:00Z",
                    "sites": [{"key": "py", "runtime": "python", "enabled": true}]
                },
                "source": {"kind": "text", "value": ""}
            }))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(dir.join("active.json"), "legacy").unwrap();
        std::fs::write(
            dir.join("favorites.json"),
            serde_json::to_string(&json!({"items": [{
                "siteKey": "cms", "vodId": "7", "name": "Saved", "addedAt": 42
            }]}))
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            dir.join("history.json"),
            serde_json::to_string(&json!({"items": [{
                "siteKey": "cms", "vodId": "7", "name": "Saved",
                "positionMs": 1234, "durationMs": 60000, "updatedAt": 99
            }]}))
            .unwrap(),
        )
        .unwrap();

        let db = Db::at(dir.clone()).expect("open db");
        let rows = db.config_rows().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "legacy");
        assert_eq!(rows[0].runtime_json, "", "legacy rows need a derivation");
        assert_eq!(db.active_config_id().unwrap().as_deref(), Some("legacy"));
        assert_eq!(db.favorites().unwrap().len(), 1);
        assert_eq!(db.history().unwrap()[0].position_ms, 1234);

        // Reopen: the marker must prevent duplicates, and a newer row written
        // after migration must survive even though the old files are still there.
        db.activate_config(ConfigWrite {
            id: "legacy",
            name: "updated",
            imported_at: "2026-11-11T00:00:00Z",
            imported_json: "{}",
            runtime_json: "derived",
            source_json: "{}",
        })
        .unwrap();
        let reopened = Db::at(dir.clone()).expect("reopen db");
        assert_eq!(reopened.config_rows().unwrap().len(), 1);
        assert_eq!(reopened.config_rows().unwrap()[0].name, "updated");
        assert_eq!(reopened.favorites().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
