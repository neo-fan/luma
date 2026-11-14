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
    /// 播放时解码出来的画面尺寸标签（`1080P` / `2K` / `4K`）。
    ///
    /// 站点不提供分辨率字段，只有真正播出画面才知道；写入时是空的（还没解码）
    /// 就不覆盖库里已有值。
    pub resolution: String,
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
}

// ---- 子模块 ---------------------------------------------------------------
// `Db` 是唯一入口；schema / meta / configs / favourites / history 各占一个
// `impl Db` 文件，行结构体留在本文件，避免子模块互相 import。
mod configs;
mod favorites;
mod history;
mod meta;
mod schema;

#[cfg(test)]
mod tests;
