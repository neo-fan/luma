//! 试运行日志：stdout + 每日文件，按用途分三个通道（宿主 / 前端 / 适配层）。
//!
//! 目录结构（`<data dir>/logs/`，便携版随 `data/` 一起走，卸载即删）：
//!
//! ```text
//! logs/
//!   app/luma.2026-11-15.log       宿主（Rust）：网络、数据库、播放、配置导入
//!   ui/ui.2026-11-15.log          前端（React，`target: "ui"`）
//!   spider/spider.2026-11-15.log  适配层（Python sidecar）
//! ```
//!
//! 为什么分三个文件：排障时经常只需要其中一类（「前端报错但后端没动静」和
//! 「某个源崩了」完全是两条线），混在一个文件里既难 grep 又会互相淹没；三者
//! 的写入方本来就不同（`tracing` / `tracing` / Python），各持自己的句柄更简单。
//!
//! 其他取舍：
//! - 滚动与过滤用官方库：`tracing-appender`（`Rotation::DAILY` +
//!   `max_log_files`）与 `EnvFilter`；前端通道靠 `Targets` 只放 `target: "ui"`；
//! - 每个通道保留最近 7 份，按 UTC 日期命名（与 `tracing-appender` 的规则一致）；
//! - 日志会被用户直接发给开发者做试运行反馈，所以 URL 一律脱敏（去 query /
//!   fragment、截断 160 字符）。脱敏点统一在 `CappedWriter::write`——宿主与
//!   前端两个通道都经过它，任何新增日志默认就是安全的（前端再调一次
//!   `sanitize` 只是幂等重复）。适配层由 Python 自己写句柄，不受这道闸约束，
//!   那边约定 traceback 落盘前不带签名 query；
//! - `tracing::*` 宏在 `init()` 之前调用会被丢弃，因此 `run()` 第一件事就是
//!   初始化日志，早于 SQLite 迁移与 sidecar 探测。

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::fmt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::error::{code, AppError};

/// 每个通道保留最近 7 份日志。
const KEEP_FILES: usize = 7;
/// 每个通道的硬上限：超过就删最旧的一整天，而不是去切正在写的文件。
///
/// 10 MiB 的来由：桌面客户端的日活日志量通常在几十 KB 到几 MB 之间，10 MiB
/// 足够覆盖一次重度排障（几百个源扇出 + 播放重试），三个通道加起来也不超过
/// 30 MiB；纯文本日志压到 zip 里通常只有十分之一，用户发反馈文件没有负担。
/// 业内（logrotate / log4j / python logging）常见组合就是「按天滚 + 单文件
/// 5–20 MB + 保留 7 份」，这里取整到 10 MiB。
const MAX_CHANNEL_BYTES: u64 = 10 * 1024 * 1024;
const MAX_MESSAGE: usize = 2000;
const MAX_CONTEXT: usize = 4000;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
/// `non_blocking` 的后台写线程只在这两个 guard 存活时工作；进程退出时 drop
/// 它们，队列里剩下的日志才会 flush。放进 `static` 是为了活到进程结束。
static LOG_GUARDS: OnceLock<(WorkerGuard, WorkerGuard)> = OnceLock::new();

/// 日志通道：写入方不同，各自一个目录、各自滚动与保留。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    /// 宿主进程（Rust）：网络、数据库、播放、配置导入等。
    App,
    /// 前端（React）：`tracing` target 固定为 `ui`（`log_write` 命令写入）。
    Ui,
    /// 适配层（Python sidecar）：第三方源脚本的运行记录。
    Spider,
}

impl Channel {
    /// 目录名，同时也是诊断/反馈文件里的类别标识。
    pub fn dir_name(self) -> &'static str {
        match self {
            Channel::App => "app",
            Channel::Ui => "ui",
            Channel::Spider => "spider",
        }
    }

    /// 文件名前缀（`<prefix>.<UTC 日期>.log`）。
    fn file_prefix(self) -> &'static str {
        match self {
            Channel::App => "luma",
            Channel::Ui => "ui",
            Channel::Spider => "spider",
        }
    }

    const ALL: [Channel; 3] = [Channel::App, Channel::Ui, Channel::Spider];
}

/// 日志根目录：与 SQLite 同级的 `logs/`，便携版跟着 `data/` 走。
pub fn log_dir() -> PathBuf {
    LOG_DIR
        .get()
        .cloned()
        .unwrap_or_else(|| crate::store::data_dir().join("logs"))
}

