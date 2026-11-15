//! Rust ↔ Python adapter stdio JSON-RPC client (spec 7.2 / T-13).
//!
//! One JSON frame per line. Requests carry an `id`; responses may arrive out of
//! order because the adapter dispatches onto a thread pool, so a dedicated
//! reader task routes frames by id instead of assuming request/response order.
//!
//! Failure handling:
//! * non-JSON line  → logged and ignored (junk is not fatal, a partial frame is)
//! * unknown id     → dropped (late frame of a timed-out call)
//! * EOF / IO error → every in-flight call fails with `SPIDER_CRASH`, the
//!   connection is marked dead and respawned on the next call
//! * per-call wall clock → `SITE_TIMEOUT`, pending entry removed

use crate::error::{code, AppError};
use crate::process::{self, Guarded};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex};

type Pending = std::sync::Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, AppError>>>>>;

/// A long-lived stdio sidecar connection. Kept `pub(crate)` so a future sidecar
/// can reuse the exact frame routing / crash detection / Job Object lifetime
/// instead of growing a second, subtly different implementation.
pub(crate) struct Conn {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    child: StdMutex<Option<Guarded>>,
    alive: AtomicBool,
    pid: AtomicU32,
    label: &'static str,
}

impl Conn {
    fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn fail_all(&self, message: &str) {
        let pending = self.pending.clone();
        // Short critical section; no await needed while draining.
        let mut guard = pending.lock().unwrap();
        for (_, sender) in guard.drain() {
            let _ = sender.send(Err(AppError::new(code::SPIDER_CRASH, message)));
        }
    }
}

fn adapter_root() -> PathBuf {
    // Dev checkout, portable folder or installed build: probe for the adapter
    // instead of assuming one resource layout (see paths::sidecar_roots).
    crate::paths::find(&["sidecars", "py", "main.py"]).unwrap_or_else(crate::paths::source_root)
}

/// Python launcher plus the working directory it needs.
///
/// The embedded distribution resolves `python311.dll` relative to its own
/// directory, so spawning it with the project root as cwd fails with
/// STATUS_DLL_NOT_FOUND. `LUMA_PYTHON` is the explicit override; otherwise we
/// probe for the bundled `sidecars/python-embed` via the same `sidecar_roots()`
/// as the adapter, so dev and shipped builds run the *same* interpreter (with
/// pycryptodome / requests / lxml). Only when no bundle is found do we fall
/// back to `python` on PATH — the case that made real spiders fail in dev with
/// `No module named 'Crypto'` while working in the portable build.
fn python_launch() -> (String, Option<PathBuf>) {
    if let Some(explicit) = crate::env::get("PYTHON") {
        return (explicit, None);
    }
    if let Some((exe, embed)) = crate::paths::embedded_python() {
        return (exe.to_string_lossy().to_string(), Some(embed));
    }
    ("python".to_string(), None)
}

/// Spawn any long-lived one-frame-per-line JSON-RPC sidecar.
///
/// `program`/`args` are resolved by the caller; the `Guarded` child (and its
/// Windows Job Object) stays owned by the connection, so a crash or shutdown
/// reaps the whole process tree. Used by `spawn_conn` (Python adapter).
pub(crate) fn spawn_stdio(
    program: &str,
    args: &[String],
    cwd: Option<&std::path::Path>,
    label: &'static str,
) -> Result<std::sync::Arc<Conn>, AppError> {
    // The wire format is UTF-8 on every platform; tell runtimes that would
    // otherwise inherit the OS code page (Python on a Chinese Windows: cp936,
    // which decoded our UTF-8 frames as GBK and broke `config.decrypt`).
    // Runtimes that do not know these variables ignore them.
    //
    // `LUMA_ADAPTER_LOG` pins the adapter's own log file into
    // `<data>/logs/spider/spider.<utc-date>.log`, so the three log channels
    // (host / UI / adapter) live in separate directories.
    let adapter_log = crate::logging::spider_log_path().display().to_string();
    let mut guarded = Guarded::spawn_with_env(
        program,
        args,
        cwd,
        &[
            ("PYTHONUTF8", "1"),
            ("PYTHONIOENCODING", "utf-8"),
            ("LUMA_ADAPTER_LOG", adapter_log.as_str()),
            // 版本单一来源是 package.json，Cargo / tauri.conf 由 build.rs 与
            // tauri.conf 的路径引用绑定到它；sidecar 运行时靠这里注入，避免
            // 适配层自己再抄一份版本号（见 `sidecars/py/main.py::VERSION`）。
            ("LUMA_VERSION", env!("CARGO_PKG_VERSION")),
        ],
    )?;
    let pid = guarded.id().unwrap_or(0);
    let stdin = guarded
        .take_stdin()
        .ok_or_else(|| AppError::new(code::INTERNAL, "sidecar stdin unavailable"))?;
    let stdout = guarded.take_stdout();

    let conn = std::sync::Arc::new(Conn {
        stdin: Mutex::new(stdin),
        pending: std::sync::Arc::new(StdMutex::new(HashMap::new())),
        next_id: AtomicU64::new(0),
        child: StdMutex::new(Some(guarded)),
        alive: AtomicBool::new(true),
        pid: AtomicU32::new(pid),
        label,
    });

    if let Some(stdout) = stdout {
        let reader_conn = conn.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let text = line.trim();
                        if text.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(text) {
                            Ok(frame) => route_frame(&reader_conn, frame).await,
                            Err(err) => {
                                tracing::warn!(
                                    error = %err,
                                    sidecar = reader_conn.label,
                                    "sidecar emitted a non-json frame"
                                );
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(err) => {
                        tracing::warn!(error = %err, "sidecar stdout read failed");
                        break;
                    }
                }
            }
            reader_conn.alive.store(false, Ordering::SeqCst);
            reader_conn.fail_all("sidecar exited unexpectedly");
            tracing::warn!(
                pid = reader_conn.pid.load(Ordering::Relaxed),
                sidecar = reader_conn.label,
                "sidecar reader stopped"
            );
        });
    }

    tracing::info!(pid, sidecar = label, "sidecar spawned");
    Ok(conn)
}

