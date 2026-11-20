//! Favourites and playback history (spec T-12).
//!
//! SQLite (`infra/db/`) is the single source of truth. The `Vec` fields are read
//! caches only: every mutation commits a transaction first, then refreshes the
//! cache, so a failed write can never leave the UI showing data that is not on
//! disk. Portable mode (`data/` next to the executable) still wins over
//! `%APPDATA%` — the database simply lives in that directory.
//!
//! **2.0 数据模型**：收藏与历史合并为**一张 `playback` 表**，收藏只是行上的
//! `favorite` 标记。收藏页 = `favorite=1`，历史页 = 全部；清除播放记录只删
//! `favorite=0`，收藏行连进度一起保留；取消收藏只把标记置 0，行不删。

use crate::db::{Db, PlaybackRow};
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
    /// 语义集号（从集名解析）；不是数组下标，倒序线路也正确。
    #[serde(default)]
    pub episode_number: Option<i64>,
    /// 播放时解码出的画面分辨率标签（`720P` / `1080P` / `2K` / `4K`）。
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
    /// 剧个性配置扩展位（JSON 文本）。
    #[serde(default)]
    pub prefs_json: String,
    /// 收藏标记：收藏只是这条播放记录上的一个 flag。
    #[serde(default)]
    pub favorite: bool,
    /// 订阅裸地址快照（弱引用：订阅删了，记录仍可展示）。
    #[serde(default)]
    pub subscription_address: String,
    /// 豆瓣 id（可选）：有就记，不参与剧名合并。
    #[serde(default)]
    pub douban_id: String,
    pub updated_at: u64,
}

pub struct LibraryStore {
    db: Arc<Db>,
    /// 单表全量缓存（含收藏与历史）；`list_*` 只做过滤视图。
    playback: RwLock<Vec<PlaybackRow>>,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
            // 目录名 = identifier：`app.luma` / `app.luma.beta` / `app.luma.dev`。
            // 与系统里看到的包身份同名，通道隔离不再维护一套额外的目录后缀。
            return PathBuf::from(appdata).join(crate::channel::data_dir_name());
        }
    }
    PathBuf::from("data")
}