/// 某个通道的目录。
pub fn channel_dir(channel: Channel) -> PathBuf {
    log_dir().join(channel.dir_name())
}

/// 当天（UTC）的通道文件路径。宿主自己的两个通道由 `tracing-appender` 按同
/// 一命名规则创建；适配层的路径由宿主注入给 Python（`LUMA_ADAPTER_LOG`）。
pub fn channel_file(channel: Channel) -> PathBuf {
    channel_dir(channel).join(format!("{}.{}.log", channel.file_prefix(), utc_date()))
}

/// 适配层日志路径（`bridge` 在 spawn Python 时注入 `LUMA_ADAPTER_LOG`）。
pub fn spider_log_path() -> PathBuf {
    channel_file(Channel::Spider)
}

/// 初始化全局日志。重复调用是安全的（`try_init` 失败后继续用已有订阅者）。
pub fn init() {
    let dir = crate::store::data_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    for channel in Channel::ALL {
        let _ = fs::create_dir_all(dir.join(channel.dir_name()));
    }
    let _ = LOG_DIR.set(dir.clone());

    // 1.0.3 之前所有日志平铺在 `logs/` 根下；升级后搬到对应通道目录，避免
    // 用户看到「新旧两套目录」而误以为丢了日志。
    migrate_legacy(&dir);
    prune_spider(&dir);

    match (appender(&dir, Channel::App), appender(&dir, Channel::Ui)) {
        (Ok(app), Ok(ui)) => {
            let app = CappedWriter::new(
                app,
                dir.join(Channel::App.dir_name()),
                Channel::App.file_prefix(),
            );
            let ui = CappedWriter::new(
                ui,
                dir.join(Channel::Ui.dir_name()),
                Channel::Ui.file_prefix(),
            );
            let (app_writer, app_guard) = tracing_appender::non_blocking(app);
            let (ui_writer, ui_guard) = tracing_appender::non_blocking(ui);
            let _ = LOG_GUARDS.set((app_guard, ui_guard));
            let _ = tracing_subscriber::registry()
                .with(env_filter())
                .with(stdout_layer())
                .with(file_layer(app_writer, Channel::App))
                .with(file_layer(ui_writer, Channel::Ui))
                .try_init();
        }
        (app, ui) => {
            // 日志目录不可写（只读介质、权限异常）不能拖垮启动：退化成 stdout。
            for err in [app.err(), ui.err()].into_iter().flatten() {
                eprintln!("luma: file logging disabled: {err}");
            }
            let _ = tracing_subscriber::registry()
                .with(env_filter())
                .with(stdout_layer())
                .try_init();
        }
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

fn appender(
    dir: &Path,
    channel: Channel,
) -> Result<RollingFileAppender, tracing_appender::rolling::InitError> {
    RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(channel.file_prefix())
        .filename_suffix("log")
        .max_log_files(KEEP_FILES)
        .build(dir.join(channel.dir_name()))
}

/// 给 appender 套一层容量上限。
///
/// `tracing-appender` 只按时间滚动、没有按大小切分的开关（上游 issue
/// [#2497](https://github.com/tokio-rs/tracing/pull/2497) 还没合），所以容量
/// 上限由我们自己守：写入累计超过 [`MAX_CHANNEL_BYTES`] 就删掉该通道最旧的
/// 整天文件，而不是去切一个正在被追加的句柄（切活跃文件会丢行、还要处理
/// 句柄重开）。删完整文件既安全又和「按天保留」的语义一致。
struct CappedWriter {
    inner: RollingFileAppender,
    dir: PathBuf,
    prefix: &'static str,
    written: AtomicU64,
    pruning: AtomicBool,
}

impl CappedWriter {
    fn new(inner: RollingFileAppender, dir: PathBuf, prefix: &'static str) -> Self {
        let written = dir_bytes(&dir, prefix);
        Self {
            inner,
            dir,
            prefix,
            written: AtomicU64::new(written),
            pruning: AtomicBool::new(false),
        }
    }

    fn prune_if_needed(&self) {
        if self.pruning.swap(true, Ordering::AcqRel) {
            return;
        }
        prune_bytes(&self.dir, self.prefix, MAX_CHANNEL_BYTES);
        self.written
            .store(dir_bytes(&self.dir, self.prefix), Ordering::Release);
        self.pruning.store(false, Ordering::Release);
    }
}

impl Write for CappedWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // 落盘前的最后一道统一闸：任何通道的字节里出现 http(s) URL 都要去掉
        // query/fragment（签名直链、带 token 的取数地址都在其中）。
        //
        // 以前只有 UI 通道在写入侧调 `sanitize`，宿主通道是裸 `fmt::layer()`：
        // 反代 / http 取数失败的报错把完整 URL 写进 `url = %target`、错误 cause
        // 也带整串地址，而「一键诊断」打包的正是这些日志——等于把令牌外泄
        // （2026-11-16 评审 P1）。放在这里而不是每个调用点，是为了让「新增
        // 一条日志」默认就是安全的。
        //
        // ⚠️ 返回值必须是「消费了 buf.len() 个输入字节」，不是实际落盘字节数：
        // 脱敏后的串比输入短，若按输出长度返回，`write_all` 会把原文剩下的
        // 尾巴（正是 query）继续写进来——回归测试 `capped_writer_redacts_...`
        // 抓到过这个自伤。实际写入量单独用于容量核算。
        if contains_url(buf) {
            let owned = crate::logging::redact_urls(&String::from_utf8_lossy(buf)).into_bytes();
            self.write_raw(&owned)?;
        } else {
            self.write_raw(buf)?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// 缓冲区里是否出现 http(s)——用 `windows` 扫描，但先验长度：`windows` 在
/// `size > len` 时直接 panic，而日志写入完全可能是几个字节的碎片。
fn contains_url(buf: &[u8]) -> bool {
    (buf.len() >= 7 && buf.windows(7).any(|window| window == b"http://"))
        || (buf.len() >= 8 && buf.windows(8).any(|window| window == b"https://"))
}

impl CappedWriter {
    /// 真正的落盘 + 容量核算（按实际写入的字节计，不含被脱敏掉的部分）。
    fn write_raw(&mut self, buf: &[u8]) -> io::Result<()> {
        self.inner.write_all(buf)?;
        let total = self.written.fetch_add(buf.len() as u64, Ordering::AcqRel) + buf.len() as u64;
        if total > MAX_CHANNEL_BYTES {
            self.prune_if_needed();
        }
        Ok(())
    }
}

/// 某个通道目录里已占用的字节数（只算该通道自己的 `.log` 文件）。
fn dir_bytes(dir: &Path, prefix: &str) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| channel_file_matches(&entry.path(), prefix))
        .filter_map(|entry| entry.metadata().ok())
        .map(|meta| meta.len())
        .sum()
}

/// 删最旧的文件直到低于 `cap`；正在写的那一份（最新的 `.log`）永远保留。
fn prune_bytes(dir: &Path, prefix: &str, cap: u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| channel_file_matches(path, prefix))
        .filter_map(|path| {
            let len = fs::metadata(&path).ok()?.len();
            Some((path, len))
        })
        .collect();
    if files.len() <= 1 {
        return;
    }
    // 文件名里是 ISO 日期，字典序即时间序。
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let live = files
        .iter()
        .rposition(|(path, _)| path.to_string_lossy().ends_with(".log"));
    let mut total: u64 = files.iter().map(|(_, len)| *len).sum();
    for (index, (path, len)) in files.iter().enumerate() {
        if total <= cap {
            break;
        }
        if Some(index) == live {
            continue;
        }
        if fs::remove_file(path).is_ok() {
            total -= len;
        }
    }
}

