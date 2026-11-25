//! Configuration import and snapshot store (spec T-05).
//!
//! 解密、JSONC 清洗、归一化与多仓合并都在本模块内完成（decrypt / normalize）；
//! 这里只负责取载荷、走完流程、落快照。全部在宿主进程内跑，导入不会被排在爬虫
//! 队列后面撞超时。

use crate::db::{ConfigWrite, Db};
use crate::error::{code, AppError};
use crate::ghproxy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use derive::{derive_runtime, refresh_policy, runtime_of};
use github::read_gh_state;
use naming::clean_name;

/// 站点体检里「手动禁用」写入的原因串。订阅定时刷新会重新派生 runtime，
/// 必须按这个串把用户手动屏蔽的站点再禁一遍，否则每天更新一次订阅就把
/// 用户挑出来的慢源/死源全部复活。
const MANUAL_DISABLE_REASON: &str = "已在站点体检中手动禁用";

/// 订阅刷新的全局间隔（小时，0 = 关闭）。存 meta 而不是加表列：它是运行时
/// 偏好，不需要跟着 import/runtime 双快照走。
const META_REFRESH_INTERVAL: &str = "refresh_interval_hours";
/// 每个配置的刷新状态：`refresh_state:<configId>` → RefreshState JSON。
const META_REFRESH_PREFIX: &str = "refresh_state:";
const DEFAULT_REFRESH_HOURS: u32 = 12;
/// 上限一周：再长就不如关掉，省得「设置了但永远等不到」。
const MAX_REFRESH_HOURS: u32 = 168;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSource {
    pub kind: String,
    pub value: String,
    /// Config name typed by the user during import.
    ///
    /// It travels inside the source object (instead of a second command
    /// argument) so every existing `config_import { source: {kind, value} }`
    /// caller keeps working, and it is cleared before the row is persisted:
    /// the name of record is `ConfigSnapshot::name`, not the source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    pub id: String,
    pub name: String,
    pub imported_at: String,
    pub sites: Vec<Value>,
    #[serde(default)]
    pub lives: Vec<Value>,
    #[serde(default)]
    pub parses: Vec<Value>,
    /// Per-host request headers (TVBox top-level `headers`), used by the local
    /// proxy and playback so anti-leech CDNs see their expected UA/Referer.
    #[serde(default)]
    pub headers: Vec<Value>,
    #[serde(default)]
    pub spider: Option<String>,
    #[serde(default)]
    pub wallpaper: Option<String>,
    #[serde(default)]
    pub flags: Vec<Value>,
    #[serde(default, rename = "_raw")]
    pub raw: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigMeta {
    pub id: String,
    pub name: String,
    pub source: ConfigSource,
    pub imported_at: String,
    /// 只有 `url` 来源能刷新：file/text 没有远端可回拉。
    pub refreshable: bool,
    /// 上次检查的墙钟毫秒（含「无变化」与失败）。
    #[serde(default)]
    pub last_checked_at: Option<u64>,
    /// 上次**内容真的变了**并落库的时刻。
    #[serde(default)]
    pub last_changed_at: Option<u64>,
    /// 上次检查失败的原因；成功后清空。
    #[serde(default)]
    pub refresh_error: Option<String>,
}

/// 订阅刷新的运行时状态，序列化进 meta。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshState {
    #[serde(default)]
    checked_at: u64,
    #[serde(default)]
    changed_at: Option<u64>,
    #[serde(default)]
    error: Option<String>,
}

/// 设置页「订阅自动刷新」用的聚合视图：全局间隔 + active 配置的状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSettings {
    pub interval_hours: u32,
    pub config_id: Option<String>,
    pub last_checked_at: Option<u64>,
    pub last_changed_at: Option<u64>,
    pub error: Option<String>,
    /// 下次到期的墙钟毫秒；关闭 / 无 active 时为 None，UI 拿它显示「约 N 小时后检查」。
    pub next_due_at: Option<u64>,
}

