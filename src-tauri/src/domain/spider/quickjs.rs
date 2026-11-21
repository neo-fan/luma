//! QuickJS runtime (spec 7.3 / T-16, v1.1 R4).
//!
//! Third-party JS never runs in the host process: it is handed to the
//! `qjs-runner` sidecar, which owns a dedicated QuickJS context per call and can
//! be killed by the host at any time. Frames are line-delimited JSON.
//!
//! Frames are correlated by `id`, not by arrival order: one reader task drains
//! stdout and hands each response to the caller that asked for it. The previous
//! design held a global mutex while writing one frame and reading the next
//! line, which assumed the whole host only ever had one call in flight. The
//! frontend does not honour that (home page asks `homeContent`, then
//! `homeVideoContent`; a manual retry / source switch / detail prefetch can
//! overlap), and when two calls did overlap each task read whichever line
//! happened to be first — `homeContent` would receive `homeVideoContent`'s
//! payload and the page rendered as empty.

use crate::error::{code, AppError};
use crate::http;
use crate::process::Guarded;
use crate::spider::{ProxyPayload, RuntimeKind, SpiderMethod, SpiderRuntime};
use async_trait::async_trait;
use moka::future::Cache;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

const SOURCE_TTL: Duration = Duration::from_secs(600);
const MAX_SOURCES: u64 = 64;

/// js 脚本的内存缓存：TTL 600s、上限 64 条，同 key 并发首次访问合并成一次下载
/// （moka `try_get_with`；求值失败不进缓存）。drpy2 这类包几十 KB～几 MB，
/// 一次 fan-out 里重复抓取是实打实的带宽与时间成本。
static SOURCE_CACHE: OnceLock<Cache<String, String>> = OnceLock::new();

fn source_cache() -> &'static Cache<String, String> {
    SOURCE_CACHE.get_or_init(|| {
        Cache::builder()
            .max_capacity(MAX_SOURCES)
            .time_to_live(SOURCE_TTL)
            .build()
    })
}

type Pending = StdMutex<HashMap<u64, oneshot::Sender<Value>>>;

struct Runner {
    guard: AsyncMutex<Guarded>,
    stdin: AsyncMutex<ChildStdin>,
    /// `id -> caller`. Written by `call`, drained by the reader task.
    pending: Arc<Pending>,
    next_id: AtomicU64,
    /// Cleared when the pipe breaks; the next call respawns the runner.
    alive: AtomicBool,
}

