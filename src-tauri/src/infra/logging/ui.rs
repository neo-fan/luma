use super::*;

/// 前端批量写入的一条日志。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLogEntry {
    pub level: String,
    pub message: String,
    #[serde(default)]
    pub context: Option<serde_json::Value>,
}

/// 逐条脱敏后转成 `tracing` 事件（命令层在 `mod.rs`）。
pub(super) fn write_entries(entries: Vec<UiLogEntry>) -> Result<(), AppError> {
    for entry in entries.into_iter().take(100) {
        let message = sanitize(&truncate_chars(&entry.message, MAX_MESSAGE));
        let context = entry
            .context
            .map(|value| sanitize(&truncate_chars(&value.to_string(), MAX_CONTEXT)))
            .unwrap_or_default();
        match entry.level.to_ascii_lowercase().as_str() {
            "debug" => tracing::debug!(target: "ui", context = %context, message = %message),
            "warn" => tracing::warn!(target: "ui", context = %context, message = %message),
            "error" => tracing::error!(target: "ui", context = %context, message = %message),
            _ => tracing::info!(target: "ui", context = %context, message = %message),
        }
    }
    Ok(())
}
