//! 诊断/反馈文件的命令层（domain 侧）。
//!
//! 为什么不在 `infra/logging`：那两个命令要读 `ConfigStore`（domain 类型）。
//! 分层方向是 domain → infra，底座反过来认识业务类型会让 infra 无法独立复用
//! 与单测（2026-11-16 评审 P1）。infra 侧只留「中性摘要 → 诊断结构」的纯逻辑
//! （`logging::diagnostics::collect`），这里负责把 `ConfigSnapshot` 折算成
//! `logging::ConfigDigest` 再交下去。
//!
//! 命令名不变（`diagnostics` / `export_report`）：`generate_handler!` 用的是
//! 函数名，前端 `invoke("diagnostics")` 不受搬迁影响。

use crate::config::ConfigSnapshot;
use crate::logging::{self, Diagnostics};
use crate::AppError;

/// 快照 → 诊断摘要：只取统计要用的字段与长度，不做深拷贝之外的加工。
fn digest(snapshot: Option<ConfigSnapshot>) -> Option<logging::ConfigDigest> {
    let snapshot = snapshot?;
    Some(logging::ConfigDigest {
        id: snapshot.id,
        name: snapshot.name,
        sites: snapshot.sites,
        lives: snapshot.lives.len(),
        parses: snapshot.parses.len(),
        headers: snapshot.headers.len(),
    })
}

/// 试运行反馈用的一键诊断：版本 / 目录 / 当前配置规模 / 日志文件。
///
/// async：`active_snapshot()` 是整份快照深拷贝 + 逐日志文件统计，同步命令会跑在
/// 主线程上。改 async 后由 Tauri 调度到 runtime（返回 Result 是借用 State 的要求）。
#[tauri::command]
pub async fn diagnostics(
    configs: tauri::State<'_, crate::config::ConfigStore>,
) -> Result<Diagnostics, AppError> {
    Ok(logging::diagnostics::collect(digest(configs.active_snapshot())))
}

/// 把诊断 + 日志尾部写成一个纯文本反馈文件，并在资源管理器里选中。
/// `write_report` 已经给出带 code 的 `AppError`，这里不再二次包装。
#[tauri::command]
pub async fn export_report(
    configs: tauri::State<'_, crate::config::ConfigStore>,
) -> Result<String, AppError> {
    logging::report::write_report(digest(configs.active_snapshot()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn digest_counts_collection_lengths_not_contents() {
        let snapshot: ConfigSnapshot = serde_json::from_value(json!({
            "id": "cfg-1",
            "name": "box",
            "importedAt": "2026-11-16",
            "sites": [{ "key": "a" }, { "key": "b" }],
            "lives": [{ "name": "l" }, { "name": "l2" }, { "name": "l3" }],
            "parses": [{ "name": "p" }],
            "headers": [{ "host": "h" }]
        }))
        .expect("snapshot");
        let digest = digest(Some(snapshot)).expect("digest");
        assert_eq!(digest.id, "cfg-1");
        assert_eq!(digest.name, "box");
        assert_eq!(digest.sites.len(), 2);
        assert_eq!(digest.lives, 3);
        assert_eq!(digest.parses, 1);
        assert_eq!(digest.headers, 1);
    }

    #[test]
    fn digest_of_none_is_none() {
        assert!(digest(None).is_none());
    }

    #[test]
    fn digest_feeds_diagnostics_counts_end_to_end() {
        // 跨层链路的收口验证：domain 折算 → infra 统计，口径与搬迁前一致。
        let snapshot: ConfigSnapshot = serde_json::from_value(json!({
            "id": "cfg-2",
            "name": "box",
            "importedAt": "2026-11-16",
            "sites": [
                { "key": "a", "runtime": "cms", "enabled": true },
                { "key": "b", "runtime": "jvm", "enabled": false, "disabledReason": "android dex" }
            ],
            "lives": [],
            "parses": [],
            "headers": []
        }))
        .expect("snapshot");
        let info = logging::diagnostics::config_diagnostics(digest(Some(snapshot))).expect("info");
        assert_eq!(info.sites, 2);
        assert_eq!(info.enabled, 1);
        assert_eq!(info.blocked, 1);
        assert_eq!(info.jvm, 1);
    }
}
