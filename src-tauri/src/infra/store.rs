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
    /// 最近观看的集数名；用于历史列表显示「看到第几集」与详情页续播定位。
    #[serde(default)]
    pub episode_name: String,
    /// 线路名（TVBox `vod_play_from` 的一段）；换源后线路名会变，必须记录。
    #[serde(default)]
    pub play_from: String,
    /// 播放时解码出的画面分辨率标签（`720P` / `1080P` / `2K` / `4K`）。
    ///
    /// 站点侧没有这个字段，只有真出画后才拿得到；没播过就一直是空串，
    /// 历史页据此决定要不要显示角标。
    #[serde(default)]
    pub resolution: String,
    #[serde(default)]
    pub position_ms: u64,
    #[serde(default)]
    pub duration_ms: u64,
    /// 这部剧的倍速（0 = 没带/没设过，读取方按 1.0 处理）。
    #[serde(default)]
    pub rate: f64,
    /// 这部剧的跳过片段配置（JSON 文本）。空串 = 没带；`[]` = 用户清空过。
    #[serde(default)]
    pub skip_json: String,
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

/// 只合并非空字段：补元数据不能把已知道的封面 / 备注 / 站点名抹成空串。
fn merge_meta(dst: &mut VodRef, src: &VodRef) {
    if !src.name.is_empty() {
        dst.name = src.name.clone();
    }
    if !src.pic.is_empty() {
        dst.pic = src.pic.clone();
    }
    if !src.remarks.is_empty() {
        dst.remarks = src.remarks.clone();
    }
    if !src.site_name.is_empty() {
        dst.site_name = src.site_name.clone();
    }
}

pub fn data_dir() -> PathBuf {
    // `LUMA_DATA_DIR` is the documented override.
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
            // debug 构建（dev / 直跑 debug exe）与正式版数据完全隔离：配置、
            // 收藏、历史、日志都落到 `Luma-debug`，测试再怎么折腾也不会碰
            // 用户真实数据。release（含便携版）不受影响。显式 override
            // （LUMA_DATA_DIR）与便携模式优先级更高，测试依赖这一点。
            if cfg!(debug_assertions) {
                return PathBuf::from(appdata).join("Luma-debug");
            }
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
        episode_name: row.episode_name,
        play_from: row.play_from,
        resolution: row.resolution,
        position_ms: row.position_ms,
        duration_ms: row.duration_ms,
        rate: row.rate,
        skip_json: row.skip_json,
        updated_at: row.updated_at,
    }
}

fn same_vod(a: &VodRef, b: &VodRef) -> bool {
    a.site_key == b.site_key && a.vod_id == b.vod_id
}

/** 片名归一化：全半角空格、大小写差异都算同一部片。空名不参与合并。 */
pub fn same_title(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.trim()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
            .to_lowercase()
    };
    let left = norm(a);
    let right = norm(b);
    !left.is_empty() && left == right
}

