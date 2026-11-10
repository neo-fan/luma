//! Favourites and playback history persistence (spec T-12).
//!
//! One JSON document per concern under the app data directory. Portable mode
//! (`data/` next to the executable) wins over `%APPDATA%` when it exists.

use crate::error::{code, AppError};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;
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

#[derive(Debug, Default, Serialize, Deserialize)]
struct FavoritesFile {
    #[serde(default)]
    items: Vec<FavoriteItem>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct HistoryFile {
    #[serde(default)]
    items: Vec<HistoryItem>,
}

pub struct LibraryStore {
    dir: PathBuf,
    favorites: RwLock<Vec<FavoriteItem>>,
    history: RwLock<Vec<HistoryItem>>,
}

const MAX_HISTORY: usize = 500;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("TVBOX_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
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
            return PathBuf::from(appdata).join("tvbox-desktop");
        }
    }
    PathBuf::from("data")
}

impl LibraryStore {
    pub fn load() -> Self {
        Self::at(data_dir())
    }

    /// Open the library rooted at `dir`; used by tests to stay isolated.
    pub fn at(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        let favorites = read_json::<FavoritesFile>(&dir.join("favorites.json"))
            .unwrap_or_default()
            .items;
        let history = read_json::<HistoryFile>(&dir.join("history.json"))
            .unwrap_or_default()
            .items;
        Self {
            dir,
            favorites: RwLock::new(favorites),
            history: RwLock::new(history),
        }
    }

    pub fn dir(&self) -> &PathBuf {
        &self.dir
    }

    fn flush_favorites(&self) -> Result<(), AppError> {
        let guard = self.favorites.read().unwrap_or_else(|p| p.into_inner());
        write_json(&self.dir.join("favorites.json"), &FavoritesFile { items: guard.clone() })
    }

    fn flush_history(&self) -> Result<(), AppError> {
        let guard = self.history.read().unwrap_or_else(|p| p.into_inner());
        write_json(&self.dir.join("history.json"), &HistoryFile { items: guard.clone() })
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
        let added = {
            let mut guard = self.favorites.write().unwrap_or_else(|p| p.into_inner());
            let existing = guard
                .iter()
                .position(|item| item.vod.site_key == vod.site_key && item.vod.vod_id == vod.vod_id);
            match existing {
                Some(index) => {
                    guard.remove(index);
                    false
                }
                None => {
                    guard.push(FavoriteItem { vod, added_at: now_ms() });
                    true
                }
            }
        };
        self.flush_favorites()?;
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
        {
            let mut guard = self.history.write().unwrap_or_else(|p| p.into_inner());
            guard.retain(|entry| {
                !(entry.vod.site_key == item.vod.site_key && entry.vod.vod_id == item.vod.vod_id)
            });
            guard.push(HistoryItem { updated_at: now_ms(), ..item });
            if guard.len() > MAX_HISTORY {
                let mut sorted = guard.clone();
                sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
                sorted.truncate(MAX_HISTORY);
                *guard = sorted;
            }
        }
        self.flush_history()
    }

    pub fn clear_history(&self) -> Result<(), AppError> {
        {
            let mut guard = self.history.write().unwrap_or_else(|p| p.into_inner());
            guard.clear();
        }
        self.flush_history()
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(value)
        .map_err(|err| AppError::new(code::INTERNAL, "serialize library failed").with_cause(err.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text.as_bytes())
        .map_err(|err| AppError::new(code::INTERNAL, "write library failed").with_cause(err.to_string()))?;
    std::fs::rename(&tmp, path)
        .map_err(|err| AppError::new(code::INTERNAL, "commit library failed").with_cause(err.to_string()))
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

    #[test]
    fn favorite_toggle_and_persist() {
        let dir = std::env::temp_dir().join(format!("tvbox-test-{}", now_ms()));
        let store = LibraryStore::at(dir.clone());
        assert!(store.toggle_favorite(sample("1")).unwrap());
        assert!(store.is_favorite("stub_json", "1"));
        assert!(!store.toggle_favorite(sample("1")).unwrap());
        assert!(!store.is_favorite("stub_json", "1"));
        assert!(dir.join("favorites.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn history_dedupes_by_vod() {
        let dir = std::env::temp_dir().join(format!("tvbox-hist-{}", now_ms()));
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
        store.clear_history().unwrap();
        assert!(store.list_history().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
