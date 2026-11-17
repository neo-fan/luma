use super::derive::runtime_of;
use super::*;

impl ConfigStore {
    /// 当前生效的 GitHub 加速前缀（空串 = 直连）。
    ///
    /// meta 里没有这条记录 = 用户从未选过 → 用内置默认。必须区分「没设置」
    /// 与「设置为直连」：后者明确存了空串，不能再被默认值覆盖。
    pub fn github_proxy(&self) -> String {
        match self.db.meta_read(ghproxy::META_KEY) {
            Ok(Some(saved)) => ghproxy::normalize_prefix(&saved).unwrap_or_default(),
            // 读库失败按「没设置」处理，用默认代理——总比让用户面对一堆
            // 超时的 GitHub 链接强。
            _ => ghproxy::DEFAULT_PROXY.to_string(),
        }
    }

    /// 切换加速前缀，并把**所有已存配置**（不只是 active）重写一遍。
    ///
    /// 已导入的配置里 URL 是写死的前缀，只改 meta 不会让老配置动起来；
    /// 反过来，如果不重写就切换，旧配置会继续打旧代理。`rewrite_snapshot`
    /// 是「先剥后套」，所以反复调用同向前缀不会累积成多层嵌套。
    ///
    /// 返回 `(改写链接数, 受影响配置数)`；返回值给 UI 显示，避免「切换了
    /// 但不知道有没有生效」。
    pub fn set_github_proxy(&self, raw_prefix: &str) -> Result<(usize, usize), AppError> {
        let prefix = ghproxy::normalize_prefix(raw_prefix)?;
        self.db.meta_write(ghproxy::META_KEY, &prefix)?;

        // 两阶段：先离锁算出要写什么、逐行落库，再一次性换内存。持 entries
        // 写锁去写 SQLite 会让「读列表」被一次全量重写卡住。
        let planned: Vec<(ConfigSnapshot, ConfigSnapshot, ConfigSource)> = {
            let guard = self
                .entries
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard
                .iter()
                .filter_map(|entry| {
                    let mut imported = entry.imported.clone();
                    let mut runtime = runtime_of(entry).clone();
                    // runtime 不能从 imported 重新派生：手动禁用只写在 runtime
                    // 上，重派生会把它们复活。两边各自改写即可。
                    let changed = ghproxy::rewrite_snapshot(&mut imported, &prefix)
                        + ghproxy::rewrite_snapshot(&mut runtime, &prefix);
                    (changed > 0).then(|| (imported, runtime, entry.source.clone()))
                })
                .collect()
        };

        let mut links = 0;
        for (imported, runtime, source) in &planned {
            let imported_json = serde_json::to_string(imported)?;
            let runtime_json = serde_json::to_string(runtime)?;
            let source_json = serde_json::to_string(source)?;
            self.db.update_config(ConfigWrite {
                id: &imported.id,
                name: &imported.name,
                imported_at: &imported.imported_at,
                imported_json: &imported_json,
                runtime_json: &runtime_json,
                source_json: &source_json,
            })?;
            links += ghproxy::count_github(imported);
        }

        let configs = planned.len();
        let mut active_headers = None;
        if configs > 0 {
            let mut guard = self
                .entries
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            for (imported, runtime, source) in planned {
                if let Some(entry) = guard.iter_mut().find(|e| e.imported.id == imported.id) {
                    entry.imported = imported;
                    entry.runtime = Some(runtime);
                    entry.source = source;
                }
            }
            // 别在这里调 `active_snapshot()`：它内部要 entries 读锁，而本线程
            // 正握着写锁 —— std RwLock 不可重入，会直接把自己锁死（踩过：
            // 进程启动后日志停在 netrules loaded，窗口永远不出来）。
            let active_id = self
                .active
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            active_headers = guard
                .iter()
                .find(|entry| active_id.as_deref() == Some(entry.imported.id.as_str()))
                .map(|entry| runtime_of(entry).headers.clone());
        }
        // 反代表是 active 配置派生出来的，域名头随配置内容走。
        if let Some(headers) = active_headers {
            crate::netrules::replace(&headers);
        }
        Ok((links, configs))
    }

    /// 启动时对齐一次：老配置（上次运行导入、当时还是直连）也要跟上当前
    /// 前缀。幂等，正常情况什么都不写。
    pub fn sync_github_proxy(&self) -> Result<(usize, usize), AppError> {
        let prefix = self.github_proxy();
        self.set_github_proxy(&prefix)
    }

    /// 全部已存配置里的 GitHub 链接数（去重后按配置累加，供设置页展示）。
    pub fn github_link_count(&self) -> usize {
        self.entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|entry| ghproxy::count_github(&entry.imported))
            .sum()
    }
}

/// 设置页「GitHub 加速」的完整状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhProxyState {
    /// 当前生效前缀；空串 = 直连。
    pub prefix: String,
    pub choices: Vec<ghproxy::ProxyChoice>,
    /// 全部配置里不重复的 GitHub 链接数。
    pub links: usize,
    /// 已有配置总数。
    pub configs: usize,
    /// 本次切换实际改写的配置数（只读查询时为 0）。
    pub changed: usize,
    /// active 配置的运行快照。URL 被改写后前端缓存里的 ext/parse 地址已经
    /// 过期，必须整份替换，不能只提示「已切换」。
    pub snapshot: Option<ConfigSnapshot>,
}

pub(crate) fn read_gh_state(state: &ConfigStore, changed: usize) -> GhProxyState {
    GhProxyState {
        prefix: state.github_proxy(),
        choices: ghproxy::choices(),
        links: state.github_link_count(),
        configs: state.list().len(),
        changed,
        snapshot: state.active_snapshot(),
    }
}
