//! JVM / jar spider runtime (spec 7.3 / 8.3 / 8.4, P2 T-24 ~ T-26).
//!
//! A single long-lived `SpiderRunner` JVM is spawned by Rust through
//! `process::Guarded` (Windows Job Object), then shared by every jar site.
//! The stdio one-frame-per-line protocol, id routing and wall-clock timeout
//! are the very same ones used by the Python adapter (`bridge::call_on`), so
//! a hung jar cannot escape a process-level kill.
//!
//! T-26 circuit breaking is done here, before the JVM is touched:
//! * a jar is probed once (class / dex / missing) and the verdict cached;
//! * Android `classes.dex` jars fail fast with an explicit reason instead of
//!   spinning up work for 28 dead sites on every search;
//! * three consecutive timeouts/crashes on one site disable only that site.

use crate::bridge;
use crate::error::{code, AppError};
use crate::spider::{RuntimeKind, SpiderMethod, SpiderRuntime};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::sync::Mutex;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const CIRCUIT_THRESHOLD: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JarKind {
    Class,
    Dex,
    Missing,
}

fn verdicts() -> &'static StdMutex<HashMap<String, JarKind>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, JarKind>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn failures() -> &'static StdMutex<HashMap<String, u32>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, u32>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn disabled() -> &'static StdMutex<HashSet<String>> {
    static CACHE: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashSet::new()))
}

fn project_root() -> PathBuf {
    // Same multi-layout probing as bridge::adapter_root.
    crate::paths::find(&["sidecars", "java", "runner.jar"]).unwrap_or_else(crate::paths::source_root)
}

/// The JRE shipped with the app, if `prepare_runtime.py` built it.
///
/// Mirrors `paths::embedded_python()`: dev picks the checkout copy, portable
/// picks the resource-dir copy, with no env var to remember.
fn bundled_java() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    let root = crate::paths::find(&["sidecars", "jre", "bin", exe])?;
    let java = root.join("sidecars").join("jre").join("bin").join(exe);
    java.is_file().then_some(java)
}

/// Resolve the JVM launcher. Priority: explicit override -> bundled JRE ->
/// JAVA_HOME -> PATH. Falling back to a host JDK first means dev runs a
/// different VM than the portable build, i.e. the exact dev/prod drift
/// `embedded_python()` was written to avoid.
fn resolve_java() -> String {
    if let Some(explicit) = crate::env::get("JAVA") {
        return explicit;
    }
    if let Some(bundled) = bundled_java() {
        return bundled.to_string_lossy().to_string();
    }
    let exe = if cfg!(windows) { "java.exe" } else { "java" };
    if let Ok(home) = std::env::var("JAVA_HOME") {
        let candidate = PathBuf::from(home).join("bin").join(exe);
        if candidate.is_file() {
            return candidate.to_string_lossy().to_string();
        }
    }
    exe.to_string()
}

/// Resolve the JVM launcher and the runner jar. No absolute machine path is
/// baked in: `LUMA_JAVA` / `LUMA_JVM_RUNNER` and the shipped `sidecars/jre`
/// decide at runtime.
fn jvm_command() -> Result<(String, Vec<String>), AppError> {
    let runner = match crate::env::get("JVM_RUNNER") {
        Some(path) => PathBuf::from(path),
        None => project_root().join("sidecars").join("java").join("runner.jar"),
    };
    if !runner.is_file() {
        return Err(AppError::new(
            code::RUNTIME_UNAVAILABLE,
            "jvm runner.jar not found (build it with `python sidecars/java/build.py`)",
        )
        .with_details(json!({ "path": runner })));
    }

    let java = resolve_java();
    let port = crate::env::get_or("PROXY_PORT", "9978");

    Ok((
        java,
        vec![
            format!("-Dluma.proxy.port={port}"),
            // A pre-rename runner.jar still reads the old property.
            format!("-Dtvbox.proxy.port={port}"),
            "-cp".to_string(),
            runner.to_string_lossy().to_string(),
            "SpiderRunner".to_string(),
        ],
    ))
}

/// One JVM per host process; a dead connection is reaped and respawned on the
/// next call (T-24: 50 consecutive calls must not start 50 JVMs).
fn state() -> &'static Mutex<Option<std::sync::Arc<bridge::Conn>>> {
    static STATE: OnceLock<Mutex<Option<std::sync::Arc<bridge::Conn>>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(None))
}