/// 一次刷新检查的结果。`changed` 为真时 `snapshot` 是新的运行快照，
/// 前端用它替换站点缓存；为假时 `snapshot` 为 None（不打扰界面）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshOutcome {
    pub config_id: String,
    pub name: String,
    pub changed: bool,
    pub sites: usize,
    pub enabled: usize,
    pub checked_at: u64,
    #[serde(default)]
    pub snapshot: Option<ConfigSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredConfig {
    /// Config exactly as imported + normalized. Runtime policy NEVER rewrites
    /// this: it is the source of truth when a policy changes and the only place
    /// old favourites/history can still look a site up.
    ///
    /// `alias` reads files written before the split, where this field was
    /// called `snapshot`. New files always serialize as `imported`.
    #[serde(alias = "snapshot")]
    imported: ConfigSnapshot,
    /// One-way derivation of `imported` (see `derive_runtime`). All fan-out,
    /// playback and frontend cache reads go through this, never `imported`.
    #[serde(default)]
    runtime: Option<ConfigSnapshot>,
    source: ConfigSource,
}

/// Runtimes deliberately excluded from the runtime snapshot.
///
/// Community configs ship Android dex jars (`csp_*` sites + a config-level
/// `spider` jar); those need an Android runtime on Win x64 and only add a

pub struct ConfigStore {
    entries: RwLock<Vec<StoredConfig>>,
    /// The config last imported by the user; fan-out only uses its sites.
    active: RwLock<Option<String>>,
    /// SQLite is the source of truth; `entries` is a parsed read cache so a
    /// 100-site snapshot is not deserialized on every search keystroke.
    db: Arc<Db>,
}

impl ConfigStore {
    /// Restore snapshots from SQLite. A row written before the imported/runtime
    /// split (or by a partial write) may carry an empty `runtime_json`; derive
    /// once and persist the result, so a policy change replays without a
    /// re-import. This is defensive normalization, not a legacy-data migration.
    pub fn load(db: Arc<Db>) -> Result<Self, AppError> {
        let mut entries = Vec::new();
        for row in db.config_rows()? {
            let imported: ConfigSnapshot =
                serde_json::from_str(&row.imported_json).map_err(|err| {
                    AppError::new(
                        code::INTERNAL,
                        format!("config {} import is corrupt", row.id),
                    )
                    .with_cause(err.to_string())
                })?;
            let source: ConfigSource =
                serde_json::from_str(&row.source_json).unwrap_or_else(|_| ConfigSource {
                    kind: "text".into(),
                    value: String::new(),
                    name: None,
                });
            let runtime = if row.runtime_json.is_empty() {
                None
            } else {
                Some(serde_json::from_str(&row.runtime_json).map_err(|err| {
                    AppError::new(
                        code::INTERNAL,
                        format!("config {} runtime is corrupt", row.id),
                    )
                    .with_cause(err.to_string())
                })?)
            };
            let mut stored = StoredConfig {
                imported,
                runtime,
                source,
            };
            if stored.runtime.is_none() {
                let derived = derive_runtime(&stored.imported);
                db.set_runtime_json(&stored.imported.id, &serde_json::to_string(&derived)?)?;
                stored.runtime = Some(derived);
            } else if let Some(runtime) = stored.runtime.as_mut() {
                // Policy replay: unblocks JS sources imported before the qjs
                // ESM loader landed, and keeps jar sources blocked. Persist only
                // when something actually changed.
                if refresh_policy(runtime) {
                    db.set_runtime_json(&stored.imported.id, &serde_json::to_string(runtime)?)?;
                }
            }
            // 纠正自愈：订阅原文里的畸形地址（`https://https://…` 这类笔误）可能已经
            // 存在老库里。导入路径不再产出这种数据，这里把存量治好并落库——一次启动
            // 即收敛，所以请求路径不需要、也没有第二份兜底逻辑。
            let repaired = normalize::repair_snapshot(&mut stored.imported)
                + match stored.runtime.as_mut() {
                    Some(runtime) => normalize::repair_snapshot(runtime),
                    None => 0,
                };
            if repaired > 0 {
                let imported_json = serde_json::to_string(&stored.imported)?;
                // 走到这里 runtime 必定已就位（缺失时上面刚从 imported 派生过），
                // 兜底只是让类型闭合，不代表存在第二种数据形状。
                let runtime_json =
                    serde_json::to_string(stored.runtime.as_ref().unwrap_or(&stored.imported))?;
                let source_json = serde_json::to_string(&stored.source)?;
                db.update_config(ConfigWrite {
                    id: &stored.imported.id,
                    name: &stored.imported.name,
                    imported_at: &stored.imported.imported_at,
                    imported_json: &imported_json,
                    runtime_json: &runtime_json,
                    source_json: &source_json,
                })?;
                tracing::warn!(
                    id = %stored.imported.id,
                    repaired,
                    "stored config urls repaired on load"
                );
            }
            entries.push(stored);
        }
        // The active marker is authoritative. If it is missing or stale (older
        // data, or a config deleted out of band), fall back to the newest
        // import and self-heal the marker. Guessing from file order here is
        // what made fan-out search zero sites after a restart.
        let active = db
            .active_config_id()?
            .filter(|id| entries.iter().any(|entry| entry.imported.id == *id))
            .or_else(|| newest_id(&entries));
        db.set_active_config_id(active.as_deref())?;
        let store = Self {
            entries: RwLock::new(entries),
            active: RwLock::new(active),
            db,
        };
        // Publish the restored config's host header table; otherwise the first
        // playback after a restart loses the anti-leech headers.
        if let Some(snapshot) = store.active_snapshot() {
            crate::netrules::replace(&snapshot.headers);
        }
        Ok(store)
    }

