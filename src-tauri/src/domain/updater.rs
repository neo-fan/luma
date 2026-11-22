//! 应用自动升级：检查 Release 清单、下载安装包、校验后静默安装。
//!
//! ## 为什么不用 GitHub API
//!
//! 国内直连 `api.github.com` 不稳，而三家常用加速前缀（`gh-proxy.com` /
//! `ghfast.top` / `ghproxy.net`）实测**不支持** API 域名（TLS 直接失败），
//! 但 `releases/download/...` 通道正常。所以版本信息由 CI 生成 `latest.json`
//! 挂成 Release 资产，客户端只读这一个静态文件。
//!
//! ## 回退顺序
//!
//! 用户当前选择的加速前缀 → 其余内置前缀 → 直连。清单与安装包各自独立回退：
//! 某个前缀清单能取、下载被掐，会自动换下一个前缀重下，不会让用户卡死。
//!
//! ## 安装
//!
//! 安装包是项目自己产出的 NSIS（`currentUser` 模式），用 **passive** 模式
//! （`/P`）而不是静默（`/S`）：silent 全程没有任何界面，用户点完「安装并退出」
//! 只看到窗口消失，既不知道装到哪一步，也不知道还要等多久。passive 只显示安装
//! 进度窗口、不需要任何交互，装完自动关闭；模板在 passive 下同样认 `/R`，会把
//! 应用重新拉起来，配合启动回执形成闭环（见 `INSTALL_ARGS`）。
//!
//! 官方模板的 `CheckIfAppIsRunning` 在 passive 下不弹确认框、直接关掉仍占用
//! exe 的进程，所以「应用还没退干净」不会把安装卡在对话框上。点安装后后端先
//! 等一小段时间再退出，把时间留给前端把「正在安装」面板画出来。

use crate::error::{code, AppError};
use crate::ghproxy;
use crate::http::shared_client;
use crate::store::data_dir;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::io::AsyncWriteExt;

/// 清单与安装包所在的公开仓库（匿名可读是自动升级的前提）。
const REPO: &str = "https://github.com/neo-fan/luma";
const MANIFEST_ASSET: &str = "latest.json";
/// 检查结果缓存：启动检查与设置页手动检查共用，避免反复打代理。
const CHECK_TTL: Duration = Duration::from_secs(600);
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(20);
/// 下载进度事件的最小间隔（hls 分片级别的频繁 emit 会拖慢前端渲染）。
const PROGRESS_STEP: Duration = Duration::from_millis(150);

/// 安装器参数。
///
/// `/P` = passive：显示安装进度窗口但不需要任何交互，装完自动关闭。比 `/S`
/// 多出的就是一个进度界面——用户点完「安装并退出」至少能看到「正在写入文件」，
/// 而不是只有一个窗口消失。`/R` 让模板在安装成功后重新拉起应用，这样用户
/// 不必自己回去双击图标，启动回执也能立刻报「已更新到 X」。
///
/// 两者都依赖 `nsis/installer.nsi`：`$PassiveMode` 由 `/P` 置位（`.onInit`），
/// `.onInstSuccess` 在 passive 下读 `/R`（模板 793-799 行）。
const INSTALL_ARGS: [&str; 2] = ["/P", "/R"];

/// 检查结果缓存（10 分钟）：启动静默检查与设置页手动检查共用。
static CACHE: std::sync::Mutex<Option<(Instant, UpdateInfo)>> = std::sync::Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    /// CI 从 CHANGELOG 截取的版本说明（纯文本）。
    pub notes: String,
    pub published_at: String,
    pub size: u64,
    pub asset_name: String,
    /// 命中的加速前缀（空串 = 直连），用于在界面上说明「走的哪条通道」。
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    /// 版本号，与 `package.json` 一致（不带 `v`）。
    version: String,
    /// Release 的 tag（`v2.0.1`），下载地址要用它。
    tag: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    pub_date: String,
    asset: Asset,
}

#[derive(Debug, Clone, Deserialize)]
struct Asset {
    name: String,
    size: u64,
    sha256: String,
}

/// 候选前缀：当前选择优先，其余内置按推荐顺序，最后直连。去重且保留空串语义。
fn candidate_prefixes(current: &str) -> Vec<String> {
    let mut out = vec![current.to_string()];
    for prefix in ghproxy::BUILTIN_PREFIXES {
        if !out.iter().any(|item| item == prefix) {
            out.push(prefix.to_string());
        }
    }
    if !out.iter().any(|item| item.is_empty()) {
        out.push(String::new());
    }
    out
}

/// 拼接加速地址。前缀由 `ghproxy::normalize_prefix` 保证以 `/` 结尾。
fn with_prefix(prefix: &str, url: &str) -> String {
    if prefix.is_empty() {
        url.to_string()
    } else {
        format!("{prefix}{url}")
    }
}

fn manifest_url() -> String {
    format!("{REPO}/releases/latest/download/{MANIFEST_ASSET}")
}