fn spawn_conn() -> Result<std::sync::Arc<Conn>, AppError> {
    let root = adapter_root();
    let script = root.join("sidecars").join("py").join("main.py");
    if !script.is_file() {
        return Err(
            AppError::new(code::RUNTIME_UNAVAILABLE, "python adapter not found")
                .with_details(json!({ "path": script })),
        );
    }
    let (python, cwd) = python_launch();
    spawn_stdio(
        &python,
        &[script.to_string_lossy().to_string()],
        cwd.as_deref().or(Some(root.as_path())),
        "python adapter",
    )
}

async fn route_frame(conn: &std::sync::Arc<Conn>, frame: Value) {
    let Some(id) = frame.get("id").and_then(Value::as_u64) else {
        tracing::warn!("adapter frame without id, dropped");
        return;
    };
    let sender = {
        let mut guard = conn.pending.lock().unwrap();
        guard.remove(&id)
    };
    let Some(sender) = sender else {
        tracing::debug!(id, "late frame for a finished call, dropped");
        return;
    };
    let outcome = if frame.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(frame.get("result").cloned().unwrap_or(Value::Null))
    } else {
        let error = frame.get("error").cloned().unwrap_or_else(|| json!({}));
        let error_code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or(code::INTERNAL);
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("adapter error");
        Err(AppError::new(error_code, message).with_details(error))
    };
    let _ = sender.send(outcome);
}

struct BridgeState {
    conn: Mutex<Option<std::sync::Arc<Conn>>>,
    restarts: AtomicU64,
}

fn state() -> &'static BridgeState {
    static STATE: OnceLock<BridgeState> = OnceLock::new();
    STATE.get_or_init(|| BridgeState {
        conn: Mutex::new(None),
        restarts: AtomicU64::new(0),
    })
}

async fn connection() -> Result<std::sync::Arc<Conn>, AppError> {
    let bridge = state();
    let mut guard = bridge.conn.lock().await;
    if let Some(existing) = guard.as_ref() {
        if existing.alive.load(Ordering::SeqCst) {
            return Ok(existing.clone());
        }
        tracing::warn!("adapter connection is dead, respawning");
        bridge.restarts.fetch_add(1, Ordering::Relaxed);
        *guard = None;
    }
    let fresh = spawn_conn()?;
    *guard = Some(fresh.clone());
    Ok(fresh)
}

/// Send one request with the default wall-clock budget.
pub async fn call(method: &str, params: Value) -> Result<Value, AppError> {
    call_with_timeout(method, params, process::call_timeout()).await
}

