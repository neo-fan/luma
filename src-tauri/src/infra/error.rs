//! 统一错误类型（规格书 6.3 / 7.2）。
//!
//! 所有 command 返回 `Result<T, AppError>`；序列化后与前端 `AppError`、
//! Python error 帧保持同名字段（v1.1 R8：以 `contracts/luma.schema.json` 为真源）。

use serde::Serialize;
use std::fmt;

/// 错误码常量。新增错误码须同步 6.3 表格、`contracts/luma.schema.json` 与前端类型。
pub mod code {
    pub const CONFIG_FETCH_FAIL: &str = "CONFIG_FETCH_FAIL";
    pub const CONFIG_DECRYPT_FAIL: &str = "CONFIG_DECRYPT_FAIL";
    pub const DIALECT_UNKNOWN: &str = "DIALECT_UNKNOWN";
    pub const SITE_TIMEOUT: &str = "SITE_TIMEOUT";
    pub const SPIDER_CRASH: &str = "SPIDER_CRASH";
    pub const RUNTIME_UNAVAILABLE: &str = "RUNTIME_UNAVAILABLE";
    pub const RUNTIME_RESTART: &str = "RUNTIME_RESTART";
    pub const PLAY_RESOLVE_FAIL: &str = "PLAY_RESOLVE_FAIL";
    pub const SIGNATURE_MISMATCH: &str = "SIGNATURE_MISMATCH";
    pub const INVALID_ARGUMENT: &str = "INVALID_ARGUMENT";
    pub const INTERNAL: &str = "INTERNAL";
}

/// 跨 IPC 的错误载荷。字段名与前端 `AppError` 一一对应。
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    /// 原始配置是否已留存，便于诊断（7.2 错误帧）
    #[serde(rename = "rawSaved", skip_serializing_if = "Option::is_none")]
    pub raw_saved: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            cause: None,
            raw_saved: None,
            details: None,
        }
    }

    pub fn with_cause(mut self, cause: impl Into<String>) -> Self {
        self.cause = Some(cause.into());
        self
    }

    pub fn with_raw_saved(mut self, saved: bool) -> Self {
        self.raw_saved = Some(saved);
        self
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn from_io(code: impl Into<String>, message: impl Into<String>, err: &std::io::Error) -> Self {
        Self::new(code, message).with_cause(err.to_string())
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::new(code::INTERNAL, "json 序列化失败").with_cause(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case_raw_saved() {
        let value = serde_json::to_value(
            AppError::new(code::DIALECT_UNKNOWN, "unknown dialect").with_raw_saved(true),
        )
        .expect("serialize");
        assert_eq!(value["code"], "DIALECT_UNKNOWN");
        assert_eq!(value["rawSaved"], true);
        assert!(value.get("cause").is_none());
    }

    #[test]
    fn display_contains_code_and_message() {
        let err = AppError::new(code::SITE_TIMEOUT, "15s timeout");
        assert_eq!(err.to_string(), "SITE_TIMEOUT: 15s timeout");
    }
}
