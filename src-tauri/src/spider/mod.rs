//! Spider runtime dispatch (spec 7.3 / 8.3 / T-17).
//!
//! `route()` maps a normalized site to one runtime; every runtime implements
//! `SpiderRuntime` and returns TVBox-shaped JSON. `spider_invoke` with
//! `siteKey = "all"` fans out over the enabled CMS sites with a per-source wall
//! clock, so a single dead source never blocks the home page.

pub mod cms;
pub mod python;
pub mod quickjs;

use crate::config::ConfigStore;
use crate::error::{code, AppError};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

pub fn runtime_for(kind: RuntimeKind) -> Option<&'static dyn SpiderRuntime> {
    match kind {
        RuntimeKind::Cms => Some(&CMS_RUNTIME),
        RuntimeKind::Python => Some(&PY_RUNTIME),
        RuntimeKind::QuickJs => Some(&QJS_RUNTIME),
        // Lands in P2 (JVM sidecar).
        RuntimeKind::Jvm => None,
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
        .collect();

    if sites.is_empty() {
        return Ok(json!({ "results": [], "ok": 0, "failed": 0, "tookMs": 0 }));
    }

    let started = Instant::now();
    let semaphore = std::sync::Arc::new(Semaphore::new(MAX_FANOUT));
    let mut set = tokio::task::JoinSet::new();

    for site in sites.into_iter().take(MAX_FANOUT) {
        let permit = semaphore.clone().acquire_owned().await;
        let args = args.to_vec();
        set.spawn(async move {
            let _permit = permit;
            let key = site
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let outcome = tokio::time::timeout(timeout, invoke_one(&site, method, &args, timeout))
                .await
                .unwrap_or_else(|_| {
                    Err(AppError::new(
                        code::SITE_TIMEOUT,
                        format!("site {key} exceeded {}ms", timeout.as_millis()),
                    ))
                });
            (key, outcome)
        });
    }

    let mut results = Vec::new();
    let mut ok = 0usize;
    let mut failed = 0usize;
    while let Some(joined) = set.join_next().await {
        match joined {
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
        }
    }

    Ok(json!({
        "results": results,
        "ok": ok,
        "failed": failed,
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
}
