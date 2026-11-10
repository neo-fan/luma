//! Sidecar path resolution shared by bridge / jvm / mpv.
//!
//! Tauri's `resource_dir()` differs between a dev run (target/debug), a portable
//! folder (exe dir) and an installed build (exe/resources). Rather than assume
//! one layout, every consumer probes a small candidate list for the file it
//! actually needs, so all three layouts work without extra configuration.

use std::path::PathBuf;

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

    if let Ok(dir) = std::env::var("TVBOX_RESOURCE_DIR") {
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
        assert!(root.join("sidecars").is_dir(), "checkout root should have sidecars");
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
}
