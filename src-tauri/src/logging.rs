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

/// 按 UTC 日期命名的追加文件。中国用户 08:00 前的日志会落在前一天的文件里，
/// 这对排障足够，也避免了引入时区 crate。
struct DailyFile {
    dir: PathBuf,
    state: Mutex<FileState>,
}

struct FileState {
    date: String,
    file: File,
}

impl DailyFile {
    fn open(dir: &Path) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let date = utc_date();
        let file = open_file(dir, &date)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            state: Mutex::new(FileState { date, file }),
        })
    }

    fn write_line(&self, buf: &[u8]) -> io::Result<()> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let date = utc_date();
        if state.date != date {
            state.date = date.clone();
            state.file = open_file(&self.dir, &date)?;
            prune(&self.dir);
        }
        state.file.write_all(buf)?;
        state.file.flush()
    }
}

fn open_file(dir: &Path, date: &str) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("luma-{date}.log")))
}

/// `fmt` 每写一行都会 clone 一次 writer；用 Arc 共享同一个文件句柄。
struct SharedWriter(Arc<DailyFile>);

impl<'a> fmt::MakeWriter<'a> for SharedWriter {
    type Writer = SharedWriter;

    fn make_writer(&'a self) -> Self::Writer {
        SharedWriter(self.0.clone())
    }
}

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write_line(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("luma-") && name.ends_with(".log"))
                .unwrap_or(false)
        })
        .collect();
    if files.len() <= KEEP_FILES {
        return;
    }
    files.sort();
    for old in &files[..files.len() - KEEP_FILES] {
        let _ = fs::remove_file(old);
    }
}

/// UTC 日期（YYYY-MM-DD）。手写公历换算，避免为文件名引入时间库。
fn utc_date() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant 的 `civil_from_days`：把 1970-01-01 起的天数转成公历。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (y + i64::from(month <= 2), month as u32, day as u32)
}

/// URL 只保留 scheme + host + path：query 里常有 token / 签名，不能落盘。
pub fn redact_url(raw: &str) -> String {
    let trimmed = raw.trim();
    let head = trimmed.split(['?', '#']).next().unwrap_or(trimmed);
    truncate_chars(head, 160)
}

/// 把任意文本里的 http(s) URL 换成脱敏形式；错误信息也走这里。
pub fn sanitize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = find_url(rest) {
        out.push_str(&rest[..index]);
        let tail = &rest[index..];
        let end = tail
            .find(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '\'' | '<' | '>' | ')' | ']'))
            .unwrap_or(tail.len());
        out.push_str(&redact_url(&tail[..end]));
        rest = &tail[end..];
    }
    out.push_str(rest);
    truncate_chars(&out, MAX_CONTEXT)
}