impl Runner {
    fn spawn() -> Result<Arc<Self>, AppError> {
        let exe = resolve_runner().ok_or_else(|| {
            AppError::new(
                code::RUNTIME_UNAVAILABLE,
                "qjs-runner not found (set LUMA_QJS_RUNNER or build sidecars/qjs-runner)",
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

        let pending: Arc<Pending> = Arc::new(StdMutex::new(HashMap::new()));
        let runner = Arc::new(Self {
            guard: AsyncMutex::new(guard),
            stdin: AsyncMutex::new(stdin),
            pending: Arc::clone(&pending),
            next_id: AtomicU64::new(0),
            alive: AtomicBool::new(true),
        });
        // Reader task outlives individual calls; it only holds a Weak so a
        // replaced runner can actually be dropped (and killed) by the host.
        let weak: Weak<Self> = Arc::downgrade(&runner);
        tokio::spawn(read_loop(weak, BufReader::new(stdout)));
        Ok(runner)
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    async fn call(&self, payload: Value, timeout: Duration) -> Result<Value, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = oneshot::channel();
        lock_pending(&self.pending).insert(id, tx);

        let mut frame = payload;
        frame["id"] = json!(id);
        let mut line = serde_json::to_string(&frame)?;
        line.push('\n');

        let write = async {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await
        };
        if let Err(err) = write.await {
            lock_pending(&self.pending).remove(&id);
            self.alive.store(false, Ordering::SeqCst);
            return Err(
                AppError::new(code::SPIDER_CRASH, "write to qjs-runner failed")
                    .with_cause(err.to_string()),
            );
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(response)) => decode_response(&response),
            // The reader task exited (pipe closed) and dropped every sender.
            Ok(Err(_)) => {
                self.alive.store(false, Ordering::SeqCst);
                Err(AppError::new(
                    code::SPIDER_CRASH,
                    "qjs-runner exited unexpectedly",
                ))
            }
            Err(_) => {
                // The interrupt handler covers loops inside a context, but a
                // wedged runner is killed outright by the caller.
                lock_pending(&self.pending).remove(&id);
                Err(AppError::new(
                    code::SITE_TIMEOUT,
                    format!("qjs-runner exceeded {}ms", timeout.as_millis()),
                ))
            }
        }
    }

    async fn kill(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.guard.lock().await.kill().await;
    }
}

fn lock_pending(
    pending: &Pending,
) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<Value>>> {
    pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn decode_response(response: &Value) -> Result<Value, AppError> {
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(response.get("result").cloned().unwrap_or(Value::Null));
    }
    let empty = json!({});
    let error = response.get("error").unwrap_or(&empty);
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

/// Drain stdout and route every frame to the caller that owns its `id`.
async fn read_loop(weak: Weak<Runner>, mut stdout: BufReader<tokio::process::ChildStdout>) {
    let mut buffer = String::new();
    loop {
        buffer.clear();
        match stdout.read_line(&mut buffer).await {
            Ok(0) => break,
            Ok(_) => {
                let text = buffer.trim();
                if text.is_empty() {
                    continue;
                }
                let Ok(response) = serde_json::from_str::<Value>(text) else {
                    tracing::warn!("qjs-runner emitted a non-JSON line");
                    continue;
                };
                let Some(runner) = weak.upgrade() else { break };
                let id = response.get("id").and_then(Value::as_u64).unwrap_or(0);
                let sender = lock_pending(&runner.pending).remove(&id);
                match sender {
                    Some(tx) => {
                        let _ = tx.send(response);
                    }
                    None => tracing::warn!(id, "qjs-runner frame has no waiting caller"),
                }
            }
            Err(err) => {
                tracing::warn!(%err, "qjs-runner stdout read failed");
                break;
            }
        }
    }
    // Pipe closed: fail everything still waiting instead of hanging them.
    if let Some(runner) = weak.upgrade() {
        runner.alive.store(false, Ordering::SeqCst);
        lock_pending(&runner.pending).clear();
    }
}

fn resolve_runner() -> Option<PathBuf> {
    if let Some(custom) = crate::env::get("QJS_RUNNER") {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe_name = if cfg!(windows) {
        "qjs-runner.exe"
    } else {
        "qjs-runner"
    };
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

/// Bundled `assets://` resources. The sidecar resolves every `assets://` and
/// relative import against `<dir>/js/lib`; see `docs/js-support.md`.
fn resolve_assets_dir() -> PathBuf {
    if let Some(custom) = crate::env::get("QJS_ASSETS_DIR") {
        let path = PathBuf::from(custom);
        if path.is_dir() {
            return path;
        }
    }
    // Portable layout: <exe>/sidecars/qjs-assets.
    if let Ok(current) = std::env::current_exe() {
        if let Some(dir) = current.parent() {
            let beside = dir.join("sidecars").join("qjs-assets");
            if beside.is_dir() {
                return beside;
            }
        }
    }
    // Dev layout: source root/sidecars/qjs-assets.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_default();
    root.join("sidecars").join("qjs-assets")
}

/// Engine files we ship a copy of. Keyed by URL basename, so every mirror
/// spelling (`lib/drpy2.min.js`, `js/drpy2.js`) maps onto the same local file.
const BUNDLED_ENGINES: &[&str] = &["drpy2.min.js", "drpy2.js"];

/// Last path segment of a js source URL, ignoring query/hash.
fn api_basename(api: &str) -> &str {
    let clean = api.split(['?', '#']).next().unwrap_or(api);
    clean.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// Read the locally shipped engine when `api` points at one we know about.
/// Returns `None` when the URL is not a known engine or the file is missing,
/// so callers can fall back to surfacing the original network error.
fn bundled_engine(api: &str) -> Option<String> {
    let name = api_basename(api);
    if !BUNDLED_ENGINES.contains(&name) {
        return None;
    }
    let path = resolve_assets_dir()
        .join("js")
        .join("lib")
        .join("drpy2.min.js");
    crate::textio::read_file(&path).ok()
}

/// `fetch` only reports transport failures, but a CDN/captive portal happily
/// answers 200 with an HTML error page or an empty body. Feeding that to
/// QuickJS fails later with a cryptic "unexpected token '<'", so treat
/// anything that cannot be a script as garbage and let the caller downgrade.
fn looks_like_script(body: &str) -> bool {
    let head = body.trim_start_matches('\u{feff}').trim_start();
    if head.len() < 256 {
        return false;
    }
    let lead = head.get(..64).unwrap_or(head).to_ascii_lowercase();
    !(lead.starts_with("<!doctype") || lead.starts_with("<html") || lead.starts_with("<?xml"))
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
    // 与 py 通道同源的问题：脚本下载不在任何并发闸内，一次 fan-out 里多个
    // 任务首次触达同一 URL 会重复下载（drpy2 这类包几十 KB～几 MB）。
    // `try_get_with` 合并同 key 的并发首次求值，失败不进缓存。
    match source_cache()
        .try_get_with(api, cold_source(site.clone()))
        .await
    {
        Ok(text) => Ok(text),
        Err(err) => Err((*err).clone()),
    }
}

/// `source_for` 的实际取数链（网络 → 内置引擎兜底）。只在缓存里没有有效
/// 条目时才会被跑到。
async fn cold_source(site: Value) -> Result<String, AppError> {
    let api = site
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let fetched = http::fetch(http::FetchRequest {
        url: api.clone(),
        method: None,
        headers: site.get("headers").and_then(Value::as_object).map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|text| (key.clone(), text.to_string()))
                })
                .collect::<HashMap<String, String>>()
        }),
        body: None,
        timeout_ms: Some(10_000),
    })
    .await;
    // ES modules are NOT rejected here anymore: the sidecar auto-detects
    // `import`/`export` and evaluates them with its custom ModuleLoader.

    let text = match fetched {
        Ok(response) if looks_like_script(&response.body) => response.body,
        Ok(response) => match bundled_engine(&api) {
            Some(text) => {
                eprintln!(
                    "[qjs] {api} answered with {} bytes that are not a script; using bundled engine",
                    response.body.len()
                );
                text
            }
            None => {
                return Err(AppError::new(
                    code::RUNTIME_UNAVAILABLE,
                    format!("js source is not a script: {api}"),
                ))
            }
        },
        Err(err) => match bundled_engine(&api) {
            Some(text) => {
                eprintln!(
                    "[qjs] {api} unreachable ({}); using bundled engine",
                    err.message
                );
                text
            }
            None => return Err(err),
        },
    };

    // 成功（含内置引擎兜底）由 `try_get_with` 写入缓存；上面返回 Err 的两条
    // 分支不进缓存，下次仍会重试。
    Ok(text)
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

static RUNNER: OnceLock<AsyncMutex<Option<Arc<Runner>>>> = OnceLock::new();

fn runner_slot() -> &'static AsyncMutex<Option<Arc<Runner>>> {
    RUNNER.get_or_init(|| AsyncMutex::new(None))
}

/// Hand out the live runner (spawning one if needed) without holding the slot
/// lock for the whole call — concurrent calls share the process safely because
/// responses are matched by `id`.
async fn current_runner() -> Result<Arc<Runner>, AppError> {
    let mut slot = runner_slot().lock().await;
    if let Some(runner) = slot.as_ref() {
        if runner.is_alive() {
            return Ok(Arc::clone(runner));
        }
    }
    if let Some(stale) = slot.take() {
        // A dead or wedged process must not keep receiving frames.
        let _ = tokio::time::timeout(Duration::from_millis(800), stale.kill()).await;
    }
    let runner = Runner::spawn()?;
    *slot = Some(Arc::clone(&runner));
    Ok(runner)
}

/// Drop the shared runner after a crash/timeout so the next call respawns it.
async fn retire_runner(target: &Arc<Runner>) {
    let mut slot = runner_slot().lock().await;
    // Only retire the instance that failed; a newer one may already be live.
    if slot
        .as_ref()
        .map(|runner| Arc::ptr_eq(runner, target))
        .unwrap_or(false)
    {
        let _ = slot.take();
        let _ = tokio::time::timeout(Duration::from_millis(800), target.kill()).await;
    }
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
        let api = site.get("api").and_then(Value::as_str).unwrap_or("");
        let payload = json!({
            "source": source,
            "method": method.as_str(),
            "args": args,
            "ext": site.get("ext").and_then(Value::as_str).unwrap_or(""),
            "timeout_ms": timeout.as_millis() as u64,
            // Module loading, relative-import base, UA/Referer and local KV
            // isolation all live in the sidecar (see docs/js-support.md).
            "assets_dir": resolve_assets_dir().to_string_lossy(),
            "api": api,
            "headers": site.get("headers").cloned().unwrap_or_else(|| json!({})),
            "site_key": site.get("key").and_then(Value::as_str).unwrap_or(""),
            // `getProxyUrl()` must point at the port we actually bound; a busy
            // 9978 falls back to an ephemeral one.
            "proxy_port": crate::proxy::active_port(),
            "script_kind": "auto",
        });

        let runner = current_runner().await?;
        let outcome = runner.call(payload, timeout).await;
        if outcome
            .as_ref()
            .err()
            .map(|err| err.code == code::SPIDER_CRASH || err.code == code::SITE_TIMEOUT)
            .unwrap_or(false)
        {
            retire_runner(&runner).await;
        }
        outcome
    }

