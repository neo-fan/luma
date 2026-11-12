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
use crate::spider::{ProxyPayload, RuntimeKind, SpiderMethod, SpiderRuntime};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
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
    if let Some(custom) = crate::env::get("QJS_RUNNER") {
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

/// Bundled `assets://` resources. The sidecar resolves every `assets://` and
/// relative import against `<dir>/js/lib`; see `docs/js-support.md`.
fn resolve_assets_dir() -> PathBuf {
    if let Some(custom) = crate::env::get("QJS_ASSETS_DIR") {
        let path = PathBuf::from(custom);
        if path.is_dir() {
            return path;
        }
    }
    // Portable layout: <luma.exe>/sidecars/qjs-assets.
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

fn cache() -> &'static StdMutex<HashMap<String, (String, Instant)>> {
    static CACHE: OnceLock<StdMutex<HashMap<String, (String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| StdMutex::new(HashMap::new()))
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
    let path = resolve_assets_dir().join("js").join("lib").join("drpy2.min.js");
    fs::read_to_string(&path).ok()
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
    let fetched = http::fetch(http::FetchRequest {
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
                eprintln!("[qjs] {api} unreachable ({}); using bundled engine", err.message);
                text
            }
            None => return Err(err),
        },
    };

    let mut guard = cache().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if guard.len() >= 64 {
        guard.clear();
    }
    guard.insert(api, (text.clone(), Instant::now()));
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
        Some(encoded) => crate::proxy::base64_decode(encoded).map_err(|_| {
            AppError::new(code::INTERNAL, "js proxy body is not valid base64")
        })?,
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

    #[test]
    fn assets_dir_resolves_without_panicking() {
        let dir = resolve_assets_dir();
        assert!(!dir.as_os_str().is_empty());
        // Dev and portable layouts both end in sidecars/qjs-assets.
        assert!(dir.to_string_lossy().replace('\\', "/").ends_with("sidecars/qjs-assets"));
    }

    #[test]
    fn es_module_sources_are_no_longer_rejected_by_policy() {
        // The old `looks_like_es_module` fast-fail lived in source_for(). Now
        // drpy2 / JS0 modules must reach the sidecar; guard the intent here.
        let drpy_head = "import cheerio from\"assets://js/lib/cheerio.min.js\";";
        assert!(drpy_head.contains("import "));
        assert_eq!(crate::config::blocked_reason(&json!({"runtime": "quickjs"})), None);
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
            "https://raw.githubusercontent.com/cluntop/tvbox/main/lib/drpy2.min.js",
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
        let path = resolve_assets_dir().join("js").join("lib").join("drpy2.min.js");
        assert!(path.is_file(), "missing bundled engine: {}", path.display());
        let text = fs::read_to_string(&path).expect("read bundled engine");
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
            // Same basename, nonexistent directory: raw.githubusercontent 404s.
            "https://raw.githubusercontent.com/cluntop/tvbox/main/__nope__/drpy2.min.js",
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