async fn fetch_manifest(prefix: String) -> Result<(String, Manifest), String> {
    let url = with_prefix(&prefix, &manifest_url());
    let client = shared_client().map_err(|err| err.message)?;
    let response = client
        .get(&url)
        .timeout(MANIFEST_TIMEOUT)
        .header(reqwest::header::USER_AGENT, crate::netrules::DEFAULT_UA)
        .send()
        .await
        .map_err(|err| format!("{url}: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url}: HTTP {}", status.as_u16()));
    }
    let body = response
        .text()
        .await
        .map_err(|err| format!("{url}: {err}"))?;
    let manifest: Manifest = serde_json::from_str(&body)
        .map_err(|err| format!("{url}: manifest 解析失败 {err}"))?;
    if manifest.asset.name.is_empty() || manifest.asset.sha256.is_empty() {
        return Err(format!("{url}: manifest 缺少校验信息"));
    }
    Ok((prefix, manifest))
}

/// 并发竞速取第一个可用清单（清单很小，串行等待三个超时代价太高）。
async fn load_manifest(prefixes: Vec<String>) -> Result<(String, Manifest), AppError> {
    let mut set = tokio::task::JoinSet::new();
    for prefix in prefixes {
        set.spawn(fetch_manifest(prefix));
    }
    let mut errors = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(found)) => {
                set.abort_all();
                return Ok(found);
            }
            Ok(Err(err)) => errors.push(err),
            Err(err) => errors.push(format!("task join failed: {err}")),
        }
    }
    Err(AppError::new(code::UPDATE_FAIL, "所有通道都不可用")
        .with_cause(errors.join(" · ")))
}

fn parse_version(raw: &str) -> Option<semver::Version> {
    semver::Version::parse(raw.trim().trim_start_matches('v')).ok()
}

fn cached() -> Option<UpdateInfo> {
    let guard = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (at, info) = guard.as_ref()?;
    (at.elapsed() < CHECK_TTL).then(|| info.clone())
}

fn remember(info: &UpdateInfo) {
    let mut guard = CACHE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some((Instant::now(), info.clone()));
}

/// 后台检查：`force=false` 时复用 10 分钟内的结果（启动静默检查用）。
pub async fn check(current_prefix: &str, force: bool) -> Result<UpdateInfo, AppError> {
    if !force {
        if let Some(hit) = cached() {
            return Ok(hit);
        }
    }
    let (source, manifest) = load_manifest(candidate_prefixes(current_prefix)).await?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    let has_update = match (parse_version(&current), parse_version(&manifest.version)) {
        (Some(a), Some(b)) => b > a,
        // 版本号解析不了时按「比较字符串相等」保守处理：宁可提示更新，
        // 也不要静默漏掉——用户点开能看到版本差异。
        _ => manifest.version.trim() != current.trim(),
    };
    let info = UpdateInfo {
        current,
        latest: manifest.version.clone(),
        has_update,
        notes: manifest.notes,
        published_at: manifest.pub_date,
        size: manifest.asset.size,
        asset_name: manifest.asset.name,
        source,
    };
    remember(&info);
    Ok(info)
}

fn updates_dir() -> PathBuf {
    data_dir().join("updates")
}

async fn download_from(
    app: &tauri::AppHandle,
    prefix: &str,
    tag: &str,
    asset: &Asset,
) -> Result<PathBuf, String> {
    let url = with_prefix(
        prefix,
        &format!("{REPO}/releases/download/{tag}/{}", asset.name),
    );
    let client = shared_client().map_err(|err| err.message)?;
    let response = client
        .get(&url)
        .header(reqwest::header::USER_AGENT, crate::netrules::DEFAULT_UA)
        .send()
        .await
        .map_err(|err| format!("{url}: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("{url}: HTTP {}", status.as_u16()));
    }

    let dir = updates_dir();
    std::fs::create_dir_all(&dir).map_err(|err| format!("创建下载目录失败：{err}"))?;
    let dest = dir.join(&asset.name);
    let partial = dest.with_extension("part");
    // 上一轮中断留下的半截文件：直接覆盖，不要追加。
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|err| format!("创建文件失败：{err}"))?;

    let total = asset.size;
    let mut downloaded = 0u64;
    let mut hasher = Sha256::new();
    let mut stream = response.bytes_stream();
    let mut last_emit = Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("{url}: 读取中断 {err}"))?;
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("写文件失败：{err}"))?;
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= PROGRESS_STEP {
            last_emit = Instant::now();
            // 进度事件失败不阻断下载：窗口可能已经关了。
            let _ = app.emit("update-progress", UpdateProgress { downloaded, total });
        }
    }
    file.flush().await.map_err(|err| format!("写文件失败：{err}"))?;
    drop(file);

    let digest = hex::encode(hasher.finalize());
    let expected = asset.sha256.trim().to_ascii_lowercase();
    if digest != expected {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!(
            "{url}: SHA256 不一致（期望 {expected}，实得 {digest}）"
        ));
    }
    if total > 0 && downloaded != total {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!("{url}: 大小不一致（期望 {total}，实得 {downloaded}）"));
    }
    tokio::fs::rename(&partial, &dest)
        .await
        .map_err(|err| format!("重命名失败：{err}"))?;
    Ok(dest)
}