impl LibraryStore {
    pub fn load(db: Arc<Db>) -> Result<Self, AppError> {
        let favorites = db.favorites()?.into_iter().map(favorite_from_row).collect();
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
        // 与 db 层同口径：按片名剔除，换源后的旧条目不能留在缓存里。
        guard.retain(|item| !(same_title(&item.vod.name, &vod.name) || same_vod(&item.vod, &vod)));
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

    /// 按片名判断（换源后仍能认出同一部片），供前端星标状态对齐。
    pub fn is_favorite_by_title(&self, name: &str) -> bool {
        let guard = self.favorites.read().unwrap_or_else(|p| p.into_inner());
        guard.iter().any(|item| same_title(&item.vod.name, name))
    }

    /// 补收藏条目的元数据（老记录没有封面）。返回是否命中一行。
    pub fn patch_favorite_meta(&self, vod: VodRef) -> Result<bool, AppError> {
        let hit = self.db.patch_favorite_meta(
            &vod.site_key,
            &vod.vod_id,
            &vod.name,
            &vod.pic,
            &vod.remarks,
            &vod.site_name,
        )?;
        if hit {
            let mut guard = self.favorites.write().unwrap_or_else(|p| p.into_inner());
            if let Some(item) = guard
                .iter_mut()
                .find(|item| item.vod.site_key == vod.site_key && item.vod.vod_id == vod.vod_id)
            {
                merge_meta(&mut item.vod, &vod);
            }
        }
        Ok(hit)
    }

    pub fn list_history(&self) -> Vec<HistoryItem> {
        // Same as `list_favorites`: sort the copy outside the read lock.
        let mut items = self
            .history
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        // 写入侧已按剧名合并，但老库里可能还留着换源前的重复行；读取时按
        // 「剧名完全匹配」再兜一层，保证一部剧在历史页 / 续播里只出现一次。
        // 已按 updated_at 降序，保留第一条即最新的一条。
        let mut seen = std::collections::HashSet::new();
        items.retain(|item| {
            let name = item.vod.name.trim();
            name.is_empty() || seen.insert(name.to_string())
        });
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
            episode_name: item.episode_name.clone(),
            play_from: item.play_from.clone(),
            resolution: item.resolution.clone(),
            position_ms: item.position_ms,
            duration_ms: item.duration_ms,
            rate: item.rate,
            skip_json: item.skip_json.clone(),
            // Always use a fresh timestamp: the caller's value may be stale
            // (e.g. a restored player session), and the cap relies on ordering.
            updated_at: now_ms(),
        };
        let outcome = self.db.upsert_history(&row)?;
        // 增量更新缓存：把 DB 报告「这次删掉的行」施加到内存列表，再把最终行
        // 顶到最前。以前是写完重读全表（每条历史写入 O(MAX_HISTORY=500)）。
        let fresh = history_from_row(outcome.merged);
        let mut guard = self.history.write().unwrap_or_else(|p| p.into_inner());
        if !outcome.removed.is_empty() {
            guard.retain(|item| {
                !outcome
                    .removed
                    .iter()
                    .any(|(site, id)| *site == item.vod.site_key && *id == item.vod.vod_id)
            });
        }
        guard.retain(|item| {
            !(item.vod.site_key == fresh.vod.site_key && item.vod.vod_id == fresh.vod.vod_id)
        });
        guard.insert(0, fresh);
        if guard.len() > crate::db::MAX_HISTORY {
            // 溢出是罕见分支（要攒满 500 条），这里排一次序保证裁掉的是最旧的：
            // 缓存的默认顺序是「新在前」，但重启装载的顺序不保证，不能靠它。
            guard.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            guard.truncate(crate::db::MAX_HISTORY);
        }
        Ok(())
    }