fn find_url(text: &str) -> Option<usize> {
    match (text.find("http://"), text.find("https://")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

fn truncate_chars(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut out: String = value.chars().take(max).collect();
    out.push('…');
    out
}

/// 前端批量写入的一条日志。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLogEntry {
    pub level: String,
    pub message: String,
    #[serde(default)]
    pub context: Option<serde_json::Value>,
}

/// 前端统一日志入口（`src/lib/logger.ts` 批量调用）。
#[tauri::command]
pub fn log_write(entries: Vec<UiLogEntry>) -> Result<(), AppError> {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDiagnostics {
    pub id: String,
    pub name: String,
    pub sites: usize,
    pub enabled: usize,
    pub blocked: usize,
    pub jvm: usize,
    pub quickjs: usize,
    pub lives: usize,
    pub parses: usize,
    pub headers: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub version: &'static str,
    pub os: &'static str,
    pub arch: &'static str,
    pub data_dir: String,
    pub log_dir: String,
    pub db_path: String,
    pub config: Option<ConfigDiagnostics>,
    pub log_files: Vec<LogFileInfo>,
    pub log_bytes: u64,
}

/// 试运行反馈用的一键诊断：版本 / 目录 / 当前配置规模 / 日志文件。
#[tauri::command]
pub fn diagnostics(configs: tauri::State<'_, crate::config::ConfigStore>) -> Diagnostics {
    let data_dir = crate::store::data_dir();
    let (log_files, log_bytes) = log_files();
    Diagnostics {
        version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        db_path: data_dir.join(crate::db::DB_FILE).display().to_string(),
        data_dir: data_dir.display().to_string(),
        log_dir: log_dir().display().to_string(),
        config: config_diagnostics(configs.active_snapshot()),
        log_files,
        log_bytes,
    }
}

fn config_diagnostics(snapshot: Option<crate::config::ConfigSnapshot>) -> Option<ConfigDiagnostics> {
    let snapshot = snapshot?;
    let text = |value: &serde_json::Value, key: &str| -> String {
        value
            .get(key)
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let enabled = snapshot
        .sites
        .iter()
        .filter(|site| site.get("enabled").and_then(|item| item.as_bool()).unwrap_or(true))
        .count();
    let blocked = snapshot
        .sites
        .iter()
        .filter(|site| !text(site, "disabledReason").is_empty())
        .count();
    let jvm = snapshot
        .sites
        .iter()
        .filter(|site| text(site, "runtime") == "jvm")
        .count();
    let quickjs = snapshot
        .sites
        .iter()
        .filter(|site| text(site, "runtime") == "quickjs")
        .count();
    Some(ConfigDiagnostics {
        id: snapshot.id,
        name: snapshot.name,
        sites: snapshot.sites.len(),
        enabled,
        blocked,
        jvm,
        quickjs,
        lives: snapshot.lives.len(),
        parses: snapshot.parses.len(),
        headers: snapshot.headers.len(),
    })
}

fn log_files() -> (Vec<LogFileInfo>, u64) {
    let dir = log_dir();
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|item| item.to_str()) else {
                continue;
            };
            if !(name.starts_with("luma-") && name.ends_with(".log")) {
                continue;
            }
            files.push(LogFileInfo {
                name: name.to_string(),
                bytes: entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    let total = files.iter().map(|file| file.bytes).sum();
    (files, total)
}

/// 打开日志目录，方便试运行用户把文件发给开发者。
#[tauri::command]
pub fn open_log_dir() -> Result<(), AppError> {
    let dir = log_dir();
    fs::create_dir_all(&dir)
        .map_err(|err| AppError::new(code::INTERNAL, "create log dir failed").with_cause(err.to_string()))?;

    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("explorer").arg(&dir).spawn();

    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(&dir).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(&dir).spawn();

    spawned
        .map(|_| ())
        .map_err(|err| AppError::new(code::INTERNAL, "open log dir failed").with_cause(err.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_round_trip_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
        // 2024-02-29（闰日）与 2026-11-11。
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(20_768), (2026, 11, 11));
    }

    #[test]
    fn level_filter_accepts_common_names() {
        assert_eq!(level_filter("debug"), LevelFilter::DEBUG);
        assert_eq!(level_filter("WARN"), LevelFilter::WARN);
        assert_eq!(level_filter("off"), LevelFilter::OFF);
        assert_eq!(level_filter("nonsense"), LevelFilter::INFO);
    }

    #[test]
    fn redact_url_drops_query_and_fragment() {
        assert_eq!(
            redact_url("https://cdn.example.com/a/b.m3u8?token=secret#frag"),
            "https://cdn.example.com/a/b.m3u8"
        );
        assert_eq!(redact_url("  https://x.test/p  "), "https://x.test/p");
    }

    #[test]
    fn sanitize_redacts_urls_inside_text() {
        let raw = "play failed: https://cdn.test/x.m3u8?sign=abc&expires=1 (upstream 503)";
        let out = sanitize(raw);
        assert!(out.contains("https://cdn.test/x.m3u8"));
        assert!(!out.contains("sign=abc"));
        assert!(out.contains("upstream 503"));
    }

    #[test]
    fn truncate_chars_keeps_utf8_boundaries() {
        assert_eq!(truncate_chars("一二三四五", 3), "一二三…");
        assert_eq!(truncate_chars("abc", 5), "abc");
    }

    #[test]
    fn config_diagnostics_counts_runtime_and_blocked() {
        let sites = serde_json::json!([
            {"key": "a", "runtime": "cms", "enabled": true},
            {"key": "b", "runtime": "python", "enabled": true},
            {"key": "c", "runtime": "jvm", "enabled": false, "disabledReason": "android dex"},
            {"key": "d", "runtime": "quickjs", "enabled": false, "disabledReason": "quickjs host"},
            {"key": "e", "runtime": "cms", "enabled": false}
        ]);
        let snapshot: crate::config::ConfigSnapshot = serde_json::from_value(serde_json::json!({
            "id": "cfg",
            "name": "box",
            "importedAt": "2026-11-11",
            "sites": sites,
            "lives": [{"name": "l"}],
            "parses": [{"name": "p"}],
            "headers": [{"host": "h"}]
        }))
        .unwrap();
        let info = config_diagnostics(Some(snapshot)).unwrap();
        assert_eq!(info.sites, 5);
        assert_eq!(info.enabled, 2);
        assert_eq!(info.blocked, 2);
        assert_eq!(info.jvm, 1);
        assert_eq!(info.quickjs, 1);
        assert_eq!(info.lives, 1);
        assert_eq!(info.parses, 1);
        assert_eq!(info.headers, 1);
    }
}
