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
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

pub const DEFAULT_TIMEOUT_MS: u64 = 15_000;
pub const MAX_FANOUT: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpiderMethod {
    HomeContent,
    /// TVBox 标准方法：首页推荐流（无 `homeContent.list` 的严格源靠它出卡片，
    /// 如豆瓣只给分类）。py/jvm/js runtime 直连脚本同名方法，CMS alias 到 ac=list。
    HomeVideoContent,
    CategoryContent,
    DetailContent,
    SearchContent,
    PlayerContent,
    LiveContent,
    /// TVBox `Spider.proxy(Map)`: serves `/proxy?do=py|jar|js`. Not a
    /// browse method — `proxy()` on the trait is the only caller.
    Proxy,
}

impl SpiderMethod {
    /// Wire name used by the Python adapter (`homeContent` … `liveContent`).
    pub fn as_str(self) -> &'static str {
        match self {
            SpiderMethod::HomeContent => "homeContent",
            SpiderMethod::HomeVideoContent => "homeVideoContent",
            SpiderMethod::CategoryContent => "categoryContent",
            SpiderMethod::DetailContent => "detailContent",
            SpiderMethod::SearchContent => "searchContent",
            SpiderMethod::PlayerContent => "playerContent",
            SpiderMethod::LiveContent => "liveContent",
            SpiderMethod::Proxy => "proxy",
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
    /// 聚合搜索逐站流式回传：每有一个站点完成就 emit `search-chunk`
    /// 事件（payload = 单行 result JSON），前端陆续上屏不必等全站返回。
    /// 仅 `siteKey = "all"` 且 method = searchContent 时生效。
    #[serde(default)]
    pub stream: Option<bool>,
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
    app: tauri::AppHandle,
    request: SpiderRequest,
) -> Result<Value, AppError> {
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

    if request.site_key == "all" {
        let streaming = request.stream.unwrap_or(false)
            && request.method == SpiderMethod::SearchContent;
        return aggregate(
            &state,
            request.method,
            &request.args,
            timeout,
            streaming.then(|| &app),
        )
        .await;
    }

    let site = state.find_site(&request.site_key)?;
    // `find_site` deliberately reads the imported snapshot (old favourites /
    // history may still point at a blocked source), so enforce the runtime
    // policy here: a single-site call must not bypass the import-time filter.
    if let Some(reason) = crate::config::blocked_reason(&site) {
        return Err(AppError::new(
            code::RUNTIME_UNAVAILABLE,
            format!("站点已屏蔽：{reason}"),
        ));
    }
    // `/proxy?do=py` does not carry a site key; the last playerContent caller
    // is the current play session (single player window).
    if request.method == SpiderMethod::PlayerContent {
        note_play_site(&site);
    }
    invoke_one(&site, request.method, &request.args, timeout).await
}

/// 配置里的 `searchable: 0` 是「别对我发起搜索」的显式声明（豆瓣这类发现/
/// 推荐源这么标），聚合搜索据此跳过它。
///
/// 只认**显式**声明：各分支对缺省值的语义相反 —— Box/TVBoxOS 的 `int
/// searchable` 默认 0（不可搜），FongMi 的 `Integer searchable` 缺省按 1
/// 算（可搜）。社区配置里大量站点不写这个字段，按缺省 = 0 过滤会误杀一大片
/// 能搜的源（实测 101 站中 52 站未声明，其中 19 站是可搜的 py/js 源）。
/// 所以 normalize 只在配置写了字段时才输出 `searchableDeclared`，缺键一律当可搜。
fn is_searchable(site: &Value) -> bool {
    site.get("searchableDeclared")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// Fan-out over every enabled CMS site (spec 4.3 首页聚合).
///
/// `streaming = Some(app)` 时（仅搜索流式），每完成一个站点就向前端 emit
/// `search-chunk`（payload = 该站的 result 行 JSON），调用方拿到的最终聚合
/// 与非流式完全一致——事件只是增量预览，真相源仍是 IPC 返回值。
async fn aggregate(
    state: &ConfigStore,
    method: SpiderMethod,
    args: &[Value],
    timeout: Duration,
    streaming: Option<&tauri::AppHandle>,
) -> Result<Value, AppError> {
    let sites: Vec<Value> = state
        .all_sites()
        .into_iter()
        .filter(|site| site.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        // 只有搜索才尊重 `searchable: 0`。首页/分类的聚合种子与「能不能搜」
        // 无关，拿这个字段过滤会连发现型源的首页都拿不到（豆瓣就只有首页）。
        .filter(|site| method != SpiderMethod::SearchContent || is_searchable(site))
        // Runtimes that are not implemented yet are skipped instead of failing
        // the whole home page.
        .filter(|site| runtime_for(route(site)).is_some())
        // Divider entries (`--- 1 ---`) are normalised to `enabled: false`, but
        // older snapshots may still carry them, so keep a defensive check. They
        // must not be exempted just because they inherited the global jar.
        .filter(|site| {
            let api = site.get("api").and_then(Value::as_str).unwrap_or("");
            !api.is_empty() || site.get("ext").is_some()
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
    // 非流式（首页聚合）：按调用方墙钟截断慢尾巴，clamp 防极值。
    // 流式搜索（用户要求）：不限墙钟——结果在陆续上屏，等所有站点跑完
    // 再收尾；每站仍受自身 per-site timeout 约束，不会有无限挂起的源。
    // 上限 600s 只是防御性兜底（per-site timeout × 波次远小于它）。
    let streaming_unbounded = streaming.is_some();
    let budget = timeout.clamp(Duration::from_millis(8_000), Duration::from_millis(30_000));
    loop {
        let remaining = if streaming_unbounded {
            // 流式：无墙钟截断，等到 JoinSet 排空（Ok(None) 分支）。
            Duration::from_secs(600)
        } else {
            budget.saturating_sub(started.elapsed())
        };
        if !streaming_unbounded && remaining.is_zero() {
            set.abort_all();
            break;
        }
        match tokio::time::timeout(remaining, set.join_next()).await {
            Ok(Some(joined)) => match joined {
                Ok((site_key, Ok(data))) => {
                    ok += 1;
                    let row = json!({ "siteKey": site_key, "ok": true, "data": data });
                    if let Some(app) = streaming {
                        let _ = tauri::Emitter::emit(app, "search-chunk", &row);
                    }
                    results.push(row);
                }
                Ok((site_key, Err(err))) => {
                    failed += 1;
                    let row = json!({
                        "siteKey": site_key,
                        "ok": false,
                        "error": { "code": err.code, "message": err.message },
                    });
                    if let Some(app) = streaming {
                        let _ = tauri::Emitter::emit(app, "search-chunk", &row);
                    }
                    results.push(row);
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteHealthRequest {
    /// 单站墙钟超时；缺省 8000ms，clamp 到 [2000, 15000]。
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteHealthRow {
    pub site_key: String,
    pub site_name: String,
    /// `ok` | `failed` | `timeout` | `skipped`
    pub status: String,
    pub took_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteHealthResult {
    pub config_id: String,
    pub rows: Vec<SiteHealthRow>,
    pub ok: usize,
    pub failed: usize,
    pub skipped: usize,
    pub total: usize,
    pub took_ms: u64,
}

/// 排序权重：有问题的站先看到（failed / timeout / skipped 排在 ok 前面）。
fn status_rank(status: &str) -> u8 {
    match status {
        "failed" => 0,
        "timeout" => 1,
        "skipped" => 2,
        "ok" => 3,
        _ => 4,
    }
}

/// 先按 status 分组，组内按耗时降序，完全相等时按 site_key 字典序（稳定）。
fn sort_health_rows(rows: &mut [SiteHealthRow]) {
    rows.sort_by(|a, b| {
        status_rank(&a.status)
            .cmp(&status_rank(&b.status))
            .then_with(|| b.took_ms.cmp(&a.took_ms))
            .then_with(|| a.site_key.cmp(&b.site_key))
    });
}

/// 试运行「站点体检」：对每个可用站点发一次 `homeContent`，做轻量可达性
/// 探测（顺带数一下 `list` / `classes` 条数）。这只是「这次轻请求能不能通」
/// 的快照，**不代表该站搜索 / 详情 / 播放一定可用**，别当播放能力承诺。
///
/// 并发骨架与 `aggregate` 一致：`MAX_FANOUT` 信号量 + `JoinSet`，每站单独
/// 计时并套 `per` 墙钟；整体再套一个 `budget`，到点 abort 未完成的尾巴并把
/// 它们记成 skipped，不让一个死源拖住整页体检。
#[tauri::command]
pub async fn site_health(
    state: tauri::State<'_, ConfigStore>,
    req: SiteHealthRequest,
) -> Result<SiteHealthResult, AppError> {
    let config_id = state
        .active_snapshot()
        .ok_or_else(|| AppError::new(code::INVALID_ARGUMENT, "no active config"))?
        .id;

    // 与 aggregate 完全相同的筛选口径：enabled 默认 true、可被路由到可用
    // runtime、且确实有 api / ext（分隔条之类不算）。注意这里读的是
    // all_sites()（runtime_of），不是 find_site()（imported、不查 enabled）。
    let sites: Vec<Value> = state
        .all_sites()
        .into_iter()
        .filter(|site| site.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        .filter(|site| runtime_for(route(site)).is_some())
        .filter(|site| {
            let api = site.get("api").and_then(Value::as_str).unwrap_or("");
            !api.is_empty() || site.get("ext").is_some()
        })
        .collect();

    if sites.is_empty() {
        return Ok(SiteHealthResult {
            config_id,
            rows: Vec::new(),
            ok: 0,
            failed: 0,
            skipped: 0,
            total: 0,
            took_ms: 0,
        });
    }

    let per_ms = req.timeout_ms.unwrap_or(8_000).clamp(2_000, 15_000);
    let per = Duration::from_millis(per_ms);
    // 体检是诊断动作，要尽量覆盖**全部**站点，不能像聚合搜索那样只给一个
    // `per` 墙钟：67 站 / 并发 20 ≈ 4 轮，每轮最坏 per，4×8s=32s 才跑得完，
    // 否则后几轮会被整批记成 skipped，用户拿不到有效信息。按轮次放大预算，
    // 但留 45s 硬上限，避免一堆死源让体检页一直转。
    let rounds = (sites.len() + MAX_FANOUT - 1) / MAX_FANOUT;
    let budget = Duration::from_millis(per_ms.saturating_mul(rounds as u64))
        .clamp(Duration::from_millis(8_000), Duration::from_millis(45_000));
    let started = Instant::now();
    let semaphore = std::sync::Arc::new(Semaphore::new(MAX_FANOUT));
    let mut set = tokio::task::JoinSet::new();

    // 带上下标排队：panicked task 拿不到内部值，但正常返回的下标能让我们
    // 精确知道哪些站点已经产出结果行，skipped 才能补得不多不少。
    for (index, site) in sites.iter().enumerate() {
        let site = site.clone();
        let semaphore = semaphore.clone();
        set.spawn(async move {
            let key = site
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let name = site
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let (outcome, took_ms) = match semaphore.acquire_owned().await {
                Ok(_permit) => {
                    // 单站计时从真正发出请求开始（不含 semaphore 排队时间）。
                    let site_started = Instant::now();
                    let result = tokio::time::timeout(
                        per,
                        invoke_one(&site, SpiderMethod::HomeContent, &[], per),
                    )
                    .await
                    .unwrap_or_else(|_| {
                        Err(AppError::new(
                            code::SITE_TIMEOUT,
                            format!("site {key} exceeded {}ms", per.as_millis()),
                        ))
                    });
                    (result, site_started.elapsed().as_millis() as u64)
                }
                Err(err) => (
                    Err(
                        AppError::new(code::INTERNAL, "health semaphore closed")
                            .with_cause(err.to_string()),
                    ),
                    0,
                ),
            };
            (index, key, name, outcome, took_ms)
        });
    }

    let into_row = |site_key: String,
                    site_name: String,
                    outcome: Result<Value, AppError>,
                    took_ms: u64| {
        match outcome {
            Ok(data) => {
                let list = data
                    .get("list")
                    .and_then(Value::as_array)
                    .map(|items| items.len());
                let classes = data
                    .get("classes")
                    .and_then(Value::as_array)
                    .map(|items| items.len());
                let count = if list.is_some() || classes.is_some() {
                    Some(list.unwrap_or(0) + classes.unwrap_or(0))
                } else {
                    None
                };
                SiteHealthRow {
                    site_key,
                    site_name,
                    status: "ok".into(),
                    took_ms,
                    message: None,
                    count,
                }
            }
            Err(err) => SiteHealthRow {
                site_key,
                site_name,
                status: if err.code == code::SITE_TIMEOUT {
                    "timeout"
                } else {
                    "failed"
                }
                .into(),
                took_ms,
                message: Some(err.message),
                count: None,
            },
        }
    };

    let mut rows: Vec<SiteHealthRow> = Vec::with_capacity(sites.len());
    // 用 index 记录哪些站点已产出结果行：比 site_key 可靠（key 可能重复或
    // 为空），也是 skipped 数正确的关键。
    let mut received: HashSet<usize> = HashSet::new();
    loop {
        let remaining = budget.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            set.abort_all();
            break;
        }
        match tokio::time::timeout(remaining, set.join_next()).await {
            Ok(Some(joined)) => match joined {
                Ok((index, site_key, site_name, outcome, took_ms)) => {
                    received.insert(index);
                    rows.push(into_row(site_key, site_name, outcome, took_ms));
                }
                Err(err) => {
                    // task panic：拿不到内部下标，补一条空 key 的 failed。
                    // 它同样占一个结果名额，所以下面的 skipped 补齐仍以
                    // rows.len() 对齐 sites.len() 为准（不会重复补站）。
                    rows.push(SiteHealthRow {
                        site_key: String::new(),
                        site_name: String::new(),
                        status: "failed".into(),
                        took_ms: 0,
                        message: Some(format!("{}: {err}", code::SPIDER_CRASH)),
                        count: None,
                    });
                }
            },
            Ok(None) => break,
            Err(_) => {
                set.abort_all();
                break;
            }
        }
    }

    // 墙钟内没收到结果的站点补 skipped：按 sites 顺序挑未收到结果的下标，
    // 补到 rows.len() == sites.len() 为止，保证 ok+failed+skipped == total。
    // 用 rows.len() 而非「未收到下标数」作终止条件，是因为 panic 那条 failed
    // 行没有 index（不属于 received），但它已占一个结果名额，必须一并算进去，
    // 否则会多补一条、让 rows 超过 total。
    for (index, site) in sites.iter().enumerate() {
        if rows.len() >= sites.len() {
            break;
        }
        if received.contains(&index) {
            continue;
        }
        rows.push(SiteHealthRow {
            site_key: site
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            site_name: site
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            status: "skipped".into(),
            took_ms: 0,
            message: Some("体检墙钟预算内未完成".into()),
            count: None,
        });
    }

    sort_health_rows(&mut rows);
    let ok = rows.iter().filter(|row| row.status == "ok").count();
    let skipped = rows.iter().filter(|row| row.status == "skipped").count();
    // timeout 归进 failed：本接口只有 ok / failed / skipped 三个计数，
    // 超时是失败的一种，这样 total == ok + failed + skipped 始终成立。
    let failed = rows
        .iter()
        .filter(|row| row.status == "failed" || row.status == "timeout")
        .count();
    Ok(SiteHealthResult {
        config_id,
        rows,
        ok,
        failed,
        skipped,
        total: sites.len(),
        took_ms: started.elapsed().as_millis() as u64,
    })
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
    fn only_explicit_searchable_zero_is_skipped() {
        // 显式 `searchable: 0`（normalize 会写成 searchableDeclared: false）跳过。
        assert!(!is_searchable(
            &json!({ "key": "py_douban", "searchableDeclared": false })
        ));
        assert!(is_searchable(
            &json!({ "key": "cms", "searchableDeclared": true })
        ));
        // 没声明 ≠ 不可搜：旧快照与不写该字段的配置必须继续参与搜索，
        // 否则会把大量能搜的源一并排除（各分支缺省语义相反，见函数注释）。
        assert!(is_searchable(&json!({ "key": "legacy", "searchable": false })));
        assert!(is_searchable(&json!({ "key": "bare" })));
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

    fn health_row(key: &str, status: &str, took_ms: u64) -> SiteHealthRow {
        SiteHealthRow {
            site_key: key.into(),
            site_name: key.into(),
            status: status.into(),
            took_ms,
            message: None,
            count: None,
        }
    }

    #[test]
    fn health_rows_sort_problematic_first_then_slowest() {
        assert_eq!(status_rank("failed"), 0);
        assert_eq!(status_rank("timeout"), 1);
        assert_eq!(status_rank("skipped"), 2);
        assert_eq!(status_rank("ok"), 3);

        let mut rows = vec![
            health_row("ok-slow", "ok", 900),
            health_row("ok-fast", "ok", 10),
            health_row("failed-fast", "failed", 5),
            health_row("timeout", "timeout", 300),
            health_row("skipped", "skipped", 0),
            health_row("failed-b", "failed", 50),
            health_row("failed-a", "failed", 50),
        ];
        sort_health_rows(&mut rows);
        let order: Vec<(&str, &str, u64)> = rows
            .iter()
            .map(|row| (row.status.as_str(), row.site_key.as_str(), row.took_ms))
            .collect();
        assert_eq!(
            order,
            vec![
                // failed / timeout / skipped 在 ok 前；组内耗时降序；
                // 耗时相同（failed-a / failed-b）按 site_key 字典序。
                ("failed", "failed-a", 50),
                ("failed", "failed-b", 50),
                ("failed", "failed-fast", 5),
                ("timeout", "timeout", 300),
                ("skipped", "skipped", 0),
                ("ok", "ok-slow", 900),
                ("ok", "ok-fast", 10),
            ]
        );
    }

    #[test]
    fn site_health_row_serializes_camel_case_and_skips_none() {
        let value = serde_json::to_value(health_row("k", "ok", 12)).expect("serialize row");
        assert_eq!(value["siteKey"], "k");
        assert_eq!(value["siteName"], "k");
        assert_eq!(value["status"], "ok");
        assert_eq!(value["tookMs"].as_u64(), Some(12));
        assert!(value.get("message").is_none());
        assert!(value.get("count").is_none());
        assert!(value.get("site_key").is_none());
        assert!(value.get("took_ms").is_none());

        let mut with_extras = health_row("k2", "failed", 7);
        with_extras.message = Some("boom".into());
        with_extras.count = Some(3);
        let value = serde_json::to_value(with_extras).expect("serialize row");
        assert_eq!(value["message"], "boom");
        assert_eq!(value["count"].as_u64(), Some(3));
    }

    #[test]
    fn home_video_content_wire_and_serde() {
        // 8 个 SpiderMethod 的 wire 名必须与契约（schema / TS / py adapter）逐字一致。
        let variants = [
            (SpiderMethod::HomeContent, "homeContent"),
            (SpiderMethod::HomeVideoContent, "homeVideoContent"),
            (SpiderMethod::CategoryContent, "categoryContent"),
            (SpiderMethod::DetailContent, "detailContent"),
            (SpiderMethod::SearchContent, "searchContent"),
            (SpiderMethod::PlayerContent, "playerContent"),
            (SpiderMethod::LiveContent, "liveContent"),
            (SpiderMethod::Proxy, "proxy"),
        ];
        assert_eq!(variants.len(), 8);
        for (variant, wire) in variants {
            assert_eq!(variant.as_str(), wire);
        }

        let parsed: SpiderMethod =
            serde_json::from_str(r#""homeVideoContent""#).expect("camelCase wire must deserialize");
        assert_eq!(parsed, SpiderMethod::HomeVideoContent);
        let serialized = serde_json::to_string(&SpiderMethod::HomeVideoContent).expect("serialize");
        assert_eq!(serialized, r#""homeVideoContent""#);
    }
}