/// 剧名归一化：去掉所有空白 + 转小写。这是收藏 / 历史唯一使用的剧名判等口径。
fn normalize_title(name: &str) -> String {
    name.trim()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

/// 播放记录的业务主键：剧名归一化；空片名退回 `site:vod`，绝不让空名互相吞并。
fn title_key_of(vod: &VodRef) -> String {
    let key = normalize_title(&vod.name);
    if key.is_empty() {
        format!("{}:{}", vod.site_key, vod.vod_id)
    } else {
        key
    }
}

fn vod_ref(row: &PlaybackRow) -> VodRef {
    VodRef {
        site_key: row.site_key.clone(),
        vod_id: row.vod_id.clone(),
        name: row.title.clone(),
        pic: row.pic.clone(),
        remarks: row.remarks.clone(),
        site_name: row.site_name.clone(),
    }
}

fn favorite_from_row(row: PlaybackRow) -> FavoriteItem {
    FavoriteItem {
        vod: vod_ref(&row),
        added_at: row.favorite_at.unwrap_or(row.updated_at),
    }
}

fn history_from_row(row: PlaybackRow) -> HistoryItem {
    HistoryItem {
        vod: vod_ref(&row),
        play_url: row.play_url,
        episode_name: row.episode_name,
        play_from: row.line_name,
        episode_number: row.episode_number,
        resolution: row.resolution,
        position_ms: row.position_ms,
        duration_ms: row.duration_ms,
        rate: row.rate,
        skip_json: row.skip_json,
        prefs_json: row.prefs_json,
        favorite: row.favorite,
        subscription_address: row.subscription_address,
        douban_id: row.douban_id,
        updated_at: row.updated_at,
    }
}

impl LibraryStore {
    pub fn load(db: Arc<Db>) -> Result<Self, AppError> {
        let playback = db.playback()?;
        Ok(Self {
            db,
            playback: RwLock::new(playback),
        })
    }

    /// Open the library rooted at `dir`; used by tests to stay isolated.
    pub fn at(dir: PathBuf) -> Self {
        let db = Arc::new(Db::at(dir).expect("open sqlite database"));
        Self::load(db).expect("load library store")
    }

    /// 低频操作后重读全表，保证缓存与库严格一致。
    fn reload(&self) -> Result<(), AppError> {
        let rows = self.db.playback()?;
        *self
            .playback
            .write()
            .unwrap_or_else(|p| p.into_inner()) = rows;
        Ok(())
    }

    pub fn list_favorites(&self) -> Vec<FavoriteItem> {
        let mut items = self
            .playback
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .filter(|row| row.favorite)
            .map(|row| favorite_from_row(row.clone()))
            .collect::<Vec<_>>();
        items.sort_by(|a, b| b.added_at.cmp(&a.added_at));
        items
    }

    /// Returns `true` when the entry ended up favourited.
    ///
    /// 收藏 = 在播放记录上置 `favorite=1`（行不存在则新建一条无进度记录）；
    /// 取消 = 置 0，**行保留**。按剧名（`title_key`）判重，换源后仍是一部片。
    pub fn toggle_favorite(&self, vod: VodRef) -> Result<bool, AppError> {
        let now = now_ms();
        let seed = PlaybackRow {
            id: 0,
            title_key: title_key_of(&vod),
            title: vod.name.clone(),
            subscription_address: String::new(),
            subscription_id: String::new(),
            site_key: vod.site_key.clone(),
            site_name: vod.site_name.clone(),
            vod_id: vod.vod_id.clone(),
            line_name: String::new(),
            episode_name: String::new(),
            episode_number: None,
            play_url: String::new(),
            pic: vod.pic.clone(),
            remarks: vod.remarks.clone(),
            douban_id: String::new(),
            position_ms: 0,
            duration_ms: 0,
            resolution: String::new(),
            rate: 0.0,
            skip_json: String::new(),
            prefs_json: "{}".into(),
            favorite: true,
            favorite_at: Some(now),
            created_at: now,
            updated_at: now,
        };
        let added = self.db.toggle_playback_favorite(&seed)?;
        self.reload()?;
        Ok(added)
    }

    pub fn is_favorite(&self, site_key: &str, vod_id: &str) -> bool {
        self.playback
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|row| row.favorite && row.site_key == site_key && row.vod_id == vod_id)
    }

    /// 按片名判断（换源后仍能认出同一部片），供前端星标状态对齐。
    pub fn is_favorite_by_title(&self, name: &str) -> bool {
        let key = normalize_title(name);
        if key.is_empty() {
            return false;
        }
        self.playback
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|row| row.favorite && row.title_key == key)
    }

    /// 补元数据（封面 / 备注 / 站点名 / 豆瓣 id）。空值不覆盖，不动 `updated_at`。
    fn patch_meta(&self, vod: VodRef) -> Result<bool, AppError> {
        let hit = self.db.patch_playback_meta(
            &title_key_of(&vod),
            &vod.name,
            &vod.pic,
            &vod.remarks,
            &vod.site_name,
            "",
        )?;
        if hit {
            self.reload()?;
        }
        Ok(hit)
    }

    pub fn patch_favorite_meta(&self, vod: VodRef) -> Result<bool, AppError> {
        self.patch_meta(vod)
    }

    pub fn list_history(&self) -> Vec<HistoryItem> {
        let mut items = self
            .playback
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .cloned()
            .map(history_from_row)
            .collect::<Vec<_>>();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        items
    }

    pub fn upsert_history(&self, item: HistoryItem) -> Result<(), AppError> {
        let now = now_ms();
        let row = PlaybackRow {
            id: 0,
            title_key: title_key_of(&item.vod),
            title: item.vod.name.clone(),
            subscription_address: item.subscription_address.clone(),
            subscription_id: String::new(),
            site_key: item.vod.site_key.clone(),
            site_name: item.vod.site_name.clone(),
            vod_id: item.vod.vod_id.clone(),
            line_name: item.play_from.clone(),
            episode_name: item.episode_name.clone(),
            episode_number: item.episode_number,
            play_url: item.play_url.clone(),
            pic: item.vod.pic.clone(),
            remarks: item.vod.remarks.clone(),
            douban_id: item.douban_id.clone(),
            position_ms: item.position_ms,
            duration_ms: item.duration_ms,
            resolution: item.resolution.clone(),
            rate: item.rate,
            skip_json: item.skip_json.clone(),
            prefs_json: item.prefs_json.clone(),
            favorite: item.favorite,
            // 首播即收藏时同步写入收藏时间，避免退化为 updated_at 导致排序不准。
            // 后续 upsert 的 ON CONFLICT 分支不改 favorite/favorite_at，故此值稳定。
            favorite_at: if item.favorite { Some(now) } else { None },
            created_at: now,
            updated_at: now,
        };
        let outcome = self.db.upsert_playback(&row)?;
        // 增量更新缓存：删掉被容量裁剪的 + 同 key 旧行，再把最终行置顶。
        let mut guard = self
            .playback
            .write()
            .unwrap_or_else(|p| p.into_inner());
        guard.retain(|row| {
            row.title_key != outcome.merged.title_key
                && !outcome.removed.iter().any(|key| key == &row.title_key)
        });
        guard.insert(0, outcome.merged);
        // 内存也按「收藏永不裁剪 + 非收藏最多 MAX_HISTORY」收口。
        if guard.len() > crate::db::MAX_HISTORY {
            guard.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            let mut kept = 0usize;
            guard.retain(|row| {
                if row.favorite {
                    true
                } else {
                    kept += 1;
                    kept <= crate::db::MAX_HISTORY
                }
            });
        }
        Ok(())
    }

    /// 补历史条目元数据（老记录没有封面）。不改 `updated_at`，顺序不变。
    pub fn patch_history_meta(&self, vod: VodRef) -> Result<bool, AppError> {
        self.patch_meta(vod)
    }

    /// 清除播放记录：**只删非收藏**，收藏行连进度一起保留。
    pub fn clear_history(&self) -> Result<(), AppError> {
        self.db.clear_playback()?;
        self.reload()?;
        Ok(())
    }

    /// 删除单条播放记录；显式删除时收藏行也会被删掉。
    ///
    /// 直接查库按 (site_key, vod_id) 定位，不依赖读缓存：缓存可能因写后 reload 的
    /// 窗口期尚未包含该行，靠缓存会「查不到 → 静默成功」留下 DB 残留行。只有真正
    /// 删到行才刷新缓存，避免无谓的整表重读。
    pub fn remove_history(&self, site_key: &str, vod_id: &str) -> Result<(), AppError> {
        let removed = self.db.remove_playback_ref(site_key, vod_id)?;
        if removed > 0 {
            self.reload()?;
        }
        Ok(())
    }
}

