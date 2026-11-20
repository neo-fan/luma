use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigDiagnostics {
    pub id: String,
    pub name: String,
    pub sites: usize,
    pub enabled: usize,
    pub blocked: usize,
    /// jar 站点数（分类统计；JVM 运行时已移除，这些站点会被屏蔽）。
    pub jvm: usize,
    pub quickjs: usize,
    pub lives: usize,
    pub parses: usize,
    pub headers: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileInfo {
    /// 所属通道：`app` / `ui` / `spider`。
    pub channel: &'static str,
    /// 相对日志根目录的路径，例如 `app/luma.2026-11-15.log`。
    pub name: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub version: &'static str,
    /// 发布通道（`stable` / `beta` / `dev`）：同机并存时靠它判断这份诊断来自哪个包。
    pub channel: &'static str,
    /// 提交 short hash（与前端同一来源，便于确认前后端是否同源）。
    pub build_hash: &'static str,
    /// 本次运行的启动时刻（epoch 秒）。界面上的 build 号统一取它：dev 下前端
    /// （Vite）与后端（cargo）的构建时刻必然不同，分两处显示永远对不上。
    pub started_at: String,
    /// 构建时间戳：exe 的修改时间（epoch 秒），即本次编译完成时刻。仅供诊断排障，
    /// 不作为界面 build 号（那个是 `started_at`）。
    /// 不用 build.rs 里取的时间：cargo 缓存会让 build script 不重跑，
    /// 那个值可能停留在很久以前，无法回答「这个 exe 是不是刚编的」。
    pub build_time: String,
    pub os: &'static str,
    pub arch: &'static str,
    pub data_dir: String,
    pub log_dir: String,
    pub db_path: String,
    pub config: Option<ConfigDiagnostics>,
    pub log_files: Vec<LogFileInfo>,
    pub log_bytes: u64,
}

/// 诊断需要的**中性配置规模视图**。
///
/// infra 不该认识 domain 的 `ConfigSnapshot`（分层方向，2026-11-16 评审 P1）：
/// 这里只声明「诊断要统计什么」，把快照 → 摘要的转换留在 domain 侧
/// （`domain/diagnostics.rs`）。`sites` 保留原始 JSON 是因为统计口径
/// （enabled / 屏蔽 / 运行时分桶）本来就是按字段名读的。
#[derive(Debug, Clone)]
pub struct ConfigDigest {
    pub id: String,
    pub name: String,
    pub sites: Vec<serde_json::Value>,
    pub lives: usize,
    pub parses: usize,
    pub headers: usize,
}

/// 采集一次诊断快照（命令层在 `domain/diagnostics.rs`）。
pub(crate) fn collect(config: Option<ConfigDigest>) -> Diagnostics {
    let data_dir = crate::store::data_dir();
    let (log_files, log_bytes) = log_files();
    Diagnostics {
        version: env!("CARGO_PKG_VERSION"),
        channel: crate::channel::current().as_str(),
        build_hash: env!("BUILD_HASH"),
        started_at: crate::started::epoch_secs().to_string(),
        build_time: exe_build_time(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        db_path: data_dir.join(crate::db::DB_FILE).display().to_string(),
        data_dir: data_dir.display().to_string(),
        log_dir: log_dir().display().to_string(),
        config: config_diagnostics(config),
        log_files,
        log_bytes,
    }
}

/// 后端构建时间戳：exe 文件的修改时间（epoch 秒）。
/// 读不到（如权限受限）时回退 build.rs 注入的编译时刻，保证字段永远有值。
fn exe_build_time() -> String {
    std::env::current_exe()
        .and_then(|path| std::fs::metadata(path))
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|| env!("BUILD_TIME").to_string())
}

pub(crate) fn config_diagnostics(config: Option<ConfigDigest>) -> Option<ConfigDiagnostics> {
    let snapshot = config?;
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
        .filter(|site| {
            site.get("enabled")
                .and_then(|item| item.as_bool())
                .unwrap_or(true)
        })
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
        lives: snapshot.lives,
        parses: snapshot.parses,
        headers: snapshot.headers,
    })
}

fn log_files() -> (Vec<LogFileInfo>, u64) {
    let mut files = Vec::new();
    for channel in Channel::ALL {
        let dir = channel_dir(channel);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|item| item.to_str()) else {
                continue;
            };
            let keep = match channel {
                Channel::App => is_app_log(name),
                Channel::Ui => name.starts_with("ui.") && name.ends_with(".log"),
                Channel::Spider => is_spider_log(name),
            };
            if !keep {
                continue;
            }
            files.push(LogFileInfo {
                channel: channel.dir_name(),
                name: format!("{}/{}", channel.dir_name(), name),
                bytes: entry.metadata().map(|meta| meta.len()).unwrap_or(0),
            });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    let total = files.iter().map(|file| file.bytes).sum();
    (files, total)
}

/// 建好日志目录并在资源管理器里打开（命令层在 `mod.rs`）。
pub(super) fn open_dir() -> Result<(), AppError> {
    let dir = log_dir();
    fs::create_dir_all(&dir).map_err(|err| {
        AppError::new(code::INTERNAL, "create log dir failed").with_cause(err.to_string())
    })?;
    reveal(&dir)
}
