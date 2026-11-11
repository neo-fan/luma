//! Favourites and playback history (spec T-12).
//!
//! SQLite (`db.rs`) is the single source of truth. The `Vec` fields are read
//! caches only: every mutation commits a transaction first, then refreshes the
//! cache, so a failed write can never leave the UI showing data that is not on
//! disk. Portable mode (`data/` next to the executable) still wins over
//! `%APPDATA%` — the database simply lives in that directory.

use crate::db::{Db, FavoriteRow, HistoryRow};
use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VodRef {
    pub site_key: String,
    pub vod_id: String,
    pub name: String,
    #[serde(default)]
    pub pic: String,
    #[serde(default)]
    pub remarks: String,
    #[serde(default)]
    pub site_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteItem {
    #[serde(flatten)]
    pub vod: VodRef,
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    #[serde(flatten)]
    pub vod: VodRef,
    #[serde(default)]
    pub play_url: String,
    #[serde(default)]
    pub position_ms: u64,
    #[serde(default)]
    pub duration_ms: u64,
    pub updated_at: u64,
}

pub struct LibraryStore {
    db: Arc<Db>,
    favorites: RwLock<Vec<FavoriteItem>>,
    history: RwLock<Vec<HistoryItem>>,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn data_dir() -> PathBuf {
    // `LUMA_DATA_DIR` is the documented override; `env::get` still accepts
    // the pre-rename `TVBOX_DATA_DIR`.
    if let Some(custom) = crate::env::get("DATA_DIR") {
        return PathBuf::from(custom);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let portable = parent.join("data");
            if portable.is_dir() {
                return portable;
            }
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        if !appdata.trim().is_empty() {
            return PathBuf::from(appdata).join("Luma");
        }
    }
    PathBuf::from("data")
}

fn favorite_from_row(row: FavoriteRow) -> FavoriteItem {
    FavoriteItem {
        vod: VodRef {
            site_key: row.site_key,
            vod_id: row.vod_id,
            name: row.name,
            pic: row.pic,
            remarks: row.remarks,
            site_name: row.site_name,
        },
        added_at: row.added_at,
    }
}

fn history_from_row(row: HistoryRow) -> HistoryItem {
    HistoryItem {
        vod: VodRef {
            site_key: row.site_key,
            vod_id: row.vod_id,
            name: row.name,
            pic: row.pic,
            remarks: row.remarks,
            site_name: row.site_name,
        },
        play_url: row.play_url,
        position_ms: row.position_ms,
        duration_ms: row.duration_ms,
        updated_at: row.updated_at,
    }
}

fn same_vod(a: &VodRef, b: &VodRef) -> bool {
    a.site_key == b.site_key && a.vod_id == b.vod_id
}

impl LibraryStore {
    pub fn load(db: Arc<Db>) -> Result<Self, AppError> {
        let favorites = db
            .favorites()?
            .into_iter()
            .map(favorite_from_row)
            .collect();
        let history = db.history()?.into_iter().map(history_from_row).collect();
        Ok(Self {
            db,
            favorites: RwLock::new(favorites),
            history: RwLock::new(history),
        })
    }

    /// Open the library rooted at `dir`; used by tests to stay isolated.
    pub fn at(dir: PathBuf) -> Self {
        let db = Arc::new(Db::at(dir).expect("open sqlite database"));
        Self::load(db).expect("load library store")
    }

    pub fn list_favorites(&self) -> Vec<FavoriteItem> {
        // Clone under the lock, sort outside it: a long read lock here would
        // needlessly block `toggle_favorite` while the list is sorted.
        let mut items = self
            .favorites
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        items.sort_by(|a, b| b.added_at.cmp(&a.added_at));
        items
    }

    /// Returns `true` when the entry ended up favourited.
    pub fn toggle_favorite(&self, vod: VodRef) -> Result<bool, AppError> {
        let row = FavoriteRow {
            site_key: vod.site_key.clone(),
            vod_id: vod.vod_id.clone(),
            name: vod.name.clone(),
            pic: vod.pic.clone(),
            remarks: vod.remarks.clone(),
            site_name: vod.site_name.clone(),
            added_at: now_ms(),
        };
        // Commit first: the DB owns the state, the Vec mirrors it.
        let added = self.db.toggle_favorite(&row)?;
        let mut guard = self.favorites.write().unwrap_or_else(|p| p.into_inner());
        guard.retain(|item| !same_vod(&item.vod, &vod));
        if added {
            guard.push(FavoriteItem {
                vod,
                added_at: row.added_at,
            });
        }
        Ok(added)
    }

    pub fn is_favorite(&self, site_key: &str, vod_id: &str) -> bool {
        let guard = self.favorites.read().unwrap_or_else(|p| p.into_inner());
        guard
            .iter()
            .any(|item| item.vod.site_key == site_key && item.vod.vod_id == vod_id)
    }

    pub fn list_history(&self) -> Vec<HistoryItem> {
        // Same as `list_favorites`: sort the copy outside the read lock.
        let mut items = self
            .history
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        items
    }

    pub fn upsert_history(&self, item: HistoryItem) -> Result<(), AppError> {
        let row = HistoryRow {
            site_key: item.vod.site_key.clone(),
            vod_id: item.vod.vod_id.clone(),
            name: item.vod.name.clone(),
            pic: item.vod.pic.clone(),
            remarks: item.vod.remarks.clone(),
            site_name: item.vod.site_name.clone(),
            play_url: item.play_url.clone(),
            position_ms: item.position_ms,
            duration_ms: item.duration_ms,
            // Always use a fresh timestamp: the caller's value may be stale
            // (e.g. a restored player session), and the cap relies on ordering.
            updated_at: now_ms(),
        };
        self.db.upsert_history(&row)?;
        // Re-read so the 500-row cap in SQLite is exactly what the UI shows.
        let fresh: Vec<HistoryItem> = self
            .db
            .history()?
            .into_iter()
            .map(history_from_row)
            .collect();
        *self.history.write().unwrap_or_else(|p| p.into_inner()) = fresh;
        Ok(())
    }

    pub fn clear_history(&self) -> Result<(), AppError> {
        self.db.clear_history()?;
        self.history
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        Ok(())
    }

    /// 删除单条历史；内存缓存同步摘掉，界面无需重新拉全量。
    pub fn remove_history(&self, site_key: &str, vod_id: &str) -> Result<(), AppError> {
        self.db.remove_history(site_key, vod_id)?;
        self.history
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|item| !(item.vod.site_key == site_key && item.vod.vod_id == vod_id));
        Ok(())
    }
}

#[tauri::command]
pub fn favorites_list(state: tauri::State<'_, LibraryStore>) -> Vec<FavoriteItem> {
    state.list_favorites()
}

#[tauri::command]
pub fn favorites_toggle(state: tauri::State<'_, LibraryStore>, vod: VodRef) -> Result<bool, AppError> {
    state.toggle_favorite(vod)
}

#[tauri::command]
pub fn history_list(state: tauri::State<'_, LibraryStore>) -> Vec<HistoryItem> {
    state.list_history()
}

#[tauri::command]
pub fn history_upsert(state: tauri::State<'_, LibraryStore>, item: HistoryItem) -> Result<(), AppError> {
    state.upsert_history(item)
}

#[tauri::command]
pub fn history_clear(state: tauri::State<'_, LibraryStore>) -> Result<(), AppError> {
    state.clear_history()
}

#[tauri::command(rename_all = "camelCase")]
pub fn history_remove(
    state: tauri::State<'_, LibraryStore>,
    site_key: String,
    vod_id: String,
) -> Result<(), AppError> {
    state.remove_history(&site_key, &vod_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> VodRef {
        VodRef {
            site_key: "stub_json".into(),
            vod_id: id.into(),
            name: "Sample".into(),
            pic: String::new(),
            remarks: String::new(),
            site_name: "Stub".into(),
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("luma-lib-{label}-{}", now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn favorite_toggle_and_persist() {
        let dir = temp_dir("fav");
        let store = LibraryStore::at(dir.clone());
        assert!(store.toggle_favorite(sample("1")).unwrap());
        assert!(store.is_favorite("stub_json", "1"));
        assert!(!store.toggle_favorite(sample("1")).unwrap());
        assert!(!store.is_favorite("stub_json", "1"));
        assert!(dir.join("luma.db").exists(), "data lives in sqlite, not json");

        // A fresh store (i.e. an app restart) sees the committed state.
        assert!(store.toggle_favorite(sample("2")).unwrap());
        let reopened = LibraryStore::at(dir.clone());
        assert!(reopened.is_favorite("stub_json", "2"));
        assert!(!reopened.is_favorite("stub_json", "1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_dedupes_by_vod() {
        let dir = temp_dir("hist");
        let store = LibraryStore::at(dir.clone());
        for position in [1000u64, 2000] {
            store
                .upsert_history(HistoryItem {
                    vod: sample("9"),
                    play_url: "http://127.0.0.1/x".into(),
                    position_ms: position,
                    duration_ms: 60000,
                    updated_at: 0,
                })
                .unwrap();
        }
        let items = store.list_history();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].position_ms, 2000);
        assert_eq!(LibraryStore::at(dir.clone()).list_history().len(), 1);
        store.clear_history().unwrap();
        assert!(store.list_history().is_empty());
        assert!(LibraryStore::at(dir.clone()).list_history().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
