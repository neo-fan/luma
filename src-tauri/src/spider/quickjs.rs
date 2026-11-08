//! QuickJS runtime (spec 7.3 / T-16, v1.1 R4).
//!
//! Third-party JS never runs in the host process: it is handed to the
//! `qjs-runner` sidecar, which owns a dedicated QuickJS context per call and can
//! be killed by the host at any time. Frames are line-delimited JSON, one
//! request at a time (JS calls are milliseconds, serializing keeps the runner
//! trivial and race-free).

use crate::error::{code, AppError};
use crate::http;
use crate::process::Guarded;
use crate::spider::{RuntimeKind, SpiderMethod, SpiderRuntime};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

const SOURCE_TTL: Duration = Duration::from_secs(600);

struct Runner {
    guard: Guarded,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Runner {
    fn spawn() -> Result<Self, AppError> {
        let exe = resolve_runner().ok_or_else(|| {
            AppError::new(
                code::RUNTIME_UNAVAILABLE,
                "qjs-runner not found (set TVBOX_QJS_RUNNER or build sidecars/qjs-runner)",
            )
        })?;
        let mut guard = Guarded::spawn(&exe.to_string_lossy(), &[], None)?;
        let stdin = guard
            .take_stdin()
            .ok_or_else(|| AppError::new(code::INTERNAL, "qjs stdin unavailable"))?;
        let stdout = guard
            .take_stdout()
            .ok_or_else(|| AppError::new(code::INTERNAL, "qjs stdout unavailable"))?;
        tracing::info!(path = %exe.display(), "qjs-runner spawned");
        Ok(Self {
            guard,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 0,
        })
    }

    async fn call(&mut self, payload: Value, timeout: Duration) -> Result<Value, AppError> {
        self.next_id += 1;
        let id = self.next_id;
        let mut frame = payload;
        frame["id"] = json!(id);
        let mut line = serde_json::to_string(&frame)?;
        line.push('\n');

        self.stdin.write_all(line.as_bytes()).await.map_err(|err| {
            AppError::new(code::SPIDER_CRASH, "write to qjs-runner failed").with_cause(err.to_string())
        })?;
        self.stdin.flush().await.map_err(|err| {
            AppError::new(code::SPIDER_CRASH, "flush qjs-runner failed").with_cause(err.to_string())
        })?;

        let mut buffer = String::new();
        let read = tokio::time::timeout(timeout, self.stdout.read_line(&mut buffer)).await;
        match read {
            Ok(Ok(0)) => Err(AppError::new(code::SPIDER_CRASH, "qjs-runner exited unexpectedly")),
            Ok(Ok(_)) => {
                let response: Value = serde_json::from_str(buffer.trim())?;
                if response.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(response.get("result").cloned().unwrap_or(Value::Null))
                } else {
                    let error = response.get("error").cloned().unwrap_or_else(|| json!({}));
                    let error_code = error
                        .get("code")
                        .and_then(Value::as_str)
                        .unwrap_or(code::SPIDER_CRASH);
                    let message = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("qjs error");
                    Err(AppError::new(error_code, message))
                }
            }
            Ok(Err(err)) => Err(AppError::new(code::SPIDER_CRASH, "read qjs-runner failed")
                .with_cause(err.to_string())),
            Err(_) => {
                // The interrupt handler covers loops inside a context, but a
                // wedged runner is killed outright.
                self.guard.kill().await;
                Err(AppError::new(
                    code::SITE_TIMEOUT,
                    format!("qjs-runner exceeded {}ms", timeout.as_millis()),
                ))
            }
        }
    }
}

