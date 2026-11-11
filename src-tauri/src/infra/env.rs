//! Product-scoped environment variables.
//!
//! The app was renamed from "TVBox Desktop" to "Luma". `LUMA_*` is now the
//! documented spelling; the legacy `TVBOX_*` name is still accepted so old
//! shortcuts, probe scripts and sidecars keep working after the upgrade.
//! Every read goes through this module, which keeps the fallback in one place.

use std::path::Path;

fn non_empty(value: Result<String, std::env::VarError>) -> Option<String> {
    value.ok().filter(|text| !text.trim().is_empty())
}

/// Read `LUMA_<key>` first, falling back to `TVBOX_<key>`.
pub fn get(key: &str) -> Option<String> {
    non_empty(std::env::var(format!("LUMA_{key}")))
        .or_else(|| non_empty(std::env::var(format!("TVBOX_{key}"))))
}

/// Read with a default; an explicitly empty value counts as "unset".
pub fn get_or(key: &str, default: &str) -> String {
    get(key).unwrap_or_else(|| default.to_string())
}

/// Interpret a boolean flag (`1`, `true`, `yes`, `on`, case-insensitive).
pub fn is_enabled(key: &str) -> bool {
    matches!(
        get(key).as_deref().map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Publish a value to child processes. Both spellings are exported because a
/// pre-rename sidecar or runner.jar may still be present on disk.
pub fn set(key: &str, value: impl AsRef<Path>) {
    let text = value.as_ref().to_string_lossy().into_owned();
    std::env::set_var(format!("LUMA_{key}"), &text);
    std::env::set_var(format!("TVBOX_{key}"), &text);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_name_wins_and_old_name_is_still_accepted() {
        std::env::set_var("LUMA_ENV_PROBE", "new");
        std::env::set_var("TVBOX_ENV_PROBE", "old");
        assert_eq!(get("ENV_PROBE").as_deref(), Some("new"));

        std::env::remove_var("LUMA_ENV_PROBE");
        assert_eq!(get("ENV_PROBE").as_deref(), Some("old"));
        assert!(!is_enabled("ENV_PROBE"));

        std::env::set_var("LUMA_ENV_FLAG", "YES");
        assert!(is_enabled("ENV_FLAG"));
        assert_eq!(get_or("MISSING_ENV_PROBE", "fallback"), "fallback");

        std::env::remove_var("TVBOX_ENV_PROBE");
        std::env::remove_var("LUMA_ENV_FLAG");
    }
}