/// 通道文件：`<prefix>.<日期>.log`（历史文件 `luma-<日期>.log` 也算），以及
/// 适配层按大小滚出来的 `<…>.log.1`。
fn channel_file_matches(path: &Path, prefix: &str) -> bool {
    if !path.is_file() {
        return false;
    }
    let Some(name) = path.file_name().and_then(|item| item.to_str()) else {
        return false;
    };
    let looks_like_log = name.ends_with(".log") || name.ends_with(".log.1");
    looks_like_log && name.starts_with(prefix)
}

fn stdout_layer<S>() -> fmt::Layer<S>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    fmt::layer()
        .with_ansi(true)
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(false)
}

/// 文件层：`App` 收下除 `ui` 以外的一切，`Ui` 只收 `target: "ui"`。
fn file_layer<S>(writer: NonBlocking, channel: Channel) -> impl Layer<S>
where
    S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
{
    let targets = match channel {
        Channel::Ui => Targets::new()
            .with_default(LevelFilter::OFF)
            .with_target("ui", LevelFilter::TRACE),
        _ => Targets::new()
            .with_default(LevelFilter::TRACE)
            .with_target("ui", LevelFilter::OFF),
    };
    fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(writer)
        .with_filter(targets)
}

/// `LUMA_LOG` 交给 `EnvFilter` 解析：既接受 `debug` 这类级别，
/// 也接受 `luma_lib::spider=debug,info` 这类按模块的指令。
fn env_filter() -> EnvFilter {
    EnvFilter::builder()
        .with_default_directive(LevelFilter::INFO.into())
        .parse_lossy(crate::env::get("LOG").unwrap_or_default())
}

