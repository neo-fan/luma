//! 编辑已导入订阅：改名、换地址。
//!
//! 「换地址」不是改一个字符串：站点、直播、解析、headers 全部来自那份配置，
//! 所以必须按新地址重新走一遍导入，再原地替换同一行。三条硬约束：
//!
//!   1. **行身份不变**：`id` / 首次 `importedAt` / 用户起的名字都保留。id 是收藏
//!      与播放记录的关联键，换地址不能把它们指向一条不存在的配置。`refresh`
//!      对回拉结果也做同样的事（`fresh.id = target_id`），这里沿用同一语义。
//!   2. **失败不动旧数据**：拉取或解析失败直接返回错误，旧行一个字段都不改。
//!   3. **不抢 active**：编辑一份后台订阅不能把用户当前正在用的站点换掉；只有
//!      被编辑的正是 active 时才回写 netrules 并把新快照交给前端换缓存。

use super::derive::{apply_manual_disables, derive_runtime, manual_disabled_keys};
use super::*;

/// 编辑结果。`snapshot` 只在被编辑的订阅就是 active 时有值——后台订阅没有
/// 「当前站点缓存」可换，前端拿到 None 就只刷新列表。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEditOutcome {
    pub meta: ConfigMeta,
    #[serde(default)]
    pub snapshot: Option<ConfigSnapshot>,
}

impl ConfigStore {
    /// 编辑一份订阅。`name` / `url` 都是「没给就不动」；`url` 与原地址相同
    /// 等价于只改名，不会产生一次网络请求。
    pub async fn edit(
        &self,
        id: &str,
        name: Option<&str>,
        url: Option<&str>,
    ) -> Result<ConfigEditOutcome, AppError> {
        let (imported, runtime, source) = {
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

        let next_name = match name {
            Some(raw) => {
                let cleaned = clean_name(raw);
                if cleaned.is_empty() {
                    return Err(AppError::new(
                        code::INVALID_ARGUMENT,
                        "config name is empty",
                    ));
                }
                cleaned
            }
            None => imported.name.clone(),
        };
        let next_source = match url {
            Some(raw) => Some(self.prepare_source(id, raw)?),
            None => None,
        };

        // 地址没变（未提供，或归一化后与原值一致）→ 纯改名，复用 rename：
        // 它已经处理了双快照同步与「不切 active」。
        let address_changed = next_source
            .as_ref()
            .is_some_and(|candidate| candidate.value != source.value);
        if !address_changed {
            let meta = self.rename(id, &next_name)?;
            return Ok(ConfigEditOutcome {
                meta,
                snapshot: None,
            });
        }
        let next_source = next_source.expect("address_changed implies a source");

        // 拉取放在锁外：网络窗口内用户可能正在开关站点或刷新同一份订阅，
        // 持锁等一次 HTTP 会把整个配置列表卡住。
        let fetched = import::import_from_source(next_source.clone(), &self.github_proxy()).await?;

        let mut fresh = fetched;
        // 行身份以本地为准：新地址算出的 id 只代表"这份内容从哪来"，不代表
        // 它是另一行（否则收藏/历史会断掉，用户也会莫名其妙多出一份配置）。
        fresh.id = id.to_string();
        fresh.imported_at = imported.imported_at.clone();
        fresh.name = next_name.clone();
        let mut next_runtime = derive_runtime(&fresh);
        // 换地址后站点 key 大概率重合：用户手动禁掉的慢源/死源继续禁着，
        // 与订阅刷新保持同一套语义。
        apply_manual_disables(&mut next_runtime, &manual_disabled_keys(&runtime));

        // 锁序：先 active 再 entries（与 all_sites / refresh 一致）。
        let is_active = self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_deref()
            == Some(id);
        let headers = next_runtime.headers.clone();
        {
            let mut guard = self
                .entries
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = guard
                .iter_mut()
                .find(|entry| entry.imported.id == id)
                .ok_or_else(|| {
                    AppError::new(code::INVALID_ARGUMENT, "配置在编辑期间已被删除")
                })?;
            // 等待拉取期间别的东西改了地址（另一端的编辑 / 刷新写入）：以对方的
            // 结果为准，让用户重试，避免"后提交的悄悄覆盖先提交的"。
            if entry.source.value != source.value {
                return Err(AppError::new(
                    code::INVALID_ARGUMENT,
                    "订阅地址在编辑期间已被修改，请重试",
                ));
            }

            let imported_json = serde_json::to_string(&fresh)?;
            let runtime_json = serde_json::to_string(&next_runtime)?;
            let source_json = serde_json::to_string(&next_source)?;
            let write = ConfigWrite {
                id,
                name: &fresh.name,
                imported_at: &fresh.imported_at,
                imported_json: &imported_json,
                runtime_json: &runtime_json,
                source_json: &source_json,
            };
            // 与 refresh 同一判定：active 才动 active marker，其余只更新行。
            if is_active {
                self.db.activate_config(write)?;
            } else {
                self.db.update_config(write)?;
            }
            entry.imported = fresh;
            entry.runtime = Some(next_runtime.clone());
            entry.source = next_source;
        }
        if is_active {
            crate::netrules::replace(&headers);
        }

        // 换地址本身即一次内容变化：刷新状态按「刚检查过且已变更」记，
        // 否则下一分钟的定时任务会把同一份配置再拉一遍。
        let now = crate::store::now_ms();
        let _ = self.write_refresh_state(
            id,
            &RefreshState {
                checked_at: now,
                changed_at: Some(now),
                error: None,
            },
        );

        let meta = self.meta_by_id(id).ok_or_else(|| {
            AppError::new(code::INVALID_ARGUMENT, format!("config {id} not found"))
        })?;
        Ok(ConfigEditOutcome {
            meta,
            snapshot: is_active.then_some(next_runtime),
        })
    }

    /// 校验并归一化用户输入的新地址。归一化与导入路径共用同一函数：内置加速
    /// 前缀会被剥成裸地址，否则同一份配置"带前缀再填一次"就成了第二个地址。
    fn prepare_source(&self, id: &str, raw: &str) -> Result<ConfigSource, AppError> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                "订阅地址不能为空",
            ));
        }
        if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                "订阅地址必须以 http:// 或 https:// 开头",
            ));
        }
        let candidate = import::normalize_source(ConfigSource {
            kind: "url".into(),
            value: trimmed.to_string(),
            name: None,
        });
        // 同一个地址存两行只会让"自动刷新"与"重新导入"各自命中不同行。
        let guard = self
            .entries
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(other) = guard
            .iter()
            .find(|entry| entry.imported.id != id && entry.source.value == candidate.value)
        {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                format!("该地址已是订阅「{}」的地址", other.imported.name),
            ));
        }
        Ok(candidate)
    }
}