async fn connection() -> Result<std::sync::Arc<bridge::Conn>, AppError> {
    let mut guard = state().lock().await;
    if let Some(existing) = guard.as_ref() {
        if bridge::conn_alive(existing) {
            return Ok(existing.clone());
        }
        tracing::warn!("jvm runner connection is dead, respawning");
        bridge::kill_conn(existing).await;
        *guard = None;
    }
    let (java, args) = jvm_command()?;
    let fresh = bridge::spawn_stdio(&java, &args, None, "jvm runner")?;
    *guard = Some(fresh.clone());
    Ok(fresh)
}

/// PID of the shared JVM, for diagnostics and the P2 acceptance probe.
pub fn runner_pid() -> Option<u32> {
    let guard = state().try_lock().ok()?;
    bridge::conn_pid(guard.as_ref()?)
}

fn jar_for(site: &Value) -> String {
    let jar = site.get("jar").and_then(Value::as_str).unwrap_or("");
    if !jar.is_empty() {
        return jar.to_string();
    }
    let api = site.get("api").and_then(Value::as_str).unwrap_or("");
    if api.ends_with(".jar") {
        return api.to_string();
    }
    String::new()
}

/// 8.5: `ext` must reach `Spider.init(Context, String)` byte-for-byte. Object
/// ext values are serialized instead of dropped.
fn ext_for(site: &Value) -> String {
    match site.get("ext") {
        Some(Value::String(text)) => text.clone(),
        Some(value @ (Value::Object(_) | Value::Array(_))) => {
            serde_json::to_string(value).unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn note_failure(key: &str, err: &AppError) {
    if err.code != code::SITE_TIMEOUT && err.code != code::SPIDER_CRASH {
        return;
    }
    if key.is_empty() {
        return;
    }
    let count = {
        let mut guard = failures()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = guard.entry(key.to_string()).or_insert(0);
        *entry += 1;
        *entry
    };
    if count >= CIRCUIT_THRESHOLD {
        disabled()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key.to_string());
        tracing::warn!(site = key, count, "source circuit-broken after repeated failures");
    }
}

fn clear_failures(key: &str) {
    if key.is_empty() {
        return;
    }
    failures()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(key);
}

fn is_disabled(key: &str) -> bool {
    !key.is_empty()
        && disabled()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(key)
}

fn cached_verdict(jar: &str) -> Option<JarKind> {
    verdicts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(jar)
        .copied()
}

fn probe_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Singleflight jar probe. A real config can have 28 `csp_*` sites sharing one
/// global spider jar; without this lock the first fan-out would download and
/// probe that jar 28 times in parallel and burn the whole wall-clock budget.
async fn probe_verdict(jar: &str, key: &str, timeout: Duration) -> Result<JarKind, AppError> {
    if let Some(kind) = cached_verdict(jar) {
        return Ok(kind);
    }
    let _guard = probe_lock().lock().await;
    if let Some(kind) = cached_verdict(jar) {
        return Ok(kind);
    }
    let conn = connection().await?;
    let frame = match bridge::call_on(
        &conn,
        "probe",
        json!({ "jar": jar }),
        timeout.min(PROBE_TIMEOUT),
    )
    .await
    {
        Ok(frame) => frame,
        Err(err) => {
            note_failure(key, &err);
            return Err(err);
        }
    };
    let kind = match frame.get("kind").and_then(Value::as_str) {
        Some("class") => JarKind::Class,
        Some("dex") => JarKind::Dex,
        _ => JarKind::Missing,
    };
    verdicts()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(jar.to_string(), kind);
    Ok(kind)
}

fn normalize_error(err: AppError, jar: &str) -> AppError {
    // The JVM side uses JAR_UNAVAILABLE for a missing/unreadable jar; the Rust
    // contract only knows RUNTIME_UNAVAILABLE.
    if err.code == "JAR_UNAVAILABLE" {
        return AppError::new(code::RUNTIME_UNAVAILABLE, err.message.clone())
            .with_details(json!({ "jar": jar }));
    }
    err
}

pub struct JvmRuntime;

#[async_trait]
impl SpiderRuntime for JvmRuntime {
    fn kind(&self) -> RuntimeKind {
        RuntimeKind::Jvm
    }

    async fn invoke(
        &self,
        site: &Value,
        method: SpiderMethod,
        args: &[Value],
        timeout: Duration,
    ) -> Result<Value, AppError> {
        let key = site.get("key").and_then(Value::as_str).unwrap_or("");
        let jar = jar_for(site);
        if jar.is_empty() {
            return Err(AppError::new(
                code::INVALID_ARGUMENT,
                "jvm site has no spider jar (re-import the config to attach the global spider)",
            ));
        }
        if is_disabled(key) {
            return Err(AppError::new(
                code::RUNTIME_UNAVAILABLE,
                "source disabled by circuit breaker after repeated timeouts/crashes",
            )
            .with_details(json!({ "siteKey": key })));
        }

        let verdict = probe_verdict(&jar, key, timeout).await?;

        if verdict != JarKind::Class {
            let reason = if verdict == JarKind::Dex {
                "spider jar is an Android dex (classes.dex); Win x64 has no Android runtime"
            } else {
                "spider jar is missing or unreadable"
            };
            return Err(AppError::new(code::RUNTIME_UNAVAILABLE, reason)
                .with_details(json!({ "jar": jar, "kind": format!("{verdict:?}") })));
        }

        let conn = connection().await?;
        let params = json!({
            "jar": jar,
            "api": site.get("api").and_then(Value::as_str).unwrap_or(""),
            "className": site.get("className").and_then(Value::as_str).unwrap_or(""),
            "method": method.as_str(),
            "args": args,
            "ext": ext_for(site),
            "siteKey": key,
            "timeoutMs": timeout.as_millis() as u64,
        });
        match bridge::call_on(&conn, "invoke", params, timeout).await {
            Ok(value) => {
                clear_failures(key);
                Ok(value)
            }
            Err(err) => {
                note_failure(key, &err);
                Err(normalize_error(err, &jar))
            }
        }
    }

    async fn health(&self) -> Result<(), AppError> {
        let conn = connection().await?;
        bridge::call_on(&conn, "ping", json!({}), Duration::from_secs(5))
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_injects_proxy_port_and_runner() {
        // Only the shape is asserted; the runner path depends on the checkout.
        let (java, args) = jvm_command().expect("runner.jar is built");
        assert!(!java.is_empty());
        assert!(args.iter().any(|a| a.starts_with("-Dluma.proxy.port=")));
        assert!(args.iter().any(|a| a.starts_with("-Dtvbox.proxy.port=")));
        assert_eq!(args.last().map(String::as_str), Some("SpiderRunner"));
        assert!(args.iter().any(|a| a.ends_with("runner.jar")));
    }

    #[test]
    fn bundled_jre_is_preferred_when_present() {
        if let Some(path) = bundled_java() {
            assert!(path.is_file());
            let exe = if cfg!(windows) { "java.exe" } else { "java" };
            assert!(path.ends_with(exe));
            if crate::env::get("JAVA").is_none() {
                assert_eq!(resolve_java(), path.to_string_lossy().to_string());
            }
        }
    }

    #[test]
    fn jar_falls_back_to_api_when_site_has_no_jar() {
        let site = json!({ "key": "demo", "api": "http://127.0.0.1:8787/template.jar" });
        assert_eq!(jar_for(&site), "http://127.0.0.1:8787/template.jar");
        let csp = json!({ "key": "csp_Demo", "api": "csp_Demo" });
        assert_eq!(jar_for(&csp), "");
    }

    #[test]
    fn object_ext_is_serialized_not_dropped() {
        let site = json!({ "ext": { "a": 1 } });
        assert_eq!(ext_for(&site), r#"{"a":1}"#);
        let plain = json!({ "ext": "raw-ext" });
        assert_eq!(ext_for(&plain), "raw-ext");
    }

    #[test]
    fn circuit_breaker_only_trips_on_timeout_or_crash() {
        let key = "unit-circuit-only";
        disabled()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key);
        failures()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key);
        for _ in 0..2 {
            note_failure(key, &AppError::new(code::RUNTIME_UNAVAILABLE, "nope"));
        }
        assert!(!is_disabled(key), "non-crash errors must not trip the breaker");
        for _ in 0..CIRCUIT_THRESHOLD {
            note_failure(key, &AppError::new(code::SITE_TIMEOUT, "slow"));
        }
        assert!(is_disabled(key));
        clear_failures(key);
        disabled()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(key);
    }

    #[test]
    fn jar_unavailable_maps_to_contract_code() {
        let err = AppError::new("JAR_UNAVAILABLE", "missing");
        assert_eq!(
            normalize_error(err, "x.jar").code,
            code::RUNTIME_UNAVAILABLE
        );
    }
}
