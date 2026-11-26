//! Spider runtime dispatch (spec 7.3 / 8.3 / T-17).
//!
//! `route()` maps a normalized site to one runtime; every runtime implements
//! `SpiderRuntime` and returns TVBox-shaped JSON. CMS lives in-process while
//! py / js are isolated sidecars. `spider_invoke` with `siteKey = "all"`
//! fans out over the usable sites of the active config with bounded
//! concurrency and a shared wall clock, so a single dead source never blocks
//! the home page. jar sites are still classified as `jvm` so they can be
//! recognised and blocked with a reason, but no JVM runtime ships anymore:
//! community jars are Android dex and cannot run on Windows x64.

pub mod cms;
mod cms_parse;
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

// 超时 / 扇出常量统一在 infra::constants 定义，这里重导出以保持既有引用路径。
pub use crate::constants::{
    DEFAULT_TIMEOUT_MS, HEALTH_BUDGET_MAX_MS, HEALTH_DEFAULT_TIMEOUT_MS, MAX_FANOUT,
    SEARCH_BUDGET_MAX_MS, SEARCH_BUDGET_MIN_MS, SITE_TIMEOUT_MAX_MS, SITE_TIMEOUT_MIN_MS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpiderMethod {
    HomeContent,
    /// TVBox 标准方法：首页推荐流（无 `homeContent.list` 的严格源靠它出卡片，
    /// 如豆瓣只给分类）。py/js runtime 直连脚本同名方法，CMS alias 到 ac=list。
    HomeVideoContent,
    CategoryContent,
    DetailContent,
    SearchContent,
    PlayerContent,
    LiveContent,
    /// TVBox `Spider.proxy(Map)`: serves `/proxy?do=py|jar|js`. Not a
    /// browse method — `proxy()` on the trait is the only caller.
    Proxy,
    /// TVBox/FongMi `Spider.action(String action)`: drpy2 uses it for line
    /// switching, cache clearing and login. Routed like any other method via
    /// `spider_invoke`; only JS sources implement it today.
    Action,
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
            SpiderMethod::Action => "action",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeKind {
    Cms,
    Python,
    QuickJs,
    /// jar 站点分类。JVM 运行时已移除（社区 jar 是 Android dex，Windows 端
    /// 跑不起来），保留该分类只为继续识别 jar 站点并给出来源屏蔽原因。
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
    /// 本次聚合的代次标识，原样回带在 `search-chunk` 事件里。前端改词重搜时
    /// 两轮聚合会重叠，靠它把上一轮的迟到 chunk 挡在新结果之外。
    #[serde(default)]
    pub stream_id: Option<String>,
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

/// 记住「哪些站点正在/最近产生过播放会话」，供 TVBox 本地代理回调定位爬虫。
///
/// 早期只存「最后一次 playerContent 的站点」：单播放窗口够用，但多站并发（如
/// 后台预取另一站、或爬虫代理 URL 不带站点标识）会错配到最近一次点播的源。
/// 现在按 `site.key` 存一张有界小表，代理回调优先用 URL 里带的 `site` 精确命中，
/// 查不到再退回「最近一次」，兼容不带 `site` 的老代理 URL 与直播模式。
static PLAY_SITES: OnceLock<StdMutex<PlaySites>> = OnceLock::new();

const PLAY_SITES_MAX: usize = 8;

#[derive(Default)]
struct PlaySites {
    /// 最近使用在末尾；插入重复 key 时移到末尾。
    order: Vec<String>,
    sites: HashMap<String, Value>,
}

fn play_sites() -> &'static StdMutex<PlaySites> {
    PLAY_SITES.get_or_init(|| StdMutex::new(PlaySites::default()))
}

/// 记住产生本次播放会话的站点（按 `key` 归档，同时更新「最近」）。
pub fn note_play_site(site: &Value) {
    let Some(key) = site.get("key").and_then(Value::as_str).map(str::to_string) else {
        return;
    };
    if let Ok(mut guard) = play_sites().lock() {
        guard.order.retain(|k| *k != key);
        guard.order.push(key.clone());
        guard.sites.insert(key, site.clone());
        while guard.order.len() > PLAY_SITES_MAX {
            let old = guard.order.remove(0);
            guard.sites.remove(&old);
        }
    }
}

/// 按站点 key 精确取回播放会话站点（代理回调首选）。
pub fn play_site_by_key(site_key: &str) -> Option<Value> {
    play_sites()
        .lock()
        .ok()
        .and_then(|guard| guard.sites.get(site_key).cloned())
}

/// 最近一次点播的站点——不带 `site` 的代理 URL 与直播的兜底。
pub fn last_play_site() -> Option<Value> {
    play_sites()
        .lock()
        .ok()
        .and_then(|guard| guard.order.last().and_then(|k| guard.sites.get(k).cloned()))
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
    if api.starts_with("csp_")
        || (!api.is_empty() && !api.starts_with("http") && !api.contains('/'))
    {
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
        // 1.0.3 起不再随包 JVM：jar 源在导入时即被屏蔽，不会走到这里。
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
    app: tauri::AppHandle,
    request: SpiderRequest,
) -> Result<Value, AppError> {
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));

    if request.site_key == "all" {
        let streaming =
            request.stream.unwrap_or(false) && request.method == SpiderMethod::SearchContent;
        return aggregate(
            &state,
            request.method,
            &request.args,
            timeout,
            streaming.then(|| &app),
            request.stream_id.clone(),
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
/// 搜索超时惩罚箱：把反复拖垮聚合搜索的死站临时挪出首轮扇出。
///
/// 背景：慢网里一次全站搜索 58/70 站超时、`elapsedMs` 拖到 637s——每轮都让
/// 这些站重新吃满 15s 单站墙钟是长尾的主因。连续超时 ≥ `STRICKES` 次的站点
/// 进入 `TTL` 冷却，期间流式搜索**跳过**它（计入 skipped）；任一搜索成功即
/// 清账。只惩罚「这段时间确实连不上」的站：单次抖动不拉黑，60s 后自动放行，
/// 且只作用于流式搜索（首页聚合不过滤，避免让用户看到更少的推荐源）。
struct SearchPenalty {
    /// key → (连续超时次数, 最近一次超时时刻)
    entries: HashMap<String, (u32, Instant)>,
}

const SEARCH_PENALTY_STRICKES: u32 = 2;
const SEARCH_PENALTY_TTL: Duration = Duration::from_secs(60);

impl SearchPenalty {
    fn new() -> Self {
        Self { entries: HashMap::new() }
    }

    fn cooling(&self, key: &str, now: Instant) -> bool {
        match self.entries.get(key) {
            Some((strikes, last)) => {
                *strikes >= SEARCH_PENALTY_STRICKES
                    && now.saturating_duration_since(*last) < SEARCH_PENALTY_TTL
            }
            None => false,
        }
    }

    fn on_timeout(&mut self, key: &str, now: Instant) {
        let e = self.entries.entry(key.to_string()).or_insert((0, now));
        e.0 = e.0.saturating_add(1);
        e.1 = now;
    }

    fn on_success(&mut self, key: &str) {
        self.entries.remove(key);
    }
}

static SEARCH_PENALTY: OnceLock<StdMutex<SearchPenalty>> = OnceLock::new();

fn search_penalty() -> &'static StdMutex<SearchPenalty> {
    SEARCH_PENALTY.get_or_init(|| StdMutex::new(SearchPenalty::new()))
}

/// 流式搜索的**总**墙钟预算（毫秒）。
///
/// 扇出是 `MAX_FANOUT` 并发，N 个站需要 `ceil(N / MAX_FANOUT)` 波；每波最多
/// 吃满单站超时 `per_site_ms`。所以自然上界是 `波次 × 单站超时`，再加一波松弛
/// 覆盖调度抖动。clamp 到 [45s, 120s]：健康配置（一波就完）不该被拖到 45s 以下
/// 误杀慢源，也不能让慢网尾段超过 120s（没有总上限时，实测一次拖到 637s）。
fn streaming_budget_ms(per_site_ms: u64, site_count: usize, fanout: usize) -> u64 {
    let fanout = fanout.max(1);
    let waves = (site_count + fanout - 1) / fanout;
    let waves = waves.max(1) as u64;
    let raw = per_site_ms.saturating_mul(waves).saturating_add(per_site_ms);
    raw.clamp(45_000, 120_000)
}

/// 单站耗时分解：把「一站的墙钟」拆成来源不同的三段。
///
/// - `queueMs` = 拿到并发许可 − 入队。这段长说明**扇出并发度不够**（我的问题，
///   调 `MAX_FANOUT` / 减小站点数），跟源站快慢无关。
/// - `runMs` = 执行完 − 拿到许可。这段长才是**源站问题**（慢 / 死），
///   与单站超时对齐即判定为超时站。
/// - `doneMs` = 执行完 − 本次聚合起点。瀑布图的 X 坐标，也是判断「这一波
///   拖了总预算多久」的直接读数。
///
/// 三段共用 `aggregate` 里的同一个 `Instant` 原点，因此
/// `doneMs ≈ queueMs + runMs`，差值是任务调度延迟。
fn site_timing(queued_ms: u64, acquired_ms: u64, done_ms: u64, status: &str) -> Value {
    json!({
        "queueMs": acquired_ms.saturating_sub(queued_ms),
        "runMs": done_ms.saturating_sub(acquired_ms),
        "doneMs": done_ms,
        "status": status,
    })
}

async fn aggregate(
    state: &ConfigStore,
    method: SpiderMethod,
    args: &[Value],
    timeout: Duration,
    streaming: Option<&tauri::AppHandle>,
    stream_id: Option<String>,
) -> Result<Value, AppError> {
    let sites: Vec<Value> = state
        .all_sites()
        .into_iter()
        .filter(|site| site.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        // 只有搜索才尊重 `searchable: 0`。首页/分类的聚合种子与「能不能搜」
        // 无关，拿这个字段过滤会连发现型源的首页都拿不到（豆瓣就只有首页）。
        .filter(|site| method != SpiderMethod::SearchContent || is_searchable(site))
        // 分类存在但没有随包运行时的站点（jar）直接跳过，而不是让整页失败。
        .filter(|site| runtime_for(route(site)).is_some())
        // Divider entries (`--- 1 ---`) are normalised to `enabled: false`, but
        // older snapshots may still carry them, so keep a defensive check. They
        // must not be exempted just because they inherited the global jar.
        .filter(|site| {
            let api = site.get("api").and_then(Value::as_str).unwrap_or("");
            !api.is_empty() || site.get("ext").is_some()
        })
        .collect();

    // 流式搜索（只有它传 `streaming`）：跳过仍在超时惩罚窗里的站点。
    let search_streaming = streaming.is_some();
    let mut penalized = 0usize;
    let sites = if search_streaming {
        let now = Instant::now();
        let guard = search_penalty()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (keep, cooled): (Vec<Value>, Vec<Value>) = sites
            .into_iter()
            .partition(|s| !guard.cooling(s.get("key").and_then(Value::as_str).unwrap_or(""), now));
        penalized = cooled.len();
        keep
    } else {
        sites
    };

    if sites.is_empty() {
        return Ok(json!({
            "results": [],
            "ok": 0,
            "failed": 0,
            "skipped": penalized,
            "total": penalized,
            "tookMs": 0,
            "dropped": [],
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
        // 统一时间原点：三段耗时（排队 / 执行 / 完成）必须同一把尺子量，否则
        // 各任务自己取 Instant 会因调度延迟把排队时间算到别人的执行段里。
        let origin = started;
        set.spawn(async move {
            let key = site
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            // 入队时刻：所有站点在同一轮 spawn，这里反映的是「本轮调度 + 排队起点」。
            let queued_ms = origin.elapsed().as_millis() as u64;
            let (outcome, acquired_ms) = match semaphore.acquire_owned().await {
                Ok(_permit) => {
                    // 拿到并发许可的时刻 = 排队段与执行段的分界。
                    let acquired_ms = origin.elapsed().as_millis() as u64;
                    let outcome =
                        tokio::time::timeout(timeout, invoke_one(&site, method, &args, timeout))
                            .await
                            .unwrap_or_else(|_| {
                                Err(AppError::new(
                                    code::SITE_TIMEOUT,
                                    format!("site {key} exceeded {}ms", timeout.as_millis()),
                                ))
                            });
                    (outcome, acquired_ms)
                }
                Err(err) => (
                    Err(AppError::new(code::INTERNAL, "fan-out semaphore closed")
                        .with_cause(err.to_string())),
                    queued_ms,
                ),
            };
            let done_ms = origin.elapsed().as_millis() as u64;
            (key, outcome, queued_ms, acquired_ms, done_ms)
        });
    }

    let mut results = Vec::new();
    let mut ok = 0usize;
    let mut failed = 0usize;
    // 已回包（成功或失败）的站点。预算耗尽时被 abort 的站点不在其中，
    // 用差集算出 `dropped`——「谁被丢了」是判断要不要在配置层屏蔽的直接依据。
    let mut answered: HashSet<String> = HashSet::new();
    // 非流式（首页聚合）：按调用方墙钟截断慢尾巴，clamp 防极值。
    // 流式搜索：总预算取「波次 × 单站超时 + 一波松弛」，clamp 到 45~120s。把超时
    // 挂在**每一次** `join_next` 迭代上等于没有总时限（N 个任务每轮都重置，慢网尾段
    // 实测能拖到 600s+ 才收尾）。结果仍逐站上屏；预算用尽只 abort 还没答完的尾部
    // 站点，它们照旧计入 skipped。
    let is_streaming = search_streaming;
    let streaming_total = Duration::from_millis(streaming_budget_ms(
        timeout.as_millis() as u64,
        sites.len(),
        MAX_FANOUT,
    ));
    let budget = if is_streaming {
        streaming_total
    } else {
        timeout.clamp(
            Duration::from_millis(SEARCH_BUDGET_MIN_MS),
            Duration::from_millis(SEARCH_BUDGET_MAX_MS),
        )
    };
    loop {
        let remaining = budget.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            set.abort_all();
            break;
        }
        match tokio::time::timeout(remaining, set.join_next()).await {
            Ok(Some(joined)) => match joined {
                Ok((site_key, Ok(data), queued_ms, acquired_ms, done_ms)) => {
                    ok += 1;
                    answered.insert(site_key.clone());
                    if search_streaming {
                        if let Ok(mut guard) = search_penalty().lock() {
                            guard.on_success(&site_key);
                        }
                    }
                    let row = json!({
                        "siteKey": site_key,
                        "ok": true,
                        "data": data,
                        "streamId": stream_id,
                        "timing": site_timing(queued_ms, acquired_ms, done_ms, "ok"),
                    });
                    if let Some(app) = streaming {
                        let _ = tauri::Emitter::emit(app, "search-chunk", &row);
                    }
                    results.push(row);
                }
                Ok((site_key, Err(err), queued_ms, acquired_ms, done_ms)) => {
                    failed += 1;
                    answered.insert(site_key.clone());
                    // 只有流式搜索记账；非超时类失败（解析/屏蔽）不惩罚——
                    // 它们快、不拖墙钟，拉黑反而会让下次能用的站被跳过。
                    if search_streaming && err.code == code::SITE_TIMEOUT {
                        if let Ok(mut guard) = search_penalty().lock() {
                            guard.on_timeout(&site_key, Instant::now());
                        }
                    }
                    let row = json!({
                        "siteKey": site_key,
                        "ok": false,
                        "error": { "code": err.code, "message": err.message },
                        "streamId": stream_id,
                        // 超时与业务失败分开标：前者是源/网问题，后者是配置/解析问题，
                        // 处置方式完全不同（前者屏蔽源站，后者改配置）。
                        "timing": site_timing(
                            queued_ms,
                            acquired_ms,
                            done_ms,
                            if err.code == code::SITE_TIMEOUT { "timeout" } else { "failed" },
                        ),
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

    // 预算耗尽 / 总超时被 abort 的站点：只留 key，不留假耗时。
    let dropped: Vec<&str> = sites
        .iter()
        .filter_map(|site| site.get("key").and_then(Value::as_str))
        .filter(|key| !answered.contains(*key))
        .collect();

    Ok(json!({
        "results": results,
        "ok": ok,
        "failed": failed,
        // 跳过 = 队列里没答完的（abort）+ 被超时惩罚窗挡在门外的。
        "skipped": sites.len().saturating_sub(ok + failed).saturating_add(penalized),
        "total": sites.len().saturating_add(penalized),
        "tookMs": started.elapsed().as_millis() as u64,
        "dropped": dropped,
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
        .active_id()
        .ok_or_else(|| AppError::new(code::INVALID_ARGUMENT, "no active config"))?;

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

    let per_ms = req.timeout_ms
        .unwrap_or(HEALTH_DEFAULT_TIMEOUT_MS)
        .clamp(SITE_TIMEOUT_MIN_MS, SITE_TIMEOUT_MAX_MS);
    let per = Duration::from_millis(per_ms);
    // 体检是诊断动作，要尽量覆盖**全部**站点，不能像聚合搜索那样只给一个
    // `per` 墙钟：67 站 / 并发 20 ≈ 4 轮，每轮最坏 per，4×8s=32s 才跑得完，
    // 否则后几轮会被整批记成 skipped，用户拿不到有效信息。按轮次放大预算，
    // 但留 45s 硬上限，避免一堆死源让体检页一直转。
    let rounds = (sites.len() + MAX_FANOUT - 1) / MAX_FANOUT;
    let budget = Duration::from_millis(per_ms.saturating_mul(rounds as u64))
        .clamp(
            Duration::from_millis(SEARCH_BUDGET_MIN_MS),
            Duration::from_millis(HEALTH_BUDGET_MAX_MS),
        );
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
                    Err(AppError::new(code::INTERNAL, "health semaphore closed")
                        .with_cause(err.to_string())),
                    0,
                ),
            };
            (index, key, name, outcome, took_ms)
        });
    }

    let into_row =
        |site_key: String, site_name: String, outcome: Result<Value, AppError>, took_ms: u64| {
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
    fn streaming_budget_is_a_real_total_not_per_iteration() {
        // 70 站、20 并发 → 4 波 × 15s + 15s 松弛 = 75s（在 [45,120] 内）。
        assert_eq!(streaming_budget_ms(15_000, 70, 20), 75_000);
        // 一波就够（12 站）：15s×1+15s=30s，被下限抬到 45s，别误杀慢源。
        assert_eq!(streaming_budget_ms(15_000, 12, 20), 45_000);
        // 巨量站（200 站 → 10 波 → 165s）被上限压到 120s，杜绝 637s 那种长尾。
        assert_eq!(streaming_budget_ms(15_000, 200, 20), 120_000);
        // 零站不除零：至少一波。
        assert_eq!(streaming_budget_ms(15_000, 0, 20), 45_000);
    }

    #[test]
    fn site_timing_splits_queue_from_execution_on_one_clock() {
        // 第 3 波才拿到许可：排队 30s，自己只跑了 860ms——不是坏源。
        let t = site_timing(12, 30_012, 30_872, "ok");
        assert_eq!(t["queueMs"], 30_000);
        assert_eq!(t["runMs"], 860);
        assert_eq!(t["doneMs"], 30_872);
        assert_eq!(t["status"], "ok");

        // 第一波、跑满单站超时：排队 0，runMs = 超时值，是源站问题。
        let slow = site_timing(0, 0, 15_000, "timeout");
        assert_eq!(slow["queueMs"], 0);
        assert_eq!(slow["runMs"], 15_000);
        assert_eq!(slow["status"], "timeout");

        // 时钟回退 / 异常取值不能让 saturating 算出负数或 panic。
        let broken = site_timing(900, 100, 50, "failed");
        assert_eq!(broken["queueMs"], 0);
        assert_eq!(broken["runMs"], 0);
    }

    #[test]
    fn search_penalty_cools_only_after_two_timeouts_and_clears_on_success() {
        let base = Instant::now();
        let mut box_ = SearchPenalty::new();
        // 第一次超时不拉黑（偶发抖动）。
        box_.on_timeout("dead", base);
        assert!(!box_.cooling("dead", base));
        // 第二次连续超时进入冷却；健康站不受影响。
        box_.on_timeout("dead", base + Duration::from_secs(1));
        assert!(box_.cooling("dead", base + Duration::from_secs(2)));
        assert!(!box_.cooling("other", base + Duration::from_secs(2)));
        // 冷却 TTL 过后自动放行。
        assert!(!box_.cooling("dead", base + Duration::from_secs(2) + SEARCH_PENALTY_TTL));
        // 期间成功一次即清账，回到「零 strikes」。
        box_.on_timeout("x", base);
        box_.on_timeout("x", base + Duration::from_secs(1));
        box_.on_success("x");
        assert!(!box_.cooling("x", base + Duration::from_secs(2)));
        assert!(!box_.cooling("x", base + Duration::from_secs(2) + Duration::from_secs(1)));
    }

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
        assert!(is_searchable(
            &json!({ "key": "legacy", "searchable": false })
        ));
        assert!(is_searchable(&json!({ "key": "bare" })));
    }

    #[test]
    fn jvm_sites_are_classified_but_have_no_runtime() {
        // jar 站点仍要识别为 jvm（导入时按该分类屏蔽并给原因），但 1.0.3 起
        // 不再随包 JVM 运行时，因此不能派发。
        let jar = json!({ "key": "csp_demo", "jar": "http://127.0.0.1/x.jar", "api": "csp_Demo" });
        assert_eq!(route(&jar), RuntimeKind::Jvm);
        assert!(runtime_for(RuntimeKind::Jvm).is_none());
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
        // 9 个 SpiderMethod 的 wire 名必须与契约（schema / TS / py adapter）逐字一致。
        let variants = [
            (SpiderMethod::HomeContent, "homeContent"),
            (SpiderMethod::HomeVideoContent, "homeVideoContent"),
            (SpiderMethod::CategoryContent, "categoryContent"),
            (SpiderMethod::DetailContent, "detailContent"),
            (SpiderMethod::SearchContent, "searchContent"),
            (SpiderMethod::PlayerContent, "playerContent"),
            (SpiderMethod::LiveContent, "liveContent"),
            (SpiderMethod::Proxy, "proxy"),
            (SpiderMethod::Action, "action"),
        ];
        assert_eq!(variants.len(), 9);
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