    /// Persist the imported config AND its independent runtime derivation.
    /// Returns the runtime snapshot: `config_import` gives it to the frontend
    /// so the site cache cannot reintroduce sources we just blocked.
    pub fn insert(
        &self,
        imported: ConfigSnapshot,
        source: ConfigSource,
    ) -> Result<ConfigSnapshot, AppError> {
        let id = imported.id.clone();
        let runtime = derive_runtime(&imported);
        let headers = runtime.headers.clone();
        // Write the imported/runtime pair and switch the active marker in one
        // transaction BEFORE touching the in-memory caches. Two separate files
        // used to be able to disagree after a crash mid-write.
        let imported_json = serde_json::to_string(&imported)?;
        let runtime_json = serde_json::to_string(&runtime)?;
        let source_json = serde_json::to_string(&source)?;
        self.db.activate_config(ConfigWrite {
            id: &id,
            name: &imported.name,
            imported_at: &imported.imported_at,
            imported_json: &imported_json,
            runtime_json: &runtime_json,
            source_json: &source_json,
        })?;
        // One clone is unavoidable here: the store owns the runtime snapshot
        // while the caller needs it for the UI. Imports are rare; a second IPC
        // round trip to read it back would cost more than the copy.
        let stored = StoredConfig {
            imported,
            runtime: Some(runtime.clone()),
            source,
        };
        {
            let mut guard = self
                .entries
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.retain(|entry| entry.imported.id != id);
            guard.push(stored);
        }
        *self
            .active
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id.clone());
        crate::netrules::replace(&headers);
        // 刚导入即以「已检查」起算：否则后台任务在下一分钟就把同一份配置
        // 重拉一遍，白花一次请求。写入失败不影响导入结果。
        let _ = self.write_refresh_state(
            &id,
            &RefreshState {
                checked_at: crate::store::now_ms(),
                changed_at: None,
                error: None,
            },
        );
        Ok(runtime)
    }
}

