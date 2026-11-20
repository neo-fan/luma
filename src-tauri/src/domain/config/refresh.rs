use super::derive::{
    apply_manual_disables, content_signature, derive_runtime, ensure_refreshable,
    manual_disabled_keys, refresh_due,
};
use super::import::import_from_source;
use super::*;

impl ConfigStore {
    // ---- 订阅刷新 ----------------------------------------------------------

    pub(super) fn refresh_state(&self, id: &str) -> Option<RefreshState> {
        self.db
            .meta_read(&format!("{META_REFRESH_PREFIX}{id}"))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<RefreshState>(&raw).ok())
    }

    pub(super) fn all_refresh_states(&self) -> std::collections::HashMap<String, RefreshState> {
        let mut out = std::collections::HashMap::new();
        for (key, raw) in self.db.meta_scan(META_REFRESH_PREFIX).unwrap_or_default() {
            let Some(id) = key.strip_prefix(META_REFRESH_PREFIX) else {
                continue;
            };
            if let Ok(state) = serde_json::from_str::<RefreshState>(&raw) {
                out.insert(id.to_string(), state);
            }
        }
        out
    }

    pub(super) fn write_refresh_state(
        &self,
        id: &str,
        state: &RefreshState,
    ) -> Result<(), AppError> {
        let raw = serde_json::to_string(state)?;
        self.db
            .meta_write(&format!("{META_REFRESH_PREFIX}{id}"), &raw)
    }

    /// 当前生效的刷新间隔（小时）；meta 缺失或损坏时回落到默认 12 小时。
    pub fn refresh_interval_hours(&self) -> u32 {
        self.db
            .meta_read(META_REFRESH_INTERVAL)
            .ok()
            .flatten()
            .and_then(|raw| raw.trim().parse::<u32>().ok())
            .unwrap_or(DEFAULT_REFRESH_HOURS)
            .min(MAX_REFRESH_HOURS)
    }

    pub fn refresh_settings(&self) -> RefreshSettings {
        let interval_hours = self.refresh_interval_hours();
        let config_id = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let state = config_id.as_deref().and_then(|id| self.refresh_state(id));
        let next_due_at = match (&config_id, interval_hours) {
            (Some(_), hours) if hours > 0 => {
                let base = state
                    .as_ref()
                    .map(|state| state.checked_at)
                    .filter(|at| *at > 0)
                    .unwrap_or_else(crate::store::now_ms);
                Some(base.saturating_add(u64::from(hours) * 3_600_000))
            }
            _ => None,
        };
        RefreshSettings {
            interval_hours,
            config_id,
            last_checked_at: state
                .as_ref()
                .map(|state| state.checked_at)
                .filter(|at| *at > 0),
            last_changed_at: state.as_ref().and_then(|state| state.changed_at),
            error: state.and_then(|state| state.error),
            next_due_at,
        }
    }

    pub fn set_refresh_interval(&self, hours: u32) -> Result<RefreshSettings, AppError> {
        let clamped = hours.min(MAX_REFRESH_HOURS);
        self.db
            .meta_write(META_REFRESH_INTERVAL, &clamped.to_string())?;
        Ok(self.refresh_settings())
    }

    /// 到期待刷新的配置 id；只考虑 active 且来源为 url 的。
    ///
    /// 后台任务每 60s 调一次，这里只做判定不发请求，保证「关掉自动刷新」
    /// 之后立刻不再有出站流量。
    pub fn due_config_id(&self) -> Option<String> {
        let hours = self.refresh_interval_hours();
        if hours == 0 {
            return None;
        }
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let (id, refreshable) = {
            let guard = self
                .entries
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = pick(active.as_deref(), guard.as_slice())?;
            (entry.imported.id.clone(), entry.source.kind == "url")
        };
        if !refreshable {
            return None;
        }
        let checked_at = self.refresh_state(&id).map(|state| state.checked_at);
        if refresh_due(hours, checked_at, crate::store::now_ms()) {
            Some(id)
        } else {
            None
        }
    }

    /// 重新拉取订阅并比对内容。
    ///
    /// 语义要点：
    ///   * **无变化不写库**，只更新「上次检查」——否则每次定时检查都会整体
    ///     重写 100 站快照，并把 import 时间刷成新的，用户看不出区别却丢了
    ///     手动禁用（虽然这里已经保留，但白写一次仍是浪费）。
    ///   * 内容变化时保留用户改过的名字与站点体检里的手动禁用；
    ///   * `imported_at` 保持首次导入时间，变化时刻单独记 `last_changed_at`。
    pub async fn refresh(&self, id: Option<&str>) -> Result<RefreshOutcome, AppError> {
        let (target_id, imported, runtime, source) = {
            let active = self
                .active
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let guard = self
                .entries
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = match id {
                Some(id) => guard.iter().find(|entry| entry.imported.id == id),
                None => pick(active.as_deref(), guard.as_slice()),
            }
            .ok_or_else(|| {
                AppError::new(code::INVALID_ARGUMENT, "no config available to refresh")
            })?;
            (
                entry.imported.id.clone(),
                entry.imported.clone(),
                runtime_of(entry).clone(),
                entry.source.clone(),
            )
        };
        ensure_refreshable(&source)?;

        let now = crate::store::now_ms();
        let fetched = match import_from_source(source.clone(), &self.github_proxy()).await {
            Ok(snapshot) => snapshot,
            Err(err) => {
                // 失败也要留痕：设置页显示「上次检查失败：…」，用户才知道
                // 为什么站点列表一直没更新。
                let mut state = self.refresh_state(&target_id).unwrap_or_default();
                state.checked_at = now;
                state.error = Some(err.message.clone());
                let _ = self.write_refresh_state(&target_id, &state);
                return Err(err);
            }
        };

        let mut fresh = fetched;
        fresh.id = target_id.clone();
        fresh.name = imported.name.clone();
        fresh.imported_at = imported.imported_at.clone();

        let enabled_of = |snapshot: &ConfigSnapshot| {
            snapshot
                .sites
                .iter()
                .filter(|site| site.get("enabled").and_then(Value::as_bool).unwrap_or(true))
                .count()
        };

        if content_signature(&fresh) == content_signature(&imported) {
            let mut state = self.refresh_state(&target_id).unwrap_or_default();
            state.checked_at = now;
            state.error = None;
            self.write_refresh_state(&target_id, &state)?;
            return Ok(RefreshOutcome {
                config_id: target_id,
                name: fresh.name,
                changed: false,
                sites: runtime.sites.len(),
                enabled: enabled_of(&runtime),
                checked_at: now,
                snapshot: None,
            });
        }

        let mut next_runtime = derive_runtime(&fresh);
        // 手动禁用集必须取「提交时刻」的最新 runtime，并与写回放在**同一个写锁**里：
        // 网络窗口（数秒到数十秒）内用户可能刚点过站点开关，用进函数时克隆的旧快照
        // 会把这次操作重新启用（开关「自己弹回去」）。DB 写同步且不跨 await。
        // active 判定必须在取 entries 写锁**之前**完成（锁序：active → entries）。
        let is_active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_deref()
            == Some(target_id.as_str());
        let headers;
        {
            let mut guard = self
                .entries
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = guard
                .iter_mut()
                .find(|entry| entry.imported.id == target_id)
                .ok_or_else(|| {
                    AppError::new(code::INVALID_ARGUMENT, "配置在刷新期间已被删除")
                })?;
            let manual = manual_disabled_keys(runtime_of(entry));
            apply_manual_disables(&mut next_runtime, &manual);

            headers = next_runtime.headers.clone();
            let imported_json = serde_json::to_string(&fresh)?;
            let runtime_json = serde_json::to_string(&next_runtime)?;
            let source_json = serde_json::to_string(&source)?;
            let write = ConfigWrite {
                id: &target_id,
                name: &fresh.name,
                imported_at: &fresh.imported_at,
                imported_json: &imported_json,
                runtime_json: &runtime_json,
                source_json: &source_json,
            };
            // active 走 activate_config（同 id 再写一次 active，语义不变）；非
            // active 只更新行，绝不因为「顺手刷新」把用户切到别的订阅。
            if is_active {
                self.db.activate_config(write)?;
            } else {
                self.db.update_config(write)?;
            }
            entry.imported = fresh;
            entry.runtime = Some(next_runtime.clone());
            entry.source = source;
        }
        if is_active {
            crate::netrules::replace(&headers);
        }

        let mut state = self.refresh_state(&target_id).unwrap_or_default();
        state.checked_at = now;
        state.changed_at = Some(now);
        state.error = None;
        self.write_refresh_state(&target_id, &state)?;

        Ok(RefreshOutcome {
            config_id: target_id,
            name: next_runtime.name.clone(),
            changed: true,
            sites: next_runtime.sites.len(),
            enabled: enabled_of(&next_runtime),
            checked_at: now,
            snapshot: Some(next_runtime),
        })
    }

    /// 手动启用 / 禁用单个站点（试运行体检用）。
    ///
    /// correctness 红线：只改 runtime 快照，`imported` 一个字段都不碰。手动
    /// 禁用因此只存在于 `runtime_json`：重启时 `load()` 仅在 runtime_json 为
    /// 空时才重新派生，所以禁用能跨重启保留；而重新导入走 `insert` 会重新
    /// `derive_runtime(&imported)`，清掉手动禁用 —— 这是可接受的「换源重来」
    /// 语义。也正因为如此，`derive_runtime(&imported)` 必须始终等于「未手动
    /// 禁用时的 runtime」，手动状态绝不能污染 imported 层。
    pub fn set_site_enabled(
        &self,
        site_key: &str,
        enabled: bool,
    ) -> Result<ConfigSnapshot, AppError> {
        let active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        // 「取当前快照 → 改 → 写库 → 写回」必须在同一个写锁里完成：旧实现先读克隆、
        // 再写库、最后整体覆盖 entry.runtime，两次并发开关（或与 refresh 提交交错）
        // 会各按旧快照写回，后写的把先写的改动静默覆盖 —— 用户看到开关「自己弹回去」。
        // DB 写是同步的（不跨 await），持锁时间只有一次 upsert。
        // 锁序：先取 active（上一步已释放）再取 entries，与 all_sites 等读点一致。
        let mut guard = self
            .entries
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let index = {
            let current = active.as_deref();
            guard
                .iter()
                .position(|entry| current == Some(entry.imported.id.as_str()))
                .or_else(|| guard.len().checked_sub(1))
        }
        .ok_or_else(|| AppError::new(code::INVALID_ARGUMENT, "no active config"))?;
        let entry = &mut guard[index];
        let imported = entry.imported.clone();
        let mut runtime = runtime_of(entry).clone();
        let source = entry.source.clone();

        let mut found = false;
        for site in runtime.sites.iter_mut() {
            if site.get("key").and_then(Value::as_str) != Some(site_key) {
                continue;
            }
            // 屏蔽源（当前只有 jar / Android dex）不允许手动打开，否则会把
            // 不支持的站点放回 fan-out；JS 源已解禁，禁用则始终允许。
            if enabled && blocked_reason(site).is_some() {
                return Err(AppError::new(
                    code::INVALID_ARGUMENT,
                    "该源不受支持，无法启用",
                ));
            }
            if let Some(map) = site.as_object_mut() {
                if enabled {
                    map.remove("disabledReason");
                    map.insert("enabled".into(), Value::Bool(true));
                } else {
                    map.insert("enabled".into(), Value::Bool(false));
                    map.insert(
                        "disabledReason".into(),
                        Value::String(MANUAL_DISABLE_REASON.into()),
                    );
                }
            }
            found = true;
            break;
        }
        if !found {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                format!("site {site_key} not found"),
            ));
        }

        // `imported` 不参与任何改写：仅按原样回写，与改后的 runtime 一起提交。
        // 单站禁用不动配置级 headers[]，所以不刷 netrules。
        let imported_json = serde_json::to_string(&imported)?;
        let runtime_json = serde_json::to_string(&runtime)?;
        let source_json = serde_json::to_string(&source)?;
        self.db.update_config(ConfigWrite {
            id: &imported.id,
            name: &imported.name,
            imported_at: &imported.imported_at,
            imported_json: &imported_json,
            runtime_json: &runtime_json,
            source_json: &source_json,
        })?;
        // 同一个写锁内写回（不是只改 sites 字段）；不碰 active marker。
        entry.runtime = Some(runtime.clone());
        // 返回改后的运行快照，前端 onImported(snapshot) 换掉站点缓存，
        // 让 fan-out 立即生效。
        Ok(runtime)
    }
}