    /// 补历史条目的元数据（老记录没有封面）。不改 `updated_at`，顺序不变。
    pub fn patch_history_meta(&self, vod: VodRef) -> Result<bool, AppError> {
        let hit = self.db.patch_history_meta(
            &vod.site_key,
            &vod.vod_id,
            &vod.name,
            &vod.pic,
            &vod.remarks,
            &vod.site_name,
        )?;
        if hit {
            let mut guard = self.history.write().unwrap_or_else(|p| p.into_inner());
            if let Some(item) = guard
                .iter_mut()
                .find(|item| item.vod.site_key == vod.site_key && item.vod.vod_id == vod.vod_id)
            {
                merge_meta(&mut item.vod, &vod);
            }
        }
        Ok(hit)
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
pub fn favorites_toggle(
    state: tauri::State<'_, LibraryStore>,
    vod: VodRef,
) -> Result<bool, AppError> {
    state.toggle_favorite(vod)
}

/// 老收藏没存封面时由列表页回填；不改收藏时间。
#[tauri::command]
pub fn favorites_patch_meta(
    state: tauri::State<'_, LibraryStore>,
    vod: VodRef,
) -> Result<bool, AppError> {
    state.patch_favorite_meta(vod)
}

#[tauri::command]
pub fn history_list(state: tauri::State<'_, LibraryStore>) -> Vec<HistoryItem> {
    state.list_history()
}

#[tauri::command]
pub fn history_upsert(
    state: tauri::State<'_, LibraryStore>,
    item: HistoryItem,
) -> Result<(), AppError> {
    state.upsert_history(item)
}

/// 老历史缺封面时由历史页回填；不改 `updatedAt`，列表顺序保持。
#[tauri::command]
pub fn history_patch_meta(
    state: tauri::State<'_, LibraryStore>,
    vod: VodRef,
) -> Result<bool, AppError> {
    state.patch_history_meta(vod)
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
        assert!(
            dir.join("luma.db").exists(),
            "data lives in sqlite, not json"
        );

        // A fresh store (i.e. an app restart) sees the committed state.
        assert!(store.toggle_favorite(sample("2")).unwrap());
        let reopened = LibraryStore::at(dir.clone());
        assert!(reopened.is_favorite("stub_json", "2"));
        assert!(!reopened.is_favorite("stub_json", "1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同一部片换源后 site_key + vod_id 全变：收藏必须仍只有一条，
    /// 且在任一源点星标都是「取消」而不是又插一条同名记录。
    #[test]
    fn favorite_dedupes_by_title_across_sites() {
        let dir = temp_dir("fav-title");
        let store = LibraryStore::at(dir.clone());
        let first = sample("1");
        assert!(store.toggle_favorite(first.clone()).unwrap());
        assert!(store.is_favorite_by_title("Sample"));

        let other_site = VodRef {
            site_key: "another_site".into(),
            vod_id: "999".into(),
            ..first.clone()
        };
        // 换源后再点一次星标 = 取消，而不是新增。
        assert!(!store.toggle_favorite(other_site).unwrap());
        assert!(store.list_favorites().is_empty());
        assert!(!store.is_favorite_by_title("Sample"));

        // 空片名不能互相吞并，退回复合键。
        let blank = |id: &str| VodRef {
            name: String::new(),
            vod_id: id.into(),
            ..first.clone()
        };
        assert!(store.toggle_favorite(blank("a")).unwrap());
        assert!(store.toggle_favorite(blank("b")).unwrap());
        assert_eq!(store.list_favorites().len(), 2);
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
                    episode_name: "第 2 集".into(),
                    play_from: "线路A".into(),
                    resolution: "1080P".into(),
                    rate: 0.0,
                    skip_json: String::new(),
                    position_ms: position,
                    duration_ms: 60000,
                    updated_at: 0,
                })
                .unwrap();
        }
        let items = store.list_history();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].position_ms, 2000);
        assert_eq!(items[0].episode_name, "第 2 集");
        assert_eq!(items[0].play_from, "线路A");
        assert_eq!(LibraryStore::at(dir.clone()).list_history().len(), 1);
        store.clear_history().unwrap();
        assert!(store.list_history().is_empty());
        assert!(LibraryStore::at(dir.clone()).list_history().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn titled(name: &str, id: &str) -> HistoryItem {
        HistoryItem {
            vod: VodRef {
                name: name.into(),
                vod_id: id.into(),
                ..sample(id)
            },
            play_url: "http://127.0.0.1/x".into(),
            episode_name: String::new(),
            play_from: String::new(),
            resolution: String::new(),
            rate: 0.0,
            skip_json: String::new(),
            position_ms: 0,
            duration_ms: 0,
            updated_at: 0,
        }
    }

    fn keys(items: &[HistoryItem]) -> Vec<(String, String)> {
        let mut out = items
            .iter()
            .map(|item| (item.vod.site_key.clone(), item.vod.vod_id.clone()))
            .collect::<Vec<_>>();
        out.sort();
        out
    }

    /// 跨上限写入后，内存缓存必须与库里一致（增量更新的正确性守卫）。
    ///
    /// 参照物是「重开一份 store」——它只能从 SQLite 读，等价于旧实现
    /// 每次写完重读全表的结果；不一致就说明 `upsert_history` 的删除报告
    /// 与 SQL 实际删的行对不上。`updated_at` 可能并列，所以比按键集合。
    #[test]
    fn history_cache_matches_database_across_the_cap() {
        let dir = temp_dir("hist-cap");
        let store = LibraryStore::at(dir.clone());
        let total = crate::db::MAX_HISTORY + 3;
        for index in 0..total {
            let id = format!("v{index}");
            store.upsert_history(titled(&id.clone(), &id)).unwrap();
        }
        let cached = store.list_history();
        let reloaded = LibraryStore::at(dir.clone());
        assert_eq!(cached.len(), crate::db::MAX_HISTORY);
        assert_eq!(
            keys(&cached),
            keys(&reloaded.list_history()),
            "cache diverged from the database after crossing the cap"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同名换源时 DB 会删掉旧站那行，缓存必须跟着丢——否则历史页会显示
    /// 一条库里已经不存在的记录。
    #[test]
    fn history_cache_drops_the_row_the_database_deduped() {
        let dir = temp_dir("hist-dedupe");
        let store = LibraryStore::at(dir.clone());
        let first = HistoryItem {
            vod: VodRef {
                site_key: "site_a".into(),
                ..sample("1")
            },
            ..titled("Sample", "1")
        };
        let moved = HistoryItem {
            vod: VodRef {
                site_key: "site_b".into(),
                vod_id: "2".into(),
                ..first.vod.clone()
            },
            ..titled("Sample", "2")
        };
        store.upsert_history(first).unwrap();
        assert_eq!(store.list_history().len(), 1);
        store.upsert_history(moved).unwrap();

        let cached = store.list_history();
        assert_eq!(cached.len(), 1, "同名换源后历史只剩一条");
        assert_eq!(cached[0].vod.site_key, "site_b");
        assert_eq!(
            keys(&cached),
            keys(&LibraryStore::at(dir.clone()).list_history()),
            "缓存里留着了一条库里已被删掉的行"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