/// 把 1.0.2 及更早写在 `logs/` 根下的文件搬进对应通道目录。
fn migrate_legacy(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|item| item.to_str()) else {
            continue;
        };
        let target_dir = if is_app_log(name) {
            root.join(Channel::App.dir_name())
        } else if is_spider_log(name) {
            root.join(Channel::Spider.dir_name())
        } else {
            continue;
        };
        let target = target_dir.join(name);
        if target.exists() {
            continue;
        }
        // 搬不动（文件被占用）就留在原处，不影响本次运行。
        let _ = fs::rename(&path, &target);
    }
}

/// 适配层文件由 Python 自己写，滚动策略也由我们自己执行（按文件名里的日期
/// 字典序，ISO 日期天然有序），并在初始化时把整目录压到容量上限以内。
fn prune_spider(root: &Path) {
    let dir = root.join(Channel::Spider.dir_name());
    prune_bytes(&dir, "spider", MAX_CHANNEL_BYTES);
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("spider.") && name.ends_with(".log"))
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

/// 宿主日志文件名：新命名 `luma.<日期>.log`，1.0.3 之前的 `luma-<日期>.log`。
pub(super) fn is_app_log(name: &str) -> bool {
    (name.starts_with("luma-") || name.starts_with("luma.")) && name.ends_with(".log")
}

/// 适配层日志文件名：`spider.<日期>.log` 与历史 `spider.log`/`spider.log.1`。
pub(super) fn is_spider_log(name: &str) -> bool {
    name.starts_with("spider") && (name.ends_with(".log") || name.ends_with(".log.1"))
}

/// UTC 日期（YYYY-MM-DD），与 `tracing-appender` 的 `Rotation::DAILY` 一致。
fn utc_date() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|delta| delta.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = report::civil_from_days(secs.div_euclid(86_400));
    format!("{year:04}-{month:02}-{day:02}")
}

// ---- 命令层 ---------------------------------------------------------------
// 命令留在 `mod.rs`（与 `domain/config` 同款），子模块只放实现，避免
// `#[tauri::command]` 生成的 `__cmd__*` 需要跨模块再导出。

/// 前端统一日志入口（`src/lib/logger.ts` 批量调用）。
#[tauri::command]
pub fn log_write(entries: Vec<UiLogEntry>) -> Result<(), AppError> {
    ui::write_entries(entries)
}

/// 打开日志目录，方便试运行用户把文件发给开发者。
#[tauri::command]
pub fn open_log_dir() -> Result<(), AppError> {
    diagnostics::open_dir()
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
    let spawned = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open")
        .arg(if path.is_dir() {
            path.to_path_buf()
        } else {
            path.parent().unwrap_or(path).to_path_buf()
        })
        .spawn();

    spawned.map(|_| ()).map_err(|err| {
        AppError::new(code::INTERNAL, "reveal path failed").with_cause(err.to_string())
    })
}

// ---- 子模块 ---------------------------------------------------------------
// 脱敏规则在 `redact`，诊断与反馈文件各占一个文件；`mod.rs` 只留目录解析、
// 初始化、通道划分与命令层。
//
// `diagnostics` / `report` 对全 crate 可见，但**不**再引用 domain 类型：
// 它们只吃 `ConfigDigest`（中性摘要）。需要读配置的 `diagnostics` /
// `export_report` 命令住在 `domain/diagnostics.rs`（分层方向，2026-11-16 评审）。
pub(crate) mod diagnostics;
mod redact;
pub(crate) mod report;
mod ui;

pub use diagnostics::{ConfigDiagnostics, ConfigDigest, Diagnostics, LogFileInfo};
pub use redact::{redact_url, redact_urls, sanitize};
pub use ui::UiLogEntry;

use redact::truncate_chars;

#[cfg(test)]
mod tests;