    async fn health(&self) -> Result<(), AppError> {
        if resolve_runner().is_some() {
            Ok(())
        } else {
            Err(AppError::new(
                code::RUNTIME_UNAVAILABLE,
                "qjs-runner missing",
            ))
        }
    }

    /// `Spider.proxy(Map)` for `/proxy?do=js`.
    ///
    /// drpy2 rules hand back `getProxyUrl() + "&do=js&..."` URLs, so without
    /// this route those sites can be searched but never played. The sidecar
    /// normalizes `[contentType, headers, body]` / dict / bare string into
    /// `{contentType, headers, text|b64}`; the body is text for playlists and
    /// base64 only when the script actually returned bytes.
    async fn proxy(
        &self,
        site: &Value,
        params: HashMap<String, String>,
        timeout: Duration,
    ) -> Result<ProxyPayload, AppError> {
        let value = self
            .invoke(site, SpiderMethod::Proxy, &[json!(params)], timeout)
            .await?;
        proxy_payload_from_js(&value)
    }
}

/// Turn the sidecar's normalized proxy answer into the HTTP response parts.
fn proxy_payload_from_js(value: &Value) -> Result<ProxyPayload, AppError> {
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

    let body = match value
        .get("b64")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
    {
        Some(encoded) => crate::proxy::base64_decode(encoded)
            .map_err(|_| AppError::new(code::INTERNAL, "js proxy body is not valid base64"))?,
        None => value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .as_bytes()
            .to_vec(),
    };

    Ok(ProxyPayload {
        content_type,
        headers,
        body,
    })
}