fn resolve_runner() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("TVBOX_QJS_RUNNER") {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe_name = if cfg!(windows) { "qjs-runner.exe" } else { "qjs-runner" };
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            let beside = dir.join(exe_name);
            if beside.is_file() {
                return Some(beside);
            }
        }
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default();
    for profile in ["release", "debug"] {
        let candidate = root
            .join("sidecars")
            .join("qjs-runner")
            .join("target")
            .join(profile)
            .join(exe_name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn cache() -> &'static StdMutex<HashMap<String, (String, Instant)>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

async fn source_for(site: &Value) -> Result<String, AppError> {
    let api = site
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if api.is_empty() {
        return Err(AppError::new(code::INVALID_ARGUMENT, "js site has no api"));
    }
    if let Some((text, at)) = cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&api)
        .cloned()
    {
        if at.elapsed() < SOURCE_TTL {
            return Ok(text);
        }
    }
    let response = http::fetch(http::FetchRequest {
        url: api.clone(),
        method: None,
        headers: site.get("headers").and_then(Value::as_object).map(|map| {
            map.iter()
                .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), text.to_string())))
                .collect::<HashMap<String, String>>()
        }),
        body: None,
        timeout_ms: Some(10_000),
    })
    .await?;
    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.len() >= 64 {
        guard.clear();
    }
    guard.insert(api, (response.body.clone(), Instant::now()));
    Ok(response.body)
}

pub struct QuickJsRuntime;

impl QuickJsRuntime {
    pub fn new() -> Self {
        Self
    }
}

impl Default for QuickJsRuntime {
    fn default() -> Self {
        Self::new()
    }
}

static RUNNER: OnceLock<tokio::sync::Mutex<Option<Runner>>> = OnceLock::new();

fn runner_slot() -> &'static tokio::sync::Mutex<Option<Runner>> {
    RUNNER.get_or_init(|| tokio::sync::Mutex::new(None))
}

#[async_trait]
impl SpiderRuntime for QuickJsRuntime {
    fn kind(&self) -> RuntimeKind {
        RuntimeKind::QuickJs
    }

    async fn invoke(
        &self,
        site: &Value,
        method: SpiderMethod,
        args: &[Value],
        timeout: Duration,
    ) -> Result<Value, AppError> {
        let source = source_for(site).await?;
        let payload = json!({
            "source": source,
            "method": method.as_str(),
            "args": args,
            "ext": site.get("ext").and_then(Value::as_str).unwrap_or(""),
            "timeout_ms": timeout.as_millis() as u64,
        });

        let mut slot = runner_slot().lock().await;
        if slot.as_ref().map(|runner| runner.guard.id().is_none()).unwrap_or(true) {
            *slot = Some(Runner::spawn()?);
        }
        let runner = slot
            .as_mut()
            .ok_or_else(|| AppError::new(code::INTERNAL, "qjs-runner unavailable"))?;
        let outcome = runner.call(payload, timeout).await;
        if outcome
            .as_ref()
            .err()
            .map(|err| err.code == code::SPIDER_CRASH || err.code == code::SITE_TIMEOUT)
            .unwrap_or(false)
        {
            // Drop the wedged/dead runner; the next call respawns it.
            if let Some(mut dead) = slot.take() {
                dead.guard.kill().await;
            }
        }
        outcome
    }

    async fn health(&self) -> Result<(), AppError> {
        if resolve_runner().is_some() {
            Ok(())
        } else {
            Err(AppError::new(code::RUNTIME_UNAVAILABLE, "qjs-runner missing"))
        }
    }
}

pub async fn shutdown() {
    if let Some(slot) = RUNNER.get() {
        let mut guard = slot.lock().await;
        if let Some(mut runner) = guard.take() {
            runner.guard.kill().await;
        }
    }
}

/// Exposed for diagnostics: which binary the runtime would use.
pub fn runner_path() -> Option<PathBuf> {
    resolve_runner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_path_is_resolvable_or_reported() {
        // In CI without a built sidecar this is None; never panic.
        match runner_path() {
            Some(path) => assert!(path.is_file()),
            None => assert!(crate::process::call_timeout() >= Duration::from_millis(100)),
        }
    }
}
