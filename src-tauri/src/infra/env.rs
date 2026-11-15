//! Product-scoped environment variables.
//!
//! `LUMA_*` is the only spelling. Every read goes through this module so the
//! prefix stays consistent across host commands, sidecars and probes.

use std::path::Path;

fn non_empty(value: Result<String, std::env::VarError>) -> Option<String> {
    value.ok().filter(|text| !text.trim().is_empty())
}

/// Read `LUMA_<key>`.
pub fn get(key: &str) -> Option<String> {
    non_empty(std::env::var(format!("LUMA_{key}")))
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

/// Publish a value to child processes.
pub fn set(key: &str, value: impl AsRef<Path>) {
    let text = value.as_ref().to_string_lossy().into_owned();
    std::env::set_var(format!("LUMA_{key}"), &text);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_and_flags_use_luma_prefix() {
        std::env::set_var("LUMA_ENV_PROBE", "new");
        assert_eq!(get("ENV_PROBE").as_deref(), Some("new"));

        std::env::set_var("LUMA_ENV_FLAG", "YES");
        assert!(is_enabled("ENV_FLAG"));
        assert_eq!(get_or("MISSING_ENV_PROBE", "fallback"), "fallback");

        std::env::remove_var("LUMA_ENV_PROBE");
        std::env::remove_var("LUMA_ENV_FLAG");
    }
}