impl ConfigStore {
    pub fn list(&self) -> Vec<ConfigMeta> {
        // 一次扫出全部刷新状态，避免配置列表逐行查库；读库失败只意味着
        // 状态列显示「未检查过」，不影响列表本身。
        let states = self.all_refresh_states();
        let guard = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .iter()
            .map(|entry| meta_of(entry, states.get(&entry.imported.id)))
            .collect()
    }

    /// 单份配置的 meta（编辑 / 重命名后回给前端）。列表页一次要全部，这里只要
    /// 一行，所以单独取一次刷新状态，不为了 12 个字段把整张状态表扫出来。
    fn meta_by_id(&self, id: &str) -> Option<ConfigMeta> {
        let state = self.refresh_state(id);
        let guard = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard
            .iter()
            .find(|entry| entry.imported.id == id)
            .map(|entry| meta_of(entry, state.as_ref()))
    }

    /// Current name of an imported config, used to keep a user-chosen name
    /// when the same config is imported again (id is derived from the origin,
    /// so a re-import overwrites the same row).
    pub fn name_of(&self, id: &str) -> Option<String> {
        self.entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .find(|entry| entry.imported.id == id)
            .map(|entry| entry.imported.name.clone())
    }

    /// Make another stored config the active one and return its runtime
    /// snapshot so the frontend can swap its site cache in the same breath.
    pub fn activate(&self, id: &str) -> Result<ConfigSnapshot, AppError> {
        let snapshot = {
            let guard = self
                .entries
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = guard
                .iter()
                .find(|entry| entry.imported.id == id)
                .ok_or_else(|| {
                    AppError::new(code::INVALID_ARGUMENT, format!("config {id} not found"))
                })?;
            runtime_of(entry).clone()
        };
        // Persist first: if SQLite rejects the write the in-memory active id
        // must keep pointing at the config that is actually stored.
        self.db.set_active_config_id(Some(id))?;
        *self
            .active
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id.to_string());
        crate::netrules::replace(&snapshot.headers);
        Ok(snapshot)
    }

    /// Rename a stored config. The name lives in both snapshots (`imported` is
    /// what the list/UI reads, `runtime` is what the frontend receives), so
    /// both are rewritten and the row is persisted as one row (no active id
    /// change — renaming must not switch what is playing).
    pub fn rename(&self, id: &str, name: &str) -> Result<ConfigMeta, AppError> {
        let name = clean_name(name);
        if name.is_empty() {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                "config name is empty",
            ));
        }
        let (mut imported, mut runtime, source) = {
            let guard = self
                .entries
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = guard
                .iter()
                .find(|entry| entry.imported.id == id)
                .ok_or_else(|| {
                    AppError::new(code::INVALID_ARGUMENT, format!("config {id} not found"))
                })?;
            (
                entry.imported.clone(),
                runtime_of(entry).clone(),
                entry.source.clone(),
            )
        };
        imported.name = name.clone();
        runtime.name = name.clone();
        let imported_json = serde_json::to_string(&imported)?;
        let runtime_json = serde_json::to_string(&runtime)?;
        let source_json = serde_json::to_string(&source)?;
        self.db.update_config(ConfigWrite {
            id: &imported.id,
            name: &name,
            imported_at: &imported.imported_at,
            imported_json: &imported_json,
            runtime_json: &runtime_json,
            source_json: &source_json,
        })?;
        {
            let mut guard = self
                .entries
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(entry) = guard.iter_mut().find(|entry| entry.imported.id == id) {
                entry.imported.name = name.clone();
                if let Some(snapshot) = entry.runtime.as_mut() {
                    snapshot.name = name.clone();
                }
            }
        }
        self.meta_by_id(id).ok_or_else(|| {
            AppError::new(code::INVALID_ARGUMENT, format!("config {id} not found"))
        })
    }
}