pub async fn shutdown() {
    if let Some(slot) = RUNNER.get() {
        let taken = {
            let mut guard = slot.lock().await;
            guard.take()
        };
        if let Some(runner) = taken {
            runner.kill().await;
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

    /// Frames must be routed by `id`. Regression guard: the old runner read
    /// "the next line" whatever its id, so two overlapping calls (home page
    /// sends `homeContent` then `homeVideoContent`) could each receive the
    /// other's payload — the home page then rendered as empty.
    #[test]
    fn response_frames_decode_by_their_own_payload() {
        let ok = json!({ "id": 7, "ok": true, "result": { "list": [{ "vod_id": "1" }] } });
        let decoded = decode_response(&ok).expect("ok frame");
        assert_eq!(decoded["list"][0]["vod_id"], "1");

        let empty = json!({ "id": 8, "ok": true, "result": null });
        assert_eq!(decode_response(&empty).expect("ok frame"), Value::Null);

        let failed = json!({
            "id": 9,
            "ok": false,
            "error": { "code": "SITE_TIMEOUT", "message": "too slow" }
        });
        let err = decode_response(&failed).expect_err("error frame");
        assert_eq!(err.code, "SITE_TIMEOUT");
        assert_eq!(err.message, "too slow");

        // A malformed error body must still surface as a crash, not a panic.
        let malformed = json!({ "id": 10, "ok": false });
        let err = decode_response(&malformed).expect_err("error frame");
        assert_eq!(err.code, code::SPIDER_CRASH);
    }

    #[test]
    fn assets_dir_resolves_without_panicking() {
        let dir = resolve_assets_dir();
        assert!(!dir.as_os_str().is_empty());
        // Dev and installed layouts both end in sidecars/qjs-assets.
        assert!(dir
            .to_string_lossy()
            .replace('\\', "/")
            .ends_with("sidecars/qjs-assets"));
    }

    #[test]
    fn es_module_sources_are_no_longer_rejected_by_policy() {
        // The old `looks_like_es_module` fast-fail lived in source_for(). Now
        // drpy2 / JS0 modules must reach the sidecar; guard the intent here.
        let drpy_head = "import cheerio from\"assets://js/lib/cheerio.min.js\";";
        assert!(drpy_head.contains("import "));
        assert_eq!(
            crate::config::blocked_reason(&json!({"runtime": "quickjs"})),
            None
        );
    }

    #[test]
    fn js_proxy_text_body_is_utf8() {
        let value = json!({
            "contentType": "application/vnd.apple.mpegurl",
            "headers": { "x-js-proxy": "1" },
            "text": "#EXTM3U\n#EXTINF:2,\nseg.ts\n",
            "b64": null
        });
        let payload = proxy_payload_from_js(&value).expect("payload");
        assert_eq!(payload.content_type, "application/vnd.apple.mpegurl");
        assert!(payload.body.starts_with(b"#EXTM3U"));
        assert_eq!(payload.headers.len(), 1);
    }

    #[test]
    fn js_proxy_byte_body_is_decoded_from_b64() {
        // 0x00 0xFF 0x10 0x20 — a binary body cannot travel as `text`.
        let value = json!({
            "contentType": "image/jpeg",
            "headers": {},
            "text": null,
            "b64": "AP8QIA=="
        });
        let payload = proxy_payload_from_js(&value).expect("payload");
        assert_eq!(payload.body, vec![0x00, 0xFF, 0x10, 0x20]);
    }

    #[test]
    fn js_proxy_missing_content_type_falls_back() {
        let payload = proxy_payload_from_js(&json!({ "text": "x" })).expect("payload");
        assert_eq!(payload.content_type, "application/octet-stream");
        assert_eq!(payload.body, b"x".to_vec());
    }

    #[test]
    fn engine_urls_are_recognised_by_basename() {
        // Mirrors spell the engine differently but the file is the same.
        for api in [
            "https://cdn.example.com/mirror/lib/drpy2.min.js",
            "https://cdn.example.com/js/drpy2.js",
            "https://cdn.example.com/lib/drpy2.min.js?v=3#x",
        ] {
            assert!(
                BUNDLED_ENGINES.contains(&api_basename(api)),
                "expected engine basename for {api}"
            );
        }
        // A user's own spider must never be silently replaced by the engine.
        for api in [
            "https://cdn.example.com/js/荐片.js",
            "https://cdn.example.com/lib/live2vod.js",
            "https://cdn.example.com/lib/drpy2.min.js.bak",
        ] {
            assert!(
                !BUNDLED_ENGINES.contains(&api_basename(api)),
                "should not treat {api} as the bundled engine"
            );
        }
    }

    #[test]
    fn bundled_engine_is_shipped_and_readable() {
        // D3: the copy must exist next to the other js assets and parse as a
        // script, otherwise the fallback would hand garbage to QuickJS.
        let path = resolve_assets_dir()
            .join("js")
            .join("lib")
            .join("drpy2.min.js");
        assert!(path.is_file(), "missing bundled engine: {}", path.display());
        let text = crate::textio::read_file(&path).expect("read bundled engine");
        assert!(text.len() > 10_000);
        assert!(text.contains("assets://js/lib/cheerio.min.js"));
        assert!(looks_like_script(&text));
        assert_eq!(
            bundled_engine("https://x/y/lib/drpy2.min.js").map(|t| t.len()),
            Some(text.len())
        );
        assert!(bundled_engine("https://x/y/lib/some-spider.js").is_none());
    }

    #[test]
    fn non_script_bodies_are_rejected() {
        // A 200 response full of HTML is the most common CDN/proxy failure and
        // must not reach QuickJS as if it were the spider.
        assert!(!looks_like_script(""));
        assert!(!looks_like_script("not found"));
        assert!(!looks_like_script(&format!(
            "<!DOCTYPE html><html><body>{}</body></html>",
            "x".repeat(400)
        )));
        assert!(!looks_like_script(&format!(
            "<?xml version=\"1.0\"?><Error>{}</Error>",
            "x".repeat(400)
        )));
        let real = format!(
            "import cheerio from\"assets://js/lib/cheerio.min.js\";{}",
            " ".repeat(4_000)
        );
        assert!(looks_like_script(&real));
        // BOM + leading whitespace must not defeat the sniff.
        assert!(looks_like_script(&format!("\u{feff}\n\n{}", real)));
    }

    /// Manual check (needs network, so `#[ignore]`): a dead engine URL must
    /// yield the bundled copy instead of an error, both when the host answers
    /// garbage (404 page) and when it cannot be reached at all. Run with
    /// `cargo test --lib -- --ignored engine_falls_back --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn engine_falls_back_when_remote_is_missing() {
        let local = bundled_engine("https://x/lib/drpy2.min.js").expect("bundled engine");
        for api in [
            // Same basename, nonexistent directory on a public host: 404s.
            "https://raw.githubusercontent.com/example/nonexistent/main/__nope__/drpy2.min.js",
            // Unresolvable host: exercises the transport-error branch.
            "https://luma-no-such-host.invalid/lib/drpy2.min.js",
        ] {
            let text = source_for(&json!({ "api": api, "ext": "" }))
                .await
                .unwrap_or_else(|err| panic!("fallback failed for {api}: {}", err.message));
            assert_eq!(text.len(), local.len(), "wrong fallback body for {api}");
            assert!(text.contains("assets://js/lib/cheerio.min.js"));
        }
    }
}
