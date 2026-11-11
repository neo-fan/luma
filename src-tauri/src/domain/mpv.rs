//! mpv fallback (spec 8.6 / T-30).
//!
//! WebView2 cannot decode every codec (notably HEVC on machines without the
//! HEVC extension). When the `<video>` element reports a decode error the
//! frontend calls `mpv_play`, which launches the bundled `mpv.exe` with the
//! IPC pipe name from the spec. The process is intentionally **not** tied to a
//! Job Object: mpv is a user-facing player window and must survive the app.

use crate::error::{code, AppError};
use serde_json::json;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const MPV_PIPE: &str = r"\\.\pipe\luma-mpv";

fn mpv_path() -> Option<PathBuf> {
    if let Some(explicit) = crate::env::get("MPV") {
        let path = PathBuf::from(explicit);
        return path.is_file().then_some(path);
    }
    crate::paths::sidecar_roots()
        .into_iter()
        .flat_map(|root| {
            [
                root.join("sidecars").join("mpv").join("mpv.exe"),
                // Installed layouts that keep resources in a sibling folder.
                root.join("resources").join("sidecars").join("mpv").join("mpv.exe"),
            ]
        })
        .find(|candidate| candidate.is_file())
}

/// Start mpv for `url`. Returns the child pid so the UI can report/stop it.
#[tauri::command]
pub fn mpv_play(
    url: String,
    title: Option<String>,
    headers: Option<Vec<(String, String)>>,
) -> Result<serde_json::Value, AppError> {
    let parsed = url::Url::parse(&url)
        .map_err(|err| AppError::new(code::INVALID_ARGUMENT, "mpv url invalid").with_cause(err.to_string()))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new(
            code::INVALID_ARGUMENT,
            format!("mpv cannot open scheme {}", parsed.scheme()),
        ));
    }

    let exe = mpv_path().ok_or_else(|| {
        AppError::new(
            code::RUNTIME_UNAVAILABLE,
            "mpv.exe not found (place it in sidecars/mpv or set LUMA_MPV)",
        )
    })?;

    let mut command = Command::new(&exe);
    command
        .arg(format!("--input-ipc-server={MPV_PIPE}"))
        .arg("--no-terminal")
        .arg("--force-window=yes")
        // The bundled build is a single portable exe; this keeps it from
        // writing watch-later state next to the executable in a read-only dir.
        .arg("--save-position-on-quit=no")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(title) = title.filter(|value| !value.trim().is_empty()) {
        command.arg(format!("--force-media-title={title}"));
    }
    // Anti-leech sources need the same headers the proxy would have sent.
    if let Some(headers) = headers {
        let joined = headers
            .iter()
            .filter(|(name, value)| !name.is_empty() && !value.is_empty())
            .map(|(name, value)| format!("{name}: {value}"))
            .collect::<Vec<_>>()
            .join(",");
        if !joined.is_empty() {
            command.arg(format!("--http-header-fields={joined}"));
        }
    }
    command.arg(&url);

    let child = command.spawn().map_err(|err| {
        AppError::new(code::RUNTIME_UNAVAILABLE, "failed to launch mpv")
            .with_cause(err.to_string())
    })?;
    let pid = child.id();
    tracing::info!(pid, %url, "mpv launched");
    Ok(json!({ "pid": pid, "pipe": MPV_PIPE, "player": "mpv" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_mpv_is_reported_not_panicked() {
        std::env::remove_var("LUMA_MPV");
        std::env::remove_var("TVBOX_MPV");
        // Path resolution must never panic even when the binary is absent.
        let _ = mpv_path();
    }

    #[test]
    fn rejects_non_http_schemes() {
        // Guard clause runs before any filesystem/process work.
        let err = mpv_play("file:///etc/passwd".to_string(), None, None)
            .expect_err("scheme must be rejected");
        assert_eq!(err.code, code::INVALID_ARGUMENT);
    }
}