/// 一行的对外视图。`list` 与 `meta_by_id` 共用，避免两处各拼一份 12 字段
/// 结构体——历史上漏改一处就会让「编辑后名称不更新」这类问题复现。
fn meta_of(entry: &StoredConfig, state: Option<&RefreshState>) -> ConfigMeta {
    ConfigMeta {
        id: entry.imported.id.clone(),
        name: entry.imported.name.clone(),
        source: entry.source.clone(),
        imported_at: entry.imported.imported_at.clone(),
        refreshable: entry.source.kind == "url",
        last_checked_at: state.map(|state| state.checked_at).filter(|at| *at > 0),
        last_changed_at: state.and_then(|state| state.changed_at),
        refresh_error: state.and_then(|state| state.error.clone()),
    }
}

impl ConfigStore {
    pub fn remove(&self, id: &str) -> Result<(), AppError> {
        let exists = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .any(|entry| entry.imported.id == id);
        if !exists {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                format!("config {id} not found"),
            ));
        }
        let was_active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_deref()
            == Some(id);
        // SQLite promotes the newest remaining config when the active one is
        // removed; the returned id keeps the cache and the DB in agreement.
        let next_active = self.db.delete_config(id)?;
        // 刷新状态跟着配置一起走：留着只会在 meta 表里堆孤儿键。
        let _ = self.db.meta_remove(&format!("{META_REFRESH_PREFIX}{id}"));
        {
            let mut guard = self
                .entries
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.retain(|entry| entry.imported.id != id);
        }
        // Only now touch `active`, and only if it pointed at the removed entry.
        // `all_sites` acquires active then entries; taking them in the opposite
        // order (or overlapping) lets the two callers deadlock.
        if was_active {
            *self
                .active
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = next_active;
        }
        if let Some(snapshot) = self.active_snapshot() {
            crate::netrules::replace(&snapshot.headers);
        }
        Ok(())
    }

    pub fn find_site(&self, site_key: &str) -> Result<Value, AppError> {
        // Look in the imported configs on purpose: a favourite/history entry
        // may still point at a site that the runtime policy now blocks. The
        // caller (`spider_invoke`) enforces the policy before dispatch.
        let guard = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for entry in guard.iter() {
            for site in &entry.imported.sites {
                if site.get("key").and_then(Value::as_str) == Some(site_key) {
                    return Ok(site.clone());
                }
            }
        }
        Err(AppError::new(
            code::INVALID_ARGUMENT,
            format!("site {site_key} not found"),
        ))
    }

    /// Snapshot of the active config (falls back to the last imported one).
    ///
    /// `parses`/`flags` live at config level, not per site, so playback needs
    /// this rather than `find_site`.
    pub fn active_snapshot(&self) -> Option<ConfigSnapshot> {
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let guard = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pick(active.as_deref(), guard.as_slice()).map(|entry| runtime_of(entry).clone())
    }

    /// 只取当前配置 id。`active_snapshot()` 会整份深拷贝（上百个站点 + 原始
    /// JSON），仅为一个 id 在体检/诊断这类路径上做整份克隆不值得。
    pub fn active_id(&self) -> Option<String> {
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let guard = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pick(active.as_deref(), guard.as_slice()).map(|entry| entry.imported.id.clone())
    }

    /// Just the config-level `parses[]` pool. `parse_resolve` runs on every
    /// play attempt; cloning the whole snapshot there would also copy the raw
    /// config JSON (hundreds of KB) for a field nobody looks at.
    pub fn active_parses(&self) -> Vec<Value> {
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let guard = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pick(active.as_deref(), guard.as_slice())
            .map(|entry| runtime_of(entry).parses.clone())
            .unwrap_or_default()
    }

    /// Sites of the active config, de-duplicated by key (first wins).
    ///
    /// Old snapshots must not leak into the current config's fan-out: a
    /// previously imported stub/dead config would otherwise add dozens of
    /// doomed requests to every search. Falls back to all configs only when
    /// the active id is missing (e.g. hand-written test fixtures).
    pub fn all_sites(&self) -> Vec<Value> {
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let guard = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let has_active = active
            .as_ref()
            .map(|id| guard.iter().any(|entry| &entry.imported.id == id))
            .unwrap_or(false);

        // Borrow the keys for de-duplication: no need to allocate a String per
        // site just to test membership in the set.
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        let mut out = Vec::new();
        for entry in guard.iter() {
            if has_active && active.as_deref() != Some(entry.imported.id.as_str()) {
                continue;
            }
            for site in &runtime_of(entry).sites {
                let key = site.get("key").and_then(Value::as_str).unwrap_or("");
                if key.is_empty() || !seen.insert(key) {
                    continue;
                }
                out.push(site.clone());
            }
        }
        out
    }
}

