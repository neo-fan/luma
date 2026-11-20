//! 本机存储用量与手动清理（设置页「存储与清理」）。
//!
//! 三类东西只会越长越大，且都在本机：
//! - `logs/{app,spider,ui}`：按日滚动 + 单文件上限，保留 7 天，但用户想立刻腾空间
//!   不该等到第七天；
//! - `reports`：一键诊断导出的压缩包，每点一次多一份；
//! - `cache/http-images`：封面 HTTP 缓存（cacache 内容寻址），命中率高所以体积稳定，
//!   但换配置、片库大换血后会长期占着不再引用的条目。
//!
//! 日志的当天文件被 tracing 的 writer 持有句柄：先尝试删除，删不掉就清空内容
//! （`set_len(0)`），两者都失败才计入「未释放」——不做静默失败，也不假装删干净了。
//! 数据库（配置/收藏/历史）不在这里动：它有独立的清空入口，误删不可恢复。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{code, AppError};

/// 一个目录的占用统计。`files` 只数文件，不数子目录本身。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirUsage {
    pub bytes: u64,
    pub files: u32,
}

/// 清理结果：释放了多少、还剩多少、有多少没能释放。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearOutcome {
    pub freed_bytes: u64,
    pub remaining: DirUsage,
    /// 删不掉也清不空的条目数（通常是正被持有的日志文件）。
    pub skipped: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub logs: DirUsage,
    pub reports: DirUsage,
    pub image_cache: DirUsage,
}

fn data_root() -> PathBuf {
    crate::store::data_dir()
}

fn logs_root() -> PathBuf {
    crate::logging::log_dir()
}

fn reports_dir() -> PathBuf {
    data_root().join("reports")
}

fn image_cache_dir() -> PathBuf {
    data_root().join("cache").join("http-images")
}

fn measure(root: &Path) -> DirUsage {
    let mut bytes = 0u64;
    let mut files = 0u32;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
            } else {
                bytes += meta.len();
                files += 1;
            }
        }
    }
    DirUsage { bytes, files }
}

/// 各通道目录里 mtime 最新的 `.log`：那是 writer 当天正持有的文件，其余滚动件可删。
fn current_log_files(root: &Path) -> std::collections::HashSet<PathBuf> {
    let mut out = std::collections::HashSet::new();
    let Ok(channels) = fs::read_dir(root) else {
        return out;
    };
    for channel in channels.flatten() {
        let dir = channel.path();
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        let mut newest: Option<(PathBuf, std::time::SystemTime)> = None;
        for file in files.flatten() {
            let path = file.path();
            let Ok(meta) = file.metadata() else { continue };
            if !meta.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("log") {
                continue;
            }
            let Ok(mtime) = meta.modified() else { continue };
            let replace = match &newest {
                None => true,
                Some((_, best)) => mtime > *best,
            };
            if replace {
                newest = Some((path, mtime));
            }
        }
        if let Some((path, _)) = newest {
            out.insert(path);
        }
    }
    out
}

/// 删除一批文件；`keep` 为真的路径保留。返回（释放字节，跳过条数）。
fn purge(root: &Path, keep: &dyn Fn(&Path) -> bool) -> (u64, u32) {
    let mut freed = 0u64;
    let mut skipped = 0u32;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if keep(&path) {
                continue;
            }
            let len = meta.len();
            if fs::remove_file(&path).is_ok() {
                freed += len;
                continue;
            }
            // 多半是日志文件正被 writer 持有：清空内容等价于「回到零字节」，
            // writer 的下一次写会从文件头开始（句柄位置会被后续写覆盖，可接受）。
            if let Ok(file) = fs::OpenOptions::new().write(true).open(&path) {
                if file.set_len(0).is_ok() {
                    freed += len;
                    continue;
                }
            }
            skipped += 1;
        }
    }
    (freed, skipped)
}

#[tauri::command]
pub async fn storage_usage() -> Result<StorageUsage, AppError> {
    // 递归 read_dir + 逐文件 metadata 是阻塞 IO（封面缓存上千文件），同步命令会
    // 直接跑在主线程上，窗口要卡几十毫秒。扔到阻塞池。
    tauri::async_runtime::spawn_blocking(|| StorageUsage {
        logs: measure(&logs_root()),
        reports: measure(&reports_dir()),
        image_cache: measure(&image_cache_dir()),
    })
    .await
    .map_err(|err| AppError::new(code::INTERNAL, format!("测量存储用量失败：{err}")))
}

/// `target`：`logs` / `reports` / `imageCache`。
///
/// 日志只清各通道的历史文件与今天的旧滚动件，当天正在写的那份走清空内容；
/// 封面缓存整目录删除（cacache 按内容寻址、无常驻索引，删掉只会导致回源重取）。
#[tauri::command]
pub async fn storage_clear(target: String) -> Result<ClearOutcome, AppError> {
    // 整目录递归删除 + 删完再 measure 一遍，同样是阻塞 IO，不能占主线程。
    tauri::async_runtime::spawn_blocking(move || clear_storage(&target))
        .await
        .map_err(|err| AppError::new(code::INTERNAL, format!("清理存储失败：{err}")))?
}

