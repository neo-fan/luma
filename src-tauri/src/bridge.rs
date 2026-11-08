//! Minimal stdio JSON-RPC client for the Python adapter (spec 7.2).
//!
//! Parsing logic lives in `sidecars/py/` only; Rust forwards raw payloads and
//! consumes normalized results. Concurrency is serialized here on purpose —
//! T-13 replaces this with the full `bridge.rs` (id matching, cancel frames,
//! crash restart, epoch handling).

use crate::error::{code, AppError};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

const CALL_TIMEOUT: Duration = Duration::from_secs(15);

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Sidecar {
    fn spawn() -> Result<Self, AppError> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
            .unwrap_or_default();
        let script = root.join("sidecars").join("py").join("main.py");
        if !script.is_file() {
            return Err(AppError::new(code::RUNTIME_UNAVAILABLE, "python adapter not found")
                .with_details(json!({ "path": script })));
        }
        let python = std::env::var("TVBOX_PYTHON").unwrap_or_else(|_| "python".to_string());
        let mut child = Command::new(&python)
            .arg(&script)
            .current_dir(&root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|err| {
                AppError::new(code::RUNTIME_UNAVAILABLE, format!("spawn {python} failed"))
                    .with_cause(err.to_string())
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::new(code::INTERNAL, "adapter stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::new(code::INTERNAL, "adapter stdout unavailable"))?;
        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
        })
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value, AppError> {
        self.next_id += 1;
        let request_id = self.next_id;
        let mut line = serde_json::to_string(&json!({
            "id": request_id,
            "method": method,
            "params": params,
        }))?;
        line.push('\n');

        self.stdin.write_all(line.as_bytes()).await.map_err(|err| {
            AppError::new(code::SPIDER_CRASH, "write to adapter failed").with_cause(err.to_string())
        })?;
        self.stdin.flush().await.map_err(|err| {
            AppError::new(code::SPIDER_CRASH, "flush adapter failed").with_cause(err.to_string())
        })?;

        let mut buffer = String::new();
        let read = tokio::time::timeout(CALL_TIMEOUT, self.stdout.read_line(&mut buffer)).await;
        let bytes = match read {
            Ok(Ok(n)) => n,
            Ok(Err(err)) => {
                return Err(AppError::new(code::SPIDER_CRASH, "read adapter failed")
                    .with_cause(err.to_string()))
            }
            Err(_) => {
                return Err(AppError::new(code::SITE_TIMEOUT, format!("adapter {method} timed out")))
            }
        };
        if bytes == 0 {
            return Err(AppError::new(code::SPIDER_CRASH, "adapter exited unexpectedly"));
        }

        let response: Value = serde_json::from_str(&buffer)?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            let error = response.get("error").cloned().unwrap_or_else(|| json!({}));
            let error_code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or(code::INTERNAL);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("adapter error");
            return Err(AppError::new(error_code, message).with_details(error));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
}

static SIDECAR: OnceLock<Mutex<Option<Sidecar>>> = OnceLock::new();

/// Send one request to the adapter, spawning it on first use.
pub async fn call(method: &str, params: Value) -> Result<Value, AppError> {
    let lock = SIDECAR.get_or_init(|| Mutex::new(None));
    let mut guard = lock.lock().await;
    if guard.is_none() {
        *guard = Some(Sidecar::spawn()?);
    }
    let sidecar = guard
        .as_mut()
        .ok_or_else(|| AppError::new(code::INTERNAL, "adapter unavailable"))?;
    sidecar.call(method, params).await
}

/// Stop the adapter (tests and app shutdown).
pub async fn shutdown() {
    if let Some(lock) = SIDECAR.get() {
        let mut guard = lock.lock().await;
        if let Some(mut sidecar) = guard.take() {
            let _ = sidecar.child.kill().await;
        }
    }
}