/// 下载安装包：清单先走缓存，下载逐前缀回退，成功返回本地 exe 路径。
pub async fn download(app: &tauri::AppHandle, current_prefix: &str) -> Result<String, AppError> {
    let (_, manifest) = load_manifest(candidate_prefixes(current_prefix)).await?;
    // 清单里的 tag 决定下载地址：清单与安装包必须来自同一次发布。
    let asset = manifest.asset.clone();
    let tag = manifest.tag.clone();
    let mut errors = Vec::new();
    for prefix in candidate_prefixes(current_prefix) {
        match download_from(app, &prefix, &tag, &asset).await {
            Ok(path) => return Ok(path.to_string_lossy().to_string()),
            Err(err) => errors.push(err),
        }
    }
    Err(AppError::new(code::UPDATE_FAIL, "所有通道都不可用")
        .with_cause(errors.join(" · ")))
}

// ---- Tauri 命令 -----------------------------------------------------------

/// 检查更新。`force=true` 跳过 10 分钟缓存（设置页手动检查）。
#[tauri::command]
pub async fn update_check(
    state: tauri::State<'_, crate::config::ConfigStore>,
    force: bool,
) -> Result<UpdateInfo, AppError> {
    let prefix = state.github_proxy();
    check(&prefix, force).await
}

/// 下载最新安装包，进度通过 `update-progress` 事件推送。
#[tauri::command]
pub async fn update_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::config::ConfigStore>,
) -> Result<String, AppError> {
    let prefix = state.github_proxy();
    download(&app, &prefix).await
}

/// 启动安装器并退出应用。
///
/// 只允许执行下载目录里的 `.exe`：命令虽然只由自己的前端调用，但把
/// 「任意路径 → 任意可执行文件」的口子留在 IPC 表里没有必要。
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let target = Path::new(&path);
    if !target.starts_with(updates_dir())
        || target.extension().and_then(|ext| ext.to_str()) != Some("exe")
        || !target.is_file()
    {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            "安装包路径不合法，请重新下载",
        ));
    }
    let _child = std::process::Command::new(target)
        .args(INSTALL_ARGS)
        .spawn()
        .map_err(|err| {
            AppError::new(code::UPDATE_FAIL, "启动安装器失败")
                .with_cause(err.to_string())
        })?;
    // 给安装器接管时间，也让前端把「正在安装」面板画出来。用 async 等待，
    // 不阻塞主线程；随后走正常退出流程（sidecar 优雅关停也在这里）。
    tokio::time::sleep(Duration::from_millis(1200)).await;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_prefer_current_then_builtin_then_direct() {
        let list = candidate_prefixes("https://ghfast.top/");
        assert_eq!(list[0], "https://ghfast.top/");
        assert!(list.contains(&"https://gh-proxy.com/".to_string()));
        assert_eq!(list.last().unwrap(), "");
        // 同一个前缀不重复出现
        let unique: std::collections::HashSet<_> = list.iter().collect();
        assert_eq!(unique.len(), list.len());
    }

    #[test]
    fn direct_prefix_keeps_url_as_is() {
        assert_eq!(
            with_prefix("", "https://github.com/a/b"),
            "https://github.com/a/b"
        );
        assert_eq!(
            with_prefix("https://gh-proxy.com/", "https://github.com/a/b"),
            "https://gh-proxy.com/https://github.com/a/b"
        );
    }

    #[test]
    fn version_compare_handles_v_prefix_and_prerelease() {
        let newer = parse_version("v2.0.1").unwrap();
        let current = parse_version("2.0.0").unwrap();
        assert!(newer > current);
        let beta = parse_version("2.0.1-beta.1").unwrap();
        assert!(beta > current && beta < newer);
    }

    /// 安装必须有可见进度、并且装完自己回来。这两条都靠参数实现，别被改回 /S。
    #[test]
    fn installer_runs_passive_and_restarts_app() {
        assert!(INSTALL_ARGS.contains(&"/P"), "passive 模式才有安装进度窗口");
        assert!(INSTALL_ARGS.contains(&"/R"), "装完要自动重新拉起应用");
        assert!(!INSTALL_ARGS.contains(&"/S"), "静默模式全程无界面，等于没有进度");
    }

    /// 参数只是请求，模板得真的认。换模板（比如回退官方默认）时要在这里炸。
    #[test]
    fn nsis_template_honours_passive_and_restart_flags() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("nsis/installer.nsi");
        let text = std::fs::read_to_string(&path).expect("读取自定义 NSIS 模板");
        assert!(
            text.contains("\"/P\"") && text.contains("PassiveMode"),
            "模板必须解析 /P 才能进入 passive 模式"
        );
        assert!(
            text.contains("\"/R\""),
            "模板的 .onInstSuccess 必须解析 /R 才能自动重启"
        );
    }
}
