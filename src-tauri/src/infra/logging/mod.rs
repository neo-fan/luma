//! 试运行日志：stdout + 每日文件双写，级别由 `LUMA_LOG` 控制。
//!
//! 设计取舍：
//! - 不引入 `tracing-appender` / `env-filter`，自己实现按 UTC 日期滚动的
//!   writer 与级别解析，依赖树只多一个 `tracing-subscriber`；
//! - 文件写在 `<data dir>/logs/luma-YYYY-MM-DD.log`，保留最近 7 天，启动时
//!   与跨天时各清理一次；便携版随 `data/` 一起走，卸载即删；
//! - 日志会被用户直接发给开发者做试运行反馈，所以 URL 一律脱敏（去 query /
//!   fragment、截断 160 字符），前端写日志时也会在 Rust 侧再过一遍；
//! - `tracing::*` 宏在 `init()` 之前调用会被丢弃，因此 `run()` 第一件事就是
//!   初始化日志，早于 SQLite 迁移与 sidecar 探测。

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::fmt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

use crate::error::{code, AppError};

/// 保留最近 7 个日志文件（按日期命名，字典序即时间序）。
const KEEP_FILES: usize = 7;
const MAX_MESSAGE: usize = 2000;
const MAX_CONTEXT: usize = 4000;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 日志目录：与 SQLite 同级的 `logs/`，便携版跟着 `data/` 走。
pub fn log_dir() -> PathBuf {
    LOG_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| crate::store::data_dir().join("logs"))
}

/// 初始化全局日志。重复调用是安全的（`try_init` 失败后继续用已有订阅者）。
pub fn init() {
    let dir = crate::store::data_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    let _ = LOG_DIR.set(dir.clone());
    prune(&dir);

    let filter = level_filter(&crate::env::get("LOG").unwrap_or_default());
    let stdout_layer = fmt::layer()
        .with_ansi(true)
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(false);
    let file_layer = DailyFile::open(&dir).ok().map(|file| {
        fmt::layer()
            .with_ansi(false)
            .with_target(true)
            .with_writer(SharedWriter(Arc::new(file)))
    });

    let registry = tracing_subscriber::registry().with(filter).with(stdout_layer);
    // 两个分支的 Layered 类型不同，各自独立 try_init；订阅者只能装一次，
    // 第二次失败（例如测试里重复 init）不会影响已有输出。
    if let Some(layer) = file_layer {
        let _ = registry.with(layer).try_init();
    } else {
        let _ = registry.try_init();
    }

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        data_dir = %crate::store::data_dir().display(),
        log_dir = %dir.display(),
        "luma starting"
    );
}

fn level_filter(raw: &str) -> LevelFilter {
    match raw.trim().to_ascii_lowercase().as_str() {
        "trace" => LevelFilter::TRACE,
        "debug" => LevelFilter::DEBUG,
        "warn" | "warning" => LevelFilter::WARN,
        "error" => LevelFilter::ERROR,
        "off" | "none" => LevelFilter::OFF,
        _ => LevelFilter::INFO,
    }
}

// ---- 命令层 ---------------------------------------------------------------
// 命令留在 `mod.rs`（与 `domain/config` 同款），子模块只放实现，避免
// `#[tauri::command]` 生成的 `__cmd__*` 需要跨模块再导出。

/// 前端统一日志入口（`src/lib/logger.ts` 批量调用）。
#[tauri::command]
pub fn log_write(entries: Vec<UiLogEntry>) -> Result<(), AppError> {
    ui::write_entries(entries)
}

/// 试运行反馈用的一键诊断：版本 / 目录 / 当前配置规模 / 日志文件。
#[tauri::command]
pub fn diagnostics(configs: tauri::State<'_, crate::config::ConfigStore>) -> Diagnostics {
    diagnostics::collect(configs)
}

/// 打开日志目录，方便试运行用户把文件发给开发者。
#[tauri::command]
pub fn open_log_dir() -> Result<(), AppError> {
    diagnostics::open_dir()
}

/// 把诊断 + 日志尾部写成一个纯文本反馈文件，并在资源管理器里选中。
///
/// 试运行阶段让用户「发我日志目录」沟通成本太高：一个文件既包含版本/目录/
/// 配置规模，也带最近日志，直接拖进聊天窗口就行。不做 zip，避免为一个
/// 辅助功能引入压缩依赖。
#[tauri::command]
pub fn export_report(configs: tauri::State<'_, crate::config::ConfigStore>) -> Result<String, AppError> {
    report::write_report(configs)
}

/// 在系统文件管理器里定位到某个路径（Windows 用 `/select,` 选中文件）。
fn reveal(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    let spawned = if path.is_dir() {
        std::process::Command::new("explorer").arg(path).spawn()
    } else {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
    };

    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg("-R").arg(path).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open")
        .arg(if path.is_dir() {
            path.to_path_buf()
        } else {
            path.parent().unwrap_or(path).to_path_buf()
        })
        .spawn();

    spawned
        .map(|_| ())
        .map_err(|err| AppError::new(code::INTERNAL, "reveal path failed").with_cause(err.to_string()))
}

// ---- 子模块 ---------------------------------------------------------------
// 双写用 `writer`，脱敏规则在 `redact`，诊断与反馈文件各占一个文件；`mod.rs`
// 只留目录解析、初始化、级别解析与命令层。
mod diagnostics;
mod redact;
mod report;
mod ui;
mod writer;

pub use diagnostics::{ConfigDiagnostics, Diagnostics, LogFileInfo};
pub use redact::{redact_url, sanitize};
pub use ui::UiLogEntry;

use redact::truncate_chars;
use writer::*;

#[cfg(test)]
mod tests;
