//! Spider runtime dispatch (spec 7.3 / 8.3 / T-17).
//!
//! `route()` maps a normalized site to one runtime; every runtime implements
//! `SpiderRuntime` and returns TVBox-shaped JSON. CMS lives in-process while
//! py / js / jar are isolated sidecars. `spider_invoke` with `siteKey = "all"`
//! fans out over the usable sites of the active config with bounded
//! concurrency and a shared wall clock, so a single dead source never blocks
//! the home page. P2 adds the JVM/jar runtime; unsupported Android dex jars
//! fail fast with a reason instead of being silently skipped.

pub mod cms;
pub mod jvm;
pub mod python;
pub mod quickjs;

use crate::config::ConfigStore;
use crate::error::{code, AppError};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
pub const MAX_FANOUT: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpiderMethod {
    HomeContent,
    CategoryContent,
    DetailContent,
    SearchContent,
    PlayerContent,
    LiveContent,
}

impl SpiderMethod {
    /// Wire name used by the Python adapter (`homeContent` … `liveContent`).
    pub fn as_str(self) -> &'static str {
        match self {
            SpiderMethod::HomeContent => "homeContent",
            SpiderMethod::CategoryContent => "categoryContent",
            SpiderMethod::DetailContent => "detailContent",
            SpiderMethod::SearchContent => "searchContent",
            SpiderMethod::PlayerContent => "playerContent",
            SpiderMethod::LiveContent => "liveContent",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeKind {
    Cms,
    Python,
    QuickJs,
    Jvm,
}

impl RuntimeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RuntimeKind::Cms => "cms",
            RuntimeKind::Python => "python",
            RuntimeKind::QuickJs => "quickjs",
            RuntimeKind::Jvm => "jvm",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpiderRequest {
    pub site_key: String,
    pub method: SpiderMethod,
    #[serde(default)]
    pub args: Vec<Value>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Spec 7.3 trait; implementations must be stateless and cheap to clone.
#[async_trait]
pub trait SpiderRuntime: Send + Sync {
    fn kind(&self) -> RuntimeKind;

    async fn invoke(
        &self,
        site: &Value,
        method: SpiderMethod,
        args: &[Value],
        timeout: Duration,
    ) -> Result<Value, AppError>;

    async fn health(&self) -> Result<(), AppError>;

    /// TVBox local proxy (`/proxy?do=py|jar`). Sources that implement
    /// `Spider.proxy(Map)` hand back URLs pointing at the host; this turns the
    /// query map into the spider call and returns its bytes. Runtimes without
    /// such an implementation keep the default error.
    async fn proxy(
        &self,
        _site: &Value,
        _params: HashMap<String, String>,
        _timeout: Duration,
    ) -> Result<ProxyPayload, AppError> {
        Err(AppError::new(
            code::RUNTIME_UNAVAILABLE,
            "this runtime does not implement proxy()",
        ))
    }
}

/// Payload returned by `Spider.proxy(Map)`:
/// `[contentType, headers, bytes]` flattened for the HTTP response.
pub struct ProxyPayload {
    pub content_type: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

static LAST_PLAY: OnceLock<StdMutex<Option<Value>>> = OnceLock::new();

fn last_play_cell() -> &'static StdMutex<Option<Value>> {
    LAST_PLAY.get_or_init(|| StdMutex::new(None))
}

/// Remember which site produced the current play session. TVBox's local proxy
/// carries only `do=py|jar`, not a site key, so the host tracks the last
/// `playerContent` caller (one player window).
pub fn note_play_site(site: &Value) {
    if let Ok(mut guard) = last_play_cell().lock() {
        *guard = Some(site.clone());
    }
}

pub fn last_play_site() -> Option<Value> {
    last_play_cell()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

pub fn decode_proxy_payload(value: &Value) -> Result<ProxyPayload, AppError> {
    let content_type = value
        .get("contentType")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    let mut headers = Vec::new();
    if let Some(map) = value.get("headers").and_then(Value::as_object) {
        for (name, item) in map {
            if let Some(text) = item.as_str() {
                headers.push((name.clone(), text.to_string()));
            }
        }
    }
    let encoded = value.get("body").and_then(Value::as_str).unwrap_or("");
    let body = crate::proxy::base64_decode(encoded)
        .map_err(|_| AppError::new(code::INTERNAL, "proxy body is not valid base64"))?;
    Ok(ProxyPayload {
        content_type,
        headers,
        body,
    })
}

pub async fn proxy_call(
    site: &Value,
    params: HashMap<String, String>,
    timeout: Duration,
) -> Result<ProxyPayload, AppError> {
    let kind = route(site);
    let runtime = runtime_for(kind).ok_or_else(|| {
        AppError::new(
            code::RUNTIME_UNAVAILABLE,
            format!("runtime {} is not available", kind.as_str()),
        )
    })?;
    runtime.proxy(site, params, timeout).await
}

pub fn route(site: &Value) -> RuntimeKind {
    let jar = site.get("jar").and_then(Value::as_str).unwrap_or("");
    let api = site.get("api").and_then(Value::as_str).unwrap_or("");
    let key = site.get("key").and_then(Value::as_str).unwrap_or("");

    // Heuristics first: persisted snapshots may carry a `runtime` computed by an
    // older normalizer, so the raw fields stay authoritative.
    if jar == "py" || api.ends_with(".py") {
        return RuntimeKind::Python;
    }
    if jar == "js" || api.ends_with(".js") {
        return RuntimeKind::QuickJs;
    }
    if key.starts_with("csp_") || jar.ends_with(".jar") {
        return RuntimeKind::Jvm;
    }
    // A bare identifier (not a URL) means "spider class", which needs the jar.
    if api.starts_with("csp_") || (!api.is_empty() && !api.starts_with("http") && !api.contains('/')) {
        return RuntimeKind::Jvm;
    }

    match site.get("runtime").and_then(Value::as_str) {
        Some("python") => RuntimeKind::Python,
        Some("quickjs") => RuntimeKind::QuickJs,
        Some("jvm") => RuntimeKind::Jvm,
        _ => RuntimeKind::Cms,
    }
}

struct CmsRuntimeAdapter;

#[async_trait]
impl SpiderRuntime for CmsRuntimeAdapter {
    fn kind(&self) -> RuntimeKind {
        RuntimeKind::Cms
    }

    async fn invoke(
        &self,
        site: &Value,
        method: SpiderMethod,
        args: &[Value],
        _timeout: Duration,
    ) -> Result<Value, AppError> {
        cms::invoke(site, method, args).await
    }

    async fn health(&self) -> Result<(), AppError> {
        Ok(())
    }
}

static CMS_RUNTIME: CmsRuntimeAdapter = CmsRuntimeAdapter;
static PY_RUNTIME: python::PythonRuntime = python::PythonRuntime;
static QJS_RUNTIME: quickjs::QuickJsRuntime = quickjs::QuickJsRuntime;
static JVM_RUNTIME: jvm::JvmRuntime = jvm::JvmRuntime;

pub fn runtime_for(kind: RuntimeKind) -> Option<&'static dyn SpiderRuntime> {
    match kind {
        RuntimeKind::Cms => Some(&CMS_RUNTIME),
        RuntimeKind::Python => Some(&PY_RUNTIME),
        RuntimeKind::QuickJs => Some(&QJS_RUNTIME),
        RuntimeKind::Jvm => Some(&JVM_RUNTIME),
    }
}

async fn invoke_one(
    site: &Value,
    method: SpiderMethod,
    args: &[Value],
    timeout: Duration,
) -> Result<Value, AppError> {
    let kind = route(site);
    let runtime = runtime_for(kind).ok_or_else(|| {
        AppError::new(
            code::RUNTIME_UNAVAILABLE,
            format!("runtime {} is not available yet", kind.as_str()),
        )
    })?;
    runtime.invoke(site, method, args, timeout).await
}

#[tauri::command]
pub async fn spider_invoke(
    state: tauri::State<'_, ConfigStore>,
    request: SpiderRequest,
) -> Result<Value, AppError> {
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

    if request.site_key == "all" {
        return aggregate(&state, request.method, &request.args, timeout).await;
    }

    let site = state.find_site(&request.site_key)?;
    // `/proxy?do=py` does not carry a site key; the last playerContent caller
    // is the current play session (single player window).
    if request.method == SpiderMethod::PlayerContent {
        note_play_site(&site);
    }
    invoke_one(&site, request.method, &request.args, timeout).await
}

/// Fan-out over every enabled CMS site (spec 4.3 首页聚合).
async fn aggregate(
    state: &ConfigStore,
    method: SpiderMethod,
    args: &[Value],
    timeout: Duration,
) -> Result<Value, AppError> {
    let sites: Vec<Value> = state
        .all_sites()
        .into_iter()
        .filter(|site| site.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        // Runtimes that are not implemented yet are skipped instead of failing
        // the whole home page.
        .filter(|site| runtime_for(route(site)).is_some())
        // Divider entries (`-- 1 --`) carry no api and would only produce noise.
        .filter(|site| {
            let api = site.get("api").and_then(Value::as_str).unwrap_or("");
            !api.is_empty() || route(site) == RuntimeKind::Jvm
        })
        .collect();

    if sites.is_empty() {
        return Ok(json!({
            "results": [],
            "ok": 0,
            "failed": 0,
            "skipped": 0,
            "total": 0,
            "tookMs": 0,
        }));
    }

    let started = Instant::now();
    let semaphore = std::sync::Arc::new(Semaphore::new(MAX_FANOUT));
    let mut set = tokio::task::JoinSet::new();

    // Queue every site at once. Acquiring the permit *before* spawning would
    // serialize waves of MAX_FANOUT sites (100 sources = 5 sequential rounds),
    // so the tail would never get a fair share of the wall-clock budget.
    for site in sites.iter() {
        let site = site.clone();
        let semaphore = semaphore.clone();
        let args = args.to_vec();
        set.spawn(async move {
            let key = site
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let outcome = match semaphore.acquire_owned().await {
                Ok(_permit) => tokio::time::timeout(
                    timeout,
                    invoke_one(&site, method, &args, timeout),
                )
                .await
                .unwrap_or_else(|_| {
                    Err(AppError::new(
                        code::SITE_TIMEOUT,
                        format!("site {key} exceeded {}ms", timeout.as_millis()),
                    ))
                }),
                Err(err) => Err(AppError::new(code::INTERNAL, "fan-out semaphore closed")
                    .with_cause(err.to_string())),
            };
            (key, outcome)
        });
    }

    let mut results = Vec::new();
    let mut ok = 0usize;
    let mut failed = 0usize;
    // Honour the caller's wall clock instead of a hardcoded constant. Clamp so
    // neither a tiny nor an absurd timeout can wreck the UI, and abort the
    // slow tail when the budget expires.
    let budget = timeout.clamp(Duration::from_millis(8_000), Duration::from_millis(30_000));
    loop {
        let remaining = budget.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            set.abort_all();
            break;
        }
        match tokio::time::timeout(remaining, set.join_next()).await {
            Ok(Some(joined)) => match joined {
                Ok((site_key, Ok(data))) => {
                    ok += 1;
                    results.push(json!({ "siteKey": site_key, "ok": true, "data": data }));
                }
                Ok((site_key, Err(err))) => {
                    failed += 1;
                    results.push(json!({
                        "siteKey": site_key,
                        "ok": false,
                        "error": { "code": err.code, "message": err.message },
                    }));
                }
                Err(err) => {
                    failed += 1;
                    results.push(json!({
                        "siteKey": "",
                        "ok": false,
                        "error": { "code": code::SPIDER_CRASH, "message": err.to_string() },
                    }));
                }
            },
            Ok(None) => break,
            Err(_) => {
                set.abort_all();
                break;
            }
        }
    }

    Ok(json!({
        "results": results,
        "ok": ok,
        "failed": failed,
        "skipped": sites.len().saturating_sub(ok + failed),
        "total": sites.len(),
        "tookMs": started.elapsed().as_millis() as u64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_by_jar_and_api_suffix() {
        let py = json!({ "api": "http://127.0.0.1/x.py" });
        assert_eq!(route(&py), RuntimeKind::Python);
        let js = json!({ "jar": "js", "api": "http://127.0.0.1/x" });
        assert_eq!(route(&js), RuntimeKind::QuickJs);
        let jar = json!({ "key": "csp_demo", "api": "http://127.0.0.1/x" });
        assert_eq!(route(&jar), RuntimeKind::Jvm);
        let cms = json!({ "type": 1, "api": "http://127.0.0.1/api.php/provide/vod" });
        assert_eq!(route(&cms), RuntimeKind::Cms);
    }

    #[test]
    fn raw_fields_beat_stale_runtime_hint() {
        // Persisted snapshots may carry a `runtime` from an older normalizer; the
        // raw fields must win so misrouted sites get corrected on next invoke.
        let stale = json!({ "runtime": "jvm", "api": "http://127.0.0.1/x.py" });
        assert_eq!(route(&stale), RuntimeKind::Python);

        // With no conflicting signal the hint is still honoured.
        let hinted = json!({ "runtime": "python", "api": "http://127.0.0.1/api.php/provide/vod" });
        assert_eq!(route(&hinted), RuntimeKind::Python);
    }

    #[test]
    fn jvm_runtime_is_registered() {
        // Before P2 `runtime_for(Jvm)` returned None, which made aggregate()
        // silently drop every csp_* site. It must now be dispatchable.
        assert_eq!(
            runtime_for(RuntimeKind::Jvm).map(|r| r.kind()),
            Some(RuntimeKind::Jvm)
        );
    }
}