#[tauri::command]
pub fn favorites_list(state: tauri::State<'_, LibraryStore>) -> Vec<FavoriteItem> {
    state.list_favorites()
}

/// 同步命令会落在主线程：播放中每 5s 一次的历史上行若带一次事务 + 全表回读，会在
/// 滚动 / 进度条上表现为周期性微卡。async 命令由 Tauri 调度到 runtime，避开主线程。
#[tauri::command]
pub async fn favorites_toggle(
    state: tauri::State<'_, LibraryStore>,
    vod: VodRef,
) -> Result<bool, AppError> {
    state.toggle_favorite(vod)
}

/// 老收藏没存封面时由列表页回填；不改收藏时间。
#[tauri::command]
pub async fn favorites_patch_meta(
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
pub async fn history_upsert(
    state: tauri::State<'_, LibraryStore>,
    item: HistoryItem,
) -> Result<(), AppError> {
    state.upsert_history(item)
}

/// 老历史缺封面时由历史页回填；不改 `updatedAt`，列表顺序保持。
#[tauri::command]
pub async fn history_patch_meta(
    state: tauri::State<'_, LibraryStore>,
    vod: VodRef,
) -> Result<bool, AppError> {
    state.patch_history_meta(vod)
}

#[tauri::command]
pub async fn history_clear(state: tauri::State<'_, LibraryStore>) -> Result<(), AppError> {
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

    fn empty_item(vod: VodRef) -> HistoryItem {
        HistoryItem {
            vod,
            play_url: String::new(),
            episode_name: String::new(),
            play_from: String::new(),
            episode_number: None,
            resolution: String::new(),
            position_ms: 0,
            duration_ms: 0,
            rate: 0.0,
            skip_json: String::new(),
            prefs_json: "{}".into(),
            favorite: false,
            subscription_address: String::new(),
            douban_id: String::new(),
            updated_at: 0,
        }
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
            let mut item = empty_item(sample("9"));
            item.episode_name = "第 2 集".into();
            item.play_from = "线路A".into();
            item.resolution = "1080P".into();
            item.position_ms = position;
            item.duration_ms = 60000;
            store.upsert_history(item).unwrap();
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
        empty_item(VodRef {
            name: name.into(),
            vod_id: id.into(),
            ..sample(id)
        })
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

    /// 同名换源时 DB 按 title_key 覆盖同一行，缓存必须只剩一行。
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