/// Fallback for data written before `active.json` existed: the most recently
/// imported snapshot wins, not the last entry returned by `read_dir`.
fn newest_id(entries: &[StoredConfig]) -> Option<String> {
    entries
        .iter()
        .max_by(|a, b| a.imported.imported_at.cmp(&b.imported.imported_at))
        .map(|entry| entry.imported.id.clone())
}

/// Pick the active entry, or the most recently imported one when the active id
/// is missing (hand-written fixtures). `active_snapshot` and `active_parses`
/// must agree on this rule.
fn pick<'a>(active: Option<&str>, entries: &'a [StoredConfig]) -> Option<&'a StoredConfig> {
    entries
        .iter()
        .find(|entry| active == Some(entry.imported.id.as_str()))
        .or_else(|| entries.last())
}

/// async：列表会读刷新状态表，主线程同步执行时会被其它长 command 阻塞。
#[tauri::command]
pub async fn config_list(state: tauri::State<'_, ConfigStore>) -> Result<Vec<ConfigMeta>, AppError> {
    Ok(state.list())
}

/// Switch the active config without re-importing it. Returns the runtime
/// snapshot (blocked sites already disabled) so the UI can replace its cache.
/// async：`activate` 写 active_config_id 到 sqlite，别占主线程等锁。
#[tauri::command]
pub async fn config_activate(
    state: tauri::State<'_, ConfigStore>,
    id: String,
) -> Result<ConfigSnapshot, AppError> {
    state.activate(&id)
}

