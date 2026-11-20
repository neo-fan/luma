//! Sidecar path resolution shared by the sidecar bridges (Python adapter / qjs-runner).
//!
//! Tauri's `resource_dir()` differs between a dev run (target/debug), a portable
//! folder (exe dir) and an installed build (exe/resources). Rather than assume
//! one layout, every consumer probes a small candidate list for the file it
//! actually needs, so all three layouts work without extra configuration.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Candidate roots that may contain a `sidecars/` directory, most specific
/// first. Duplicates are removed and empty paths are ignored.
pub fn sidecar_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    // Debug builds run from the checkout: a bundle step may have left a stale
    // copy under target/debug/sidecars, and picking it silently runs old code.
    // Prefer the live source tree in debug, the resource dir in release.
    if cfg!(debug_assertions) {
        push_unique(&mut roots, source_root());
    }

    if let Some(dir) = resource_dir() {
        let dir = PathBuf::from(dir);
        // Installed build: <resource>/sidecars. Portable: <exe>/sidecars where
        // resource_dir is the exe dir. Also try the parent for <exe>/resources.
        push_unique(&mut roots, dir.clone());
        if let Some(parent) = dir.parent() {
            push_unique(&mut roots, parent.to_path_buf());
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            push_unique(&mut roots, dir.to_path_buf());
            if let Some(parent) = dir.parent() {
                push_unique(&mut roots, parent.to_path_buf());
            }
        }
    }

    if !cfg!(debug_assertions) {
        push_unique(&mut roots, source_root());
    }
    roots
}

/// Tauri 报告的 resource 目录（安装版 = exe/resources，便携版 = exe 目录）。
///
/// 宿主在 `setup()` 里发布它——那时 tokio worker 已经在跑，而 `std::env::set_var`
/// 与并发 `std::env::var` 是数据竞争（edition 2021 下 `set_var` 还不是 `unsafe`，
/// 但 Windows 上真会读到撕裂 / 错值）。所以用 `OnceLock`：发布一次、之后只读，
/// 天然线程安全。
///
/// `LUMA_RESOURCE_DIR` 环境变量仍然生效（外部覆盖：手工跑 sidecar、集成
/// 测试指定 bundle 布局），优先级低于宿主显式发布的那一次。
static RESOURCE_DIR: OnceLock<String> = OnceLock::new();

/// 宿主启动时调用一次；重复调用保留第一次发布的值（诊断里要知道真实来源）。
pub fn set_resource_dir(path: &std::path::Path) {
    let text = path.to_string_lossy().to_string();
    if RESOURCE_DIR.set(text.clone()).is_ok() {
        tracing::info!(dir = %text, "resource dir published");
    }
}

/// 当前可见的 resource 目录：宿主发布值优先，其次环境变量覆盖。
pub fn resource_dir() -> Option<String> {
    RESOURCE_DIR.get().cloned().or_else(|| {
        std::env::var("LUMA_RESOURCE_DIR")
            .ok()
            .filter(|text| !text.is_empty())
    })
}

/// Checkout root at compile time; only useful for `cargo run` / tests.
pub fn source_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// First root that contains `relative`, falling back to the source root so the
/// resulting error message points at a plausible location.
pub fn find(relative: &[&str]) -> Option<PathBuf> {
    for root in sidecar_roots() {
        let mut candidate = root.clone();
        for part in relative {
            candidate = candidate.join(part);
        }
        if candidate.is_file() || candidate.is_dir() {
            return Some(root);
        }
    }
    None
}

/// The bundled embedded Python and the cwd it must run from.
///
/// Both dev and shipped builds should use the *same* interpreter: the one in
/// `sidecars/python-embed`, which carries pycryptodome / requests / lxml that
/// several real spiders import. Falling back to whatever `python` is first on
/// PATH makes those spiders fail with `No module named 'Crypto'` only in dev,
/// while the portable build works — a confusing dev/prod drift. Probing the
/// same `sidecar_roots()` as the adapter means debug picks the checkout copy
/// and release picks the resource-dir copy, with no env var to remember.
///
/// The returned cwd is the embed dir itself: embeddable CPython resolves
/// `python311.dll` relative to its own directory, so running it with the
/// checkout root as cwd fails with STATUS_DLL_NOT_FOUND.
pub fn embedded_python() -> Option<(PathBuf, PathBuf)> {
    let root = find(&["sidecars", "python-embed", "python.exe"])?;
    let embed = root.join("sidecars").join("python-embed");
    let exe = embed.join("python.exe");
    if exe.is_file() {
        Some((exe, embed))
    } else {
        None
    }
}

fn push_unique(roots: &mut Vec<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() {
        return;
    }
    if !roots.iter().any(|existing| existing == &path) {
        roots.push(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_root_contains_sidecars() {
        let root = source_root();
        assert!(
            root.join("sidecars").is_dir(),
            "checkout root should have sidecars"
        );
        assert!(find(&["sidecars", "py", "main.py"]).is_some());
    }

    #[test]
    fn roots_are_unique() {
        let roots = sidecar_roots();
        let mut seen = std::collections::HashSet::new();
        for root in &roots {
            assert!(seen.insert(root.clone()), "duplicate root {root:?}");
        }
    }

    #[test]
    fn embedded_python_when_present_has_consistent_layout() {
        // 运行时产物由 tools/prepare_runtime.py 重建、不入库：干净 checkout 里
        // 可能没有，故「找不到」不算失败；找到时必须保证 exe 与 cwd 同在 embed 目录
        // （embeddable CPython 靠自身目录解析 python311.dll，cwd 错了会 DLL 加载失败）。
        if let Some((exe, cwd)) = embedded_python() {
            assert!(exe.is_file(), "embedded python exe must exist");
            assert_eq!(exe, cwd.join("python.exe"));
            assert!(cwd.ends_with("python-embed"));
            assert!(
                cwd.join("Lib").join("site-packages").is_dir(),
                "bundle must ship third-party packages (pycryptodome/requests/lxml)"
            );
        }
    }
}