/// Send one request with an explicit wall-clock budget.
pub async fn call_with_timeout(
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, AppError> {
    let conn = connection().await?;
    call_on(&conn, method, params, timeout).await
}

/// Send one frame over an arbitrary shared connection.
pub(crate) async fn call_on(
    conn: &std::sync::Arc<Conn>,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, AppError> {
    let id = conn.next_id();
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = conn.pending.lock().unwrap();
        pending.insert(id, tx);
    }

    let mut line = serde_json::to_string(&json!({
        "id": id,
        "method": method,
        "params": params,
    }))?;
    line.push('\n');

    {
        let mut stdin = conn.stdin.lock().await;
        if let Err(err) = stdin.write_all(line.as_bytes()).await {
            drop(stdin);
            conn.pending.lock().unwrap().remove(&id);
            conn.alive.store(false, Ordering::SeqCst);
            return Err(AppError::new(code::SPIDER_CRASH, "write to sidecar failed")
                .with_cause(err.to_string()));
        }
        if let Err(err) = stdin.flush().await {
            drop(stdin);
            conn.pending.lock().unwrap().remove(&id);
            return Err(AppError::new(code::SPIDER_CRASH, "flush sidecar failed")
                .with_cause(err.to_string()));
        }
    }

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(err))) => Err(err),
        Ok(Err(_)) => Err(AppError::new(code::SPIDER_CRASH, "sidecar channel closed")),
        Err(_) => {
            conn.pending.lock().unwrap().remove(&id);
            // 宿主已经放弃这次调用，但 sidecar 里的 worker 还在跑（`spider.py` 可以
            // 一直占到子进程结束）。不发取消帧的话，用户的下一次重试就排在一个没
            // 人等的调用后面，看到的还是同一条超时。fire-and-forget：调用方已经拿
            // 到错误，绝不能再让它等 stdin。
            tracing::warn!(
                method,
                timeout_ms = timeout.as_millis() as u64,
                sidecar = conn.label,
                "adapter call timed out, cancel frame queued"
            );
            spawn_cancel(conn, id);
            Err(AppError::new(
                code::SITE_TIMEOUT,
                format!("{} {method} exceeded {}ms", conn.label, timeout.as_millis()),
            ))
        }
    }
}

/// Fire-and-forget `__cancel__` for a request the host already gave up on.
///
/// The sidecar only checks the flag between steps, so this cannot free a worker
/// that is blocked inside a child process — but it keeps queued work from piling
/// up behind a call nobody is waiting for any more.
fn spawn_cancel(conn: &std::sync::Arc<Conn>, target_id: u64) {
    let conn = conn.clone();
    tauri::async_runtime::spawn(async move {
        let id = conn.next_id();
        let mut line = match serde_json::to_string(&json!({
            "id": id,
            "method": "__cancel__",
            "params": { "targetId": target_id },
        })) {
            Ok(text) => text,
            Err(err) => {
                tracing::debug!(error = %err, "cancel frame serialization failed");
                return;
            }
        };
        line.push('\n');
        let mut stdin = conn.stdin.lock().await;
        if let Err(err) = stdin.write_all(line.as_bytes()).await {
            tracing::debug!(error = %err, target_id, "cancel frame write failed");
            return;
        }
        if let Err(err) = stdin.flush().await {
            tracing::debug!(error = %err, target_id, "cancel frame flush failed");
        }
    });
}

/// Kill a dead/retired sidecar together with its Job Object.
async fn kill_conn(conn: &std::sync::Arc<Conn>) {
    conn.alive.store(false, Ordering::SeqCst);
    conn.fail_all("sidecar shut down");
    let child = conn
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(mut child) = child {
        child.kill().await;
    }
}

/// Best-effort cancel frame for an in-flight request id.
pub async fn cancel(target_id: u64) -> Result<Value, AppError> {
    let conn = connection().await?;
    let id = conn.next_id();
    let mut line = serde_json::to_string(&json!({
        "id": id,
        "method": "__cancel__",
        "params": { "targetId": target_id },
    }))?;
    line.push('\n');
    let mut stdin = conn.stdin.lock().await;
    stdin.write_all(line.as_bytes()).await.map_err(|err| {
        AppError::new(code::SPIDER_CRASH, "write cancel failed").with_cause(err.to_string())
    })?;
    stdin.flush().await.map_err(|err| {
        AppError::new(code::SPIDER_CRASH, "flush cancel failed").with_cause(err.to_string())
    })?;
    Ok(json!({ "cancelled": target_id }))
}

pub async fn ping() -> Result<Value, AppError> {
    call("ping", json!({})).await
}

/// Number of respawns since start; surfaced for diagnostics and tests.
pub fn restart_count() -> u64 {
    state().restarts.load(Ordering::Relaxed)
}

pub fn adapter_pid() -> Option<u32> {
    let bridge = state();
    let guard = bridge.conn.try_lock().ok()?;
    let pid = guard.as_ref()?.pid.load(Ordering::Relaxed);
    (pid != 0).then_some(pid)
}

/// Stop the adapter; the next call spawns a fresh one.
pub async fn shutdown() {
    let bridge = state();
    let mut guard = bridge.conn.lock().await;
    if let Some(conn) = guard.take() {
        kill_conn(&conn).await;
    }
}