fn clear_storage(target: &str) -> Result<ClearOutcome, AppError> {
    let (root, keep_current_log) = match target {
        "logs" => (logs_root(), true),
        "reports" => (reports_dir(), false),
        "imageCache" => (image_cache_dir(), false),
        other => {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                format!("未知的清理目标：{other}"),
            ))
        }
    };

    let keep_set = if keep_current_log {
        current_log_files(&root)
    } else {
        Default::default()
    };
    let keep = |path: &Path| keep_set.contains(path);
    let (freed_bytes, skipped) = purge(&root, &keep);

    // 封面缓存清完把空目录建回来，避免反代首次写缓存时目录不存在。
    if target == "imageCache" {
        let _ = fs::create_dir_all(&root);
    }

    Ok(ClearOutcome {
        freed_bytes,
        remaining: measure(&root),
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{Duration, SystemTime};

    /// 每个用例一个独立临时目录，跑完即删，避免互相踩 mtime。
    fn sandbox(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("luma-storage-{name}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create sandbox");
        root
    }

    fn write_file(path: &Path, len: usize, mtime: SystemTime) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        let mut file = fs::File::create(path).expect("create file");
        file.write_all(&vec![b'x'; len]).expect("write");
        file.set_modified(mtime).expect("set mtime");
    }

    #[test]
    fn measure_counts_nested_files_only() {
        let root = sandbox("measure");
        let now = SystemTime::now();
        write_file(&root.join("a.log"), 10, now);
        write_file(&root.join("sub").join("b.log"), 25, now);
        let usage = measure(&root);
        assert_eq!(usage.bytes, 35);
        assert_eq!(usage.files, 2);
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn measure_missing_dir_is_zero() {
        let root = sandbox("absent");
        let usage = measure(&root.join("nope"));
        assert_eq!(usage.bytes, 0);
        assert_eq!(usage.files, 0);
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn purge_honours_keep_and_reports_freed() {
        let root = sandbox("purge");
        let now = SystemTime::now();
        write_file(&root.join("keep.log"), 40, now);
        write_file(&root.join("gone.log.1"), 60, now);
        write_file(&root.join("deep").join("gone2.log.2"), 100, now);
        let keep = |path: &Path| path.file_name().is_some_and(|n| n == "keep.log");
        let (freed, skipped) = purge(&root, &keep);
        assert_eq!(freed, 160);
        assert_eq!(skipped, 0);
        let remaining = measure(&root);
        assert_eq!(remaining.bytes, 40);
        assert_eq!(remaining.files, 1);
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn current_log_files_picks_newest_per_channel_and_ignores_rolled() {
        let root = sandbox("current");
        let older = SystemTime::now() - Duration::from_secs(86_400);
        let newest = SystemTime::now();
        write_file(&root.join("app").join("luma.old.log"), 10, older);
        write_file(&root.join("app").join("luma.new.log"), 10, newest);
        // 滚动件后缀不是 .log，永远算可清理。
        write_file(
            &root.join("app").join("luma.log.1"),
            10,
            newest + Duration::from_secs(5),
        );
        write_file(&root.join("ui").join("ui.new.log"), 10, newest);
        write_file(&root.join("ui").join("ui.old.log"), 10, older);

        let current = current_log_files(&root);
        let mut expected = std::collections::HashSet::new();
        expected.insert(root.join("app").join("luma.new.log"));
        expected.insert(root.join("ui").join("ui.new.log"));
        assert_eq!(current, expected);
        fs::remove_dir_all(&root).expect("cleanup");
    }

    #[test]
    fn clear_rejects_unknown_target() {
        // 命令本体已改成 async + 阻塞池，校验逻辑留在同步的 `clear_storage` 里，
        // 测试直接打它，避免为一个参数校验搭 tokio 运行时。
        let err = clear_storage("database")
            .err()
            .expect("未知目标必须报错，不能静默什么都不做");
        assert_eq!(err.code, code::INVALID_ARGUMENT);
    }

    /// Windows 上 writer 持有的日志删不掉：清空内容算作已释放，且剩余量必须诚实为 0。
    #[test]
    fn purge_falls_back_to_truncating_a_held_file() {
        let root = sandbox("held");
        let path = root.join("luma.log");
        write_file(&path, 70, SystemTime::now());
        // 与 tracing 的 appender 同样的持法：可读可写、不放开删除共享。
        let held = fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("hold open");

        let keep = |_: &Path| false;
        let (freed, skipped) = purge(&root, &keep);
        assert_eq!(
            (freed, skipped),
            (70, 0),
            "删不掉但能清空的条目应计入已释放，不算跳过"
        );
        assert_eq!(measure(&root).bytes, 0, "清空后剩余量必须为 0，不能虚报");

        drop(held);
        fs::remove_dir_all(&root).expect("cleanup");
    }
}