/// 编辑已导入订阅：改名、换地址（换地址会按新地址重新导入后原地替换同一行）。
///
/// 与 `config_rename` 的区别不是参数多少，而是语义：改名只动名字，换地址要
/// 重新拉取整份配置。两者合成一个命令，前端一次提交即可，也不会出现「名字改
/// 成功、地址改失败」的半截状态。
#[tauri::command]
pub async fn config_edit(
    state: tauri::State<'_, ConfigStore>,
    id: String,
    name: Option<String>,
    url: Option<String>,
) -> Result<ConfigEditOutcome, AppError> {
    state.edit(&id, name.as_deref(), url.as_deref()).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteSetEnabledRequest {
    pub site_key: String,
    pub enabled: bool,
}

/// 站点体检里手动启用 / 禁用单站；返回改后的运行快照供前端换缓存。
/// async：`set_site_enabled` 持 entries 写锁写库，别占主线程。
#[tauri::command]
pub async fn site_set_enabled(
    state: tauri::State<'_, ConfigStore>,
    req: SiteSetEnabledRequest,
) -> Result<ConfigSnapshot, AppError> {
    state.set_site_enabled(&req.site_key, req.enabled)
}

/// The active snapshot as the Rust side sees it. The frontend calls this on
/// startup so its localStorage site cache can never disagree with fan-out.
#[tauri::command]
pub fn config_active(state: tauri::State<'_, ConfigStore>) -> Option<ConfigSnapshot> {
    state.active_snapshot()
}

/// async：`remove` 删配置行 + meta 孤儿键，两处 sqlite 写入。
#[tauri::command]
pub async fn config_remove(state: tauri::State<'_, ConfigStore>, id: String) -> Result<(), AppError> {
    state.remove(&id)
}

/// 订阅自动刷新的全局设置 + active 配置的检查狀態。
/// async：读 meta 表，与写路径共用 sqlite 连接。
/// Tauri 约束：带 `State` 引用的 async command 必须返回 Result（Ok 会被解包，前端无感）。
#[tauri::command]
pub async fn config_refresh_settings(
    state: tauri::State<'_, ConfigStore>,
) -> Result<RefreshSettings, AppError> {
    Ok(state.refresh_settings())
}

/// 设置自动刷新间隔（小时，0 = 关闭；上限一周）。返回聚合视图，UI 直接覆盖显示。
/// async：写 meta 表，别占主线程。
#[tauri::command]
pub async fn config_set_refresh_interval(
    state: tauri::State<'_, ConfigStore>,
    hours: u32,
) -> Result<RefreshSettings, AppError> {
    state.set_refresh_interval(hours)
}

/// 手动检查一份订阅（`id` 省略即 active）：设置页「立即检查」与每行的刷新按钮共用。
#[tauri::command]
pub async fn config_refresh(
    state: tauri::State<'_, ConfigStore>,
    id: Option<String>,
) -> Result<RefreshOutcome, AppError> {
    state.refresh(id.as_deref()).await
}

/// async：读 meta 表。Result 包装同上（Tauri async command 约束）。
#[tauri::command]
pub async fn gh_proxy_state(
    state: tauri::State<'_, ConfigStore>,
) -> Result<GhProxyState, AppError> {
    Ok(read_gh_state(&state, 0))
}

/// 切换加速代理。会重写**所有**已存配置里的 GitHub 链接（不只是 active），
/// 否则老配置会继续打旧代理。
/// async：`set_github_proxy` 重写所有已存配置的 sqlite 行，最重的同步写路径。
#[tauri::command]
pub async fn gh_proxy_set(
    state: tauri::State<'_, ConfigStore>,
    prefix: String,
) -> Result<GhProxyState, AppError> {
    let (_, changed) = state.set_github_proxy(&prefix)?;
    Ok(read_gh_state(&state, changed))
}

/// 并发探测全部候选：返回顺序与 `choices()` 一致，UI 直接按下标渲染。
#[tauri::command]
pub async fn gh_proxy_test() -> Vec<ghproxy::ProbeResult> {
    let handles: Vec<_> = ghproxy::choices()
        .into_iter()
        .map(|choice| tokio::spawn(async move { ghproxy::probe(&choice).await }))
        .collect();
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(result) = handle.await {
            results.push(result);
        }
    }
    results
}

// ---- 子模块 ---------------------------------------------------------------
// 命令层留在本文件（Tauri 的 `generate_handler!` 需要宏在同一模块作用域，
// 跨模块 re-export 会把 `__cmd__*` 宏漏掉）；子模块只放实现与 DTO。
mod decrypt;
mod deproxy;
mod derive;
mod edit;
mod github;
mod import;
mod naming;
mod normalize;
mod refresh;

pub(crate) use deproxy::restore as restore_proxied_url;
pub(crate) use derive::blocked_reason;
pub use edit::ConfigEditOutcome;
pub(crate) use normalize::repair_url;
pub use github::GhProxyState;

#[cfg(test)]
mod tests;

/// 导入一份配置：拉取 → 交给 Python 适配层归一化 → 落库并派生运行快照。
/// 实现在 `import` 子模块，这里只做 command 包装（保持注册路径不变）。
#[tauri::command]
pub async fn config_import(
    state: tauri::State<'_, ConfigStore>,
    source: ConfigSource,
) -> Result<ConfigSnapshot, AppError> {
    import::import_config(state, source).await
}
