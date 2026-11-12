//! QuickJS sidecar for TVBox JS spiders (spec 7.3 / 7.2 `spider.js` / T-16).
//!
//! One JSON frame per line on stdin/stdout, same shape as the Python adapter.
//! Two execution modes, auto-detected from the source:
//!   * classic scripts (`var spider = {...}`, `__JS_SPIDER__ = {...}`);
//!   * ES modules (`export default {...}`, `export function __jsEvalReturn`,
//!     `import ... from "assets://..."`, `import "./lib.js"`).
//!
//! Modules are resolved through a custom rquickjs `Resolver`/`Loader` that maps
//! `assets://js/lib/*` and relative imports onto a bundled asset directory, and
//! falls back to HTTP for anything else. Only `req`, `local`, `console`, `md5X`
//! and a few `__tvbox_*` internals are injected; `require`, `process`, `fetch`
//! stay undefined (verified by `tests/e2e/p1.py`).
//!
//! A hard wall-clock limit interrupts the interpreter, so an infinite loop
//! cannot wedge the sidecar; the host additionally kills the process tree.

use base64::Engine as _;
use md5::{Digest, Md5};
use percent_encoding::percent_decode_str;
use rquickjs::{
    loader::{Loader, Resolver},
    module::Declared,
    CatchResultExt, Context, Ctx, Error as JsError, Function, Module, Object, Runtime, Value,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, Read, Write},
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use url::Url;

const DEFAULT_TIMEOUT_MS: u64 = 15_000;

/// Resources shipped with the client. `assets://js/lib/<name>` and any
/// relative import whose basename matches one of these is served locally.
const BUNDLED: &[&str] = &[
    "cheerio.min.js",
    "crypto-js.js",
    "node-rsa.js",
    "pako.min.js",
    "gbk.js",
    "json5.js",
    "jinja.js",
    "template.js",
];

/// UMD bundles have no ESM exports; evaluating them as a module still needs a
/// default export so `import cheerio from ...` / `import 模板 from ...` work.
fn umd_global(name: &str) -> &'static str {
    match name {
        "crypto-js.js" => "CryptoJS",
        "node-rsa.js" => "JSEncrypt",
        "pako.min.js" => "pako",
        "json5.js" => "JSON5",
        "jinja.js" => "jinja",
        _ => "__tvbox_unknown",
    }
}

#[derive(Debug, Deserialize)]
struct Request {
    id: u64,
    source: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    args: Vec<JsonValue>,
    #[serde(default)]
    ext: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// Absolute path to `sidecars/qjs-assets` (see `quickjs.rs::resolve_assets_dir`).
    #[serde(default)]
    assets_dir: String,
    /// Original script URL: used as the base for relative module imports.
    #[serde(default)]
    api: String,
    /// Site-level headers, merged into every `req` call.
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    site_key: String,
    /// Port the host proxy bound; `getProxyUrl()` builds absolute URLs with it.
    #[serde(default)]
    proxy_port: u16,
    /// "auto" (default) | "classic" | "module".
    #[serde(default)]
    script_kind: String,
}

#[derive(Debug, Serialize)]
struct Response {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: String,
    message: String,
}

impl Response {
    fn fail(id: u64, code: &str, message: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(ErrorBody {
                code: code.to_string(),
                message: message.into(),
            }),
        }
    }
}

// ---------------------------------------------------------------------------
// Host API
// ---------------------------------------------------------------------------

fn local_store() -> &'static Mutex<HashMap<String, String>> {
    static STORE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Dedicated HTTP agent.
///
/// Environment proxies are ignored on purpose: desktop TVBox sources are
/// fetched directly by the original clients, and a system/CONNECT proxy in the
/// host environment produced `Unexpected EOF` on plain-http source APIs while
/// the same request succeeded outside the app.
fn http_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| ureq::AgentBuilder::new().try_proxy_from_env(false).build())
}

/// `req(url, options)` -> `{ code, content, headers }`, matching FongMi's
/// `QuickJS.Text(json, "content", body)`. Options: method, headers, body,
/// timeout (ms), postType/json-ish body objects are stringified.
fn http_request(url: &str, options: &str) -> String {
    let opts: JsonValue = serde_json::from_str(options).unwrap_or_else(|_| json!({}));
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return json!({"code": 0, "content": "", "error": "scheme not allowed"}).to_string();
    }
    let method = opts
        .get("method")
        .and_then(JsonValue::as_str)
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let timeout = opts
        .get("timeout")
        .and_then(JsonValue::as_u64)
        .unwrap_or(10_000)
        .max(1)
        .min(30_000);
    let extra_headers = opts.get("headers").and_then(JsonValue::as_object);
    let body = opts.get("body").map(|value| match value {
        JsonValue::String(text) => text.clone(),
        other => other.to_string(),
    });
    let build = || {
        let mut request = http_agent()
            .request(&method, url)
            .timeout(Duration::from_millis(timeout));
        if let Some(headers) = extra_headers {
            for (key, value) in headers {
                if let Some(text) = value.as_str() {
                    request = request.set(key, text);
                }
            }
        }
        request
    };
    let send = || match &body {
        Some(text) if !text.is_empty() => build().send_string(text),
        _ => build().call(),
    };
    let response = match send() {
        // Some source APIs close an idle keep-alive connection mid-response
        // ("Unexpected EOF"); one immediate retry on GET is cheap and fixes it.
        Err(ureq::Error::Transport(_)) if method == "GET" => {
            std::thread::sleep(Duration::from_millis(120));
            send()
        }
        other => other,
    };
    match response {
        Ok(resp) => {
            let code = resp.status();
            let mut headers = serde_json::Map::new();
            for name in resp.headers_names() {
                if let Some(value) = resp.header(&name) {
                    headers.insert(name, json!(value));
                }
            }
            // TVBox `req` buffer modes: 0/omitted = text, 2 = base64. The
            // explicit `encoding` option overrides a wrong/missing charset
            // (common on GBK source pages); otherwise ureq's `charset`
            // feature decodes from the response header.
            let buffer = opts.get("buffer").and_then(JsonValue::as_u64).unwrap_or(0);
            let encoding = opts.get("encoding").and_then(JsonValue::as_str);
            let content = if buffer == 2 || encoding.is_some() {
                let mut bytes = Vec::new();
                let _ = resp.into_reader().read_to_end(&mut bytes);
                match (buffer, encoding) {
                    (2, _) => base64::engine::general_purpose::STANDARD.encode(&bytes),
                    (_, Some(label)) => encoding_rs::Encoding::for_label(label.as_bytes())
                        .unwrap_or(encoding_rs::UTF_8)
                        .decode(&bytes)
                        .0
                        .into_owned(),
                    _ => String::from_utf8_lossy(&bytes).into_owned(),
                }
            } else {
                resp.into_string().unwrap_or_default()
            };
            json!({ "code": code, "content": content, "headers": headers }).to_string()
        }
        Err(err) => {
            json!({ "code": 0, "content": "", "error": err.to_string() }).to_string()
        }
    }
}

/// JS shim injected after the Rust primitives. Kept as text so the public API
/// stays plain JS objects/functions (the sandbox assertions check `typeof`).
const HOST_JS: &str = r#"(function () {
  var DEFAULT_HEADERS = __TVBOX_HEADERS__;
  var PREFIX = __TVBOX_SITE__ + ':';
  var PROXY_PORT = __TVBOX_PROXY_PORT__ || 0;
  var raw = globalThis.__tvbox_req_raw;
  globalThis.req = function (url, options) {
    var opts = options || {}, merged = {}, h = {}, k;
    for (k in opts) merged[k] = opts[k];
    for (k in DEFAULT_HEADERS) h[k] = DEFAULT_HEADERS[k];
    if (opts.headers) for (k in opts.headers) h[k] = opts.headers[k];
    merged.headers = h;
    var text = raw(String(url), JSON.stringify(merged));
    var out;
    try { out = JSON.parse(text); } catch (e) { out = { code: 0, content: text, headers: {} }; }
    if (out.code === 0 && out.error) console.error('req failed: ' + url + ' :: ' + out.error);
    return Promise.resolve(out);
  };
  globalThis.local = {
    get: function (k) { return globalThis.__tvbox_local_get(PREFIX + String(k)); },
    set: function (k, v) { return globalThis.__tvbox_local_set(PREFIX + String(k), String(v)); },
    'delete': function (k) { return globalThis.__tvbox_local_del(PREFIX + String(k)); }
  };
  globalThis.md5X = function (s) {
    if (typeof globalThis.__tvbox_md5 === 'function') return globalThis.__tvbox_md5(String(s));
    if (typeof globalThis.CryptoJS !== 'undefined') return CryptoJS.MD5(String(s)).toString();
    return '';
  };
  // jsjiami-obfuscated sources (live2vod.js) assign/read this host global.
  if (!('__JS_SPIDER__' in globalThis)) globalThis.__JS_SPIDER__ = undefined;
  // drpy2.min.js is an engine bundle: FongMi/drpy-node inject an `initEnv`
  // polyfill before the first export, and its top-level code references these
  // names before its own definitions are reachable in strict ESM scope. Provide
  // inert fallbacks so module evaluation can finish; real definitions in the
  // module shadow them. Never define require/process/fetch (sandbox contract).
  var STUBS = {
    pdfh: function () { return ''; }, pdfa: function () { return []; },
    pd: function () { return ''; }, jsp: function () { return {}; },
    print: function () {}, log: function () {},
    VERSION: '0.0.0-luma', RKEY: '', OCR_API: '',
    OcrApi: function () { return {}; },
    // drpy2 rules splice `getProxyUrl()` into play URLs; returning '' turned
    // every such source into "search works, playback 404". Point it at the
    // port the host actually bound.
    getProxyUrl: function (from) {
      if (!PROXY_PORT) return '';
      var base = 'http://127.0.0.1:' + PROXY_PORT + '/proxy?do=js';
      if (from) base += '&from=' + encodeURIComponent(String(from));
      return base;
    },
    rule: {}, os: {}, initEnv: function () {}, _ENV: {},
    joinUrl: function (a, b) { return (a || '') + (b || ''); }
  };
  for (var sk in STUBS) if (!(sk in globalThis)) globalThis[sk] = STUBS[sk];
})()"#;

fn install_host(ctx: &Ctx<'_>, request: &Request) -> Result<(), JsError> {
    let globals = ctx.globals();

    globals.set(
        "__tvbox_req_raw",
        Function::new(ctx.clone(), |url: String, options: String| -> String {
            http_request(&url, &options)
        })?,
    )?;
    globals.set(
        "__tvbox_bytes_b64",
        Function::new(ctx.clone(), |bytes: Vec<u8>| -> String {
            base64::engine::general_purpose::STANDARD.encode(bytes)
        })?,
    )?;
    globals.set(
        "__tvbox_local_get",
        Function::new(ctx.clone(), |key: String| -> String {
            local_store()
                .lock()
                .map(|guard| guard.get(&key).cloned().unwrap_or_default())
                .unwrap_or_default()
        })?,
    )?;
    globals.set(
        "__tvbox_local_set",
        Function::new(ctx.clone(), |key: String, value: String| -> bool {
            local_store()
                .lock()
                .map(|mut guard| {
                    guard.insert(key, value);
                    true
                })
                .unwrap_or(false)
        })?,
    )?;
    globals.set(
        "__tvbox_local_del",
        Function::new(ctx.clone(), |key: String| -> bool {
            local_store()
                .lock()
                .map(|mut guard| guard.remove(&key).is_some())
                .unwrap_or(false)
        })?,
    )?;

    let console = Object::new(ctx.clone())?;
    for level in ["log", "error", "warn", "info"] {
        console.set(
            level,
            Function::new(ctx.clone(), |line: String| {
                eprintln!("[qjs] {line}");
            })?,
        )?;
    }
    globals.set("console", console)?;
    globals.set("__tvbox_ext", request.ext.clone())?;
    globals.set(
        "__tvbox_site",
        if request.site_key.is_empty() {
            "default".to_string()
        } else {
            request.site_key.clone()
        },
    )?;
    globals.set("__tvbox_api", request.api.clone())?;
    // `md5X` is a host helper in FongMi. Use the md-5 crate instead of
    // evaluating the 204 KB crypto-js UMD bundle for every call.
    globals.set(
        "__tvbox_md5",
        Function::new(ctx.clone(), |text: String| -> String {
            Md5::digest(text.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        })?,
    )?;

    let headers = serde_json::to_string(&request.headers).unwrap_or_else(|_| "{}".to_string());
    let site = js_literal(&if request.site_key.is_empty() {
        "default".to_string()
    } else {
        request.site_key.clone()
    });
    let shim = HOST_JS
        .replace("__TVBOX_HEADERS__", &headers)
        .replace("__TVBOX_SITE__", &site)
        .replace("__TVBOX_PROXY_PORT__", &request.proxy_port.to_string());
    ctx.eval::<(), _>(shim.as_bytes())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// ES module resolver / loader
// ---------------------------------------------------------------------------

/// Last path segment, percent-decoded. A CJK module name reaches us as
/// `%E8%8D%90%E7%89%87.js` in a URL but is a real file name on disk.
fn basename(path: &str) -> String {
    let clean = path.split(['?', '#']).next().unwrap_or(path);
    let decoded = percent_decode_str(clean).decode_utf8_lossy().into_owned();
    decoded
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(&decoded)
        .to_string()
}

/// QuickJS module names are virtual: `asset:<file>` for bundled resources,
/// `net:<url>` for remote ones. Every relative import first tries the bundled
/// basename (the upstream repo has no `js/lib/` and no `lib/template.js`), so
/// `./template.js` and `./lib/crypto-js.js` resolve locally instead of 404.
fn normalize_module(base: &str, name: &str, api: &str) -> String {
    let n = name.trim();
    if n.starts_with("assets://") || n.starts_with("asset:") {
        return format!("asset:{}", basename(n));
    }
    if n.starts_with("http://") || n.starts_with("https://") || n.starts_with("net:") {
        return format!("net:{}", n.trim_start_matches("net:"));
    }
    let file = basename(n);
    if BUNDLED.contains(&file.as_str()) {
        return format!("asset:{file}");
    }
    let parent = base
        .strip_prefix("net:")
        .unwrap_or(if base.starts_with("http") { base } else { api });
    // `url::Url::join` handles `../`, query strings and percent-encoding; the
    // hand-rolled concatenation got those wrong.
    if let Ok(joined) = Url::parse(parent).and_then(|root| root.join(n)) {
        return format!("net:{joined}");
    }
    format!("asset:{file}")
}

struct TvResolver {
    api: String,
}

impl Resolver for TvResolver {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
    ) -> rquickjs::Result<String> {
        Ok(normalize_module(base, name, &self.api))
    }
}

fn looks_like_esm(source: &str) -> bool {
    source.contains("export default")
        || source.contains("export function")
        || source.contains("export{")
        || source.contains("export {")
        || source.trim_start_matches('\u{feff}').trim_start().starts_with("import ")
        || source.trim_start_matches('\u{feff}').trim_start().starts_with("import\"")
}

fn load_source(assets_dir: &PathBuf, name: &str) -> Result<String, JsError> {
    if let Some(file) = name.strip_prefix("asset:") {
        let path = assets_dir.join("js").join("lib").join(file);
        fs::read_to_string(&path).map_err(|err| {
            JsError::new_loading_message(file.to_string(), format!("{}: {err}", path.display()))
        })
    } else if let Some(url) = name.strip_prefix("net:") {
        ureq::get(url)
            .timeout(Duration::from_secs(10))
            .call()
            .map_err(|err| JsError::new_loading_message(url.to_string(), err.to_string()))?
            .into_string()
            .map_err(|err| JsError::new_loading_message(url.to_string(), err.to_string()))
    } else {
        Err(JsError::new_loading_message(
            name.to_string(),
            "unsupported module specifier",
        ))
    }
}

struct TvLoader {
    assets_dir: PathBuf,
}

impl Loader for TvLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
    ) -> rquickjs::Result<Module<'js, Declared>> {
        let source = load_source(&self.assets_dir, name)?;
        let file = basename(name);
        let text = if looks_like_esm(&source) {
            source
        } else {
            format!(
                "(function () {{\n{source}\n}}).call(globalThis);\nexport default (globalThis.{g} || {{}});\n",
                g = umd_global(&file)
            )
        };
        Module::declare(ctx.clone(), name.to_string(), text)
    }
}

// ---------------------------------------------------------------------------
// Export discovery + method dispatch
// ---------------------------------------------------------------------------

/// TVBox ships four export conventions. Collect every plausible "spider
/// object" and let dispatch pick the first one exposing the requested method.
const BOOTSTRAP_JS: &str = r#"(function () {
  var ext = __TVBOX_EXT__;
  var mod = globalThis.__tvbox_exports || null;
  var cands = [];
  function add(x) {
    if (x && (typeof x === 'object' || typeof x === 'function') && cands.indexOf(x) < 0) cands.push(x);
  }
  if (mod) {
    if (mod.default && typeof mod.default !== 'function') add(mod.default);
    if (typeof mod.__jsEvalReturn === 'function') { try { add(mod.__jsEvalReturn()); } catch (e) {} }
    add(mod);
  }
  if (globalThis.__JS_SPIDER__) add(globalThis.__JS_SPIDER__);
  if (globalThis.spider) add(globalThis.spider);
  if (typeof globalThis.Spider === 'function') { try { add(new globalThis.Spider(ext)); } catch (e) {} }
  add(globalThis);
  globalThis.__tvbox_candidates = cands;
  for (var i = 0; i < cands.length; i++) {
    var o = cands[i];
    if (typeof o.init === 'function' && !o.__tvbox_inited) {
      try { o.init(ext); } catch (e) { console.error('init: ' + e); }
      try { o.__tvbox_inited = true; } catch (e) {}
    }
  }
  return true;
})()"#;

/// Long TVBox method names map to the short names used by JS0 / drpy2 sources.
const CALL_JS: &str = r#"(async function () {
  var TARGET = __TVBOX_METHOD__;
  var ARGS = __TVBOX_ARGS__;
  var MAP = {
    homeContent: 'home', homeVideoContent: 'homeVod', categoryContent: 'category',
    detailContent: 'detail', searchContent: 'search', playerContent: 'play',
    liveContent: 'live'
  };
  var short = MAP[TARGET] || TARGET;
  var pool = globalThis.__tvbox_candidates || [];
  var fn = null, owner = null;
  for (var i = 0; i < pool.length; i++) {
    var o = pool[i];
    if (typeof o[TARGET] === 'function') { fn = o[TARGET]; owner = o; break; }
    if (typeof o[short] === 'function') { fn = o[short]; owner = o; break; }
  }
  if (!fn) throw new Error('method ' + TARGET + ' missing');
  var a = ARGS.slice();
  if (TARGET === 'detailContent' && a.length && Array.isArray(a[0])) a = [a[0][0]];
  if (TARGET === 'playerContent' && a.length && Array.isArray(a[0])) a = [a[0][0], a[1]];
  var out = fn.apply(owner, a);
  var value = await Promise.resolve(out === undefined ? null : out);
  // TVBox scripts return either a plain object or an already-encoded JSON
  // string (FongMi JS0 does `return JSON.stringify({...})`). Double encoding
  // would hand Rust a JSON *string* instead of the page object, which reads as
  // an empty result. Decode one level when it is JSON, keep other strings as-is.
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (e) { /* not JSON: keep the text */ }
  }
  return JSON.stringify(value === undefined ? null : value);
})()"#;

/// `Spider.proxy(params)` — TVBox local proxy for JS sources
/// (`/proxy?do=js&…`).
///
/// The query map is passed through untouched; the result is normalized to
/// `{contentType, headers, text|b64}` because a proxy body may be text (m3u8)
/// or bytes (keys/images) and the JSON frame cannot carry raw bytes.
/// Accepted shapes, in the order real sources use them:
///   * `[contentType, headers, body]` (TVBox/FongMi convention);
///   * the same array prefixed by a numeric status code;
///   * `{contentType|type, headers, body|content}`;
///   * a bare string (body only).
const PROXY_JS: &str = r#"(async function () {
  var PARAMS = __TVBOX_PARAMS__;
  var pool = globalThis.__tvbox_candidates || [];
  var fn = null, owner = null;
  for (var i = 0; i < pool.length; i++) {
    var o = pool[i];
    if (typeof o.proxy === 'function') { fn = o.proxy; owner = o; break; }
  }
  if (!fn) throw new Error('method proxy missing');
  var raw = await Promise.resolve(fn.apply(owner, [PARAMS]));
  if (raw === undefined || raw === null) throw new Error('proxy returned nothing');

  var contentType = '', headers = {}, body = raw;
  if (typeof raw === 'string') {
    body = raw;
  } else if (Array.isArray(raw)) {
    var at = 0;
    if (typeof raw[0] === 'number') at = 1;
    if (typeof raw[at] === 'string') { contentType = raw[at]; at++; }
    var slot = raw[at];
    if (slot && typeof slot === 'object' && !Array.isArray(slot) &&
        typeof slot.byteLength !== 'number') { headers = slot; at++; }
    body = raw[at];
  } else if (typeof raw === 'object') {
    contentType = raw.contentType || raw.type || '';
    headers = raw.headers || {};
    body = raw.body !== undefined ? raw.body : raw.content;
  }

  var text = null, b64 = null;
  if (body === undefined || body === null) body = '';
  if (typeof body === 'string') {
    text = body;
  } else if (typeof body === 'object' && typeof body.byteLength === 'number') {
    var view = (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer)
      ? new Uint8Array(body)
      : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    try { b64 = globalThis.__tvbox_bytes_b64(Array.prototype.slice.call(view)); }
    catch (e) { b64 = null; }
    if (b64 === null) text = '';
  } else {
    text = String(body);
  }

  var hout = {}, k;
  for (k in headers) { if (typeof headers[k] === 'string') hout[k] = headers[k]; }
  return JSON.stringify({
    contentType: typeof contentType === 'string' ? contentType : '',
    headers: hout,
    text: text,
    b64: b64
  });
})()"#;

fn js_literal<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn is_module_source(source: &str, hint: &str) -> bool {
    match hint {
        "classic" => false,
        "module" => true,
        _ => looks_like_esm(source),
    }
}

fn handle(request: Request) -> Response {
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(err) => return Response::fail(request.id, "RUNTIME_UNAVAILABLE", err.to_string()),
    };

    let deadline = Instant::now() + timeout;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));

    let assets_dir = PathBuf::from(&request.assets_dir);
    runtime.set_loader(
        TvResolver {
            api: request.api.clone(),
        },
        TvLoader {
            assets_dir: assets_dir.clone(),
        },
    );

    let ctx = match Context::full(&runtime) {
        Ok(ctx) => ctx,
        Err(err) => return Response::fail(request.id, "RUNTIME_UNAVAILABLE", err.to_string()),
    };

    let outcome: Result<JsonValue, String> = ctx.with(|ctx| {
        install_host(&ctx, &request).catch(&ctx).map_err(|err| err.to_string())?;

        if is_module_source(&request.source, &request.script_kind) {
            let name = if request.api.is_empty() {
                "tvbox:main.js".to_string()
            } else {
                request.api.clone()
            };
            let declared = Module::declare(ctx.clone(), name, request.source.clone())
                .catch(&ctx).map_err(|err| err.to_string())?;
            let (evaluated, promise) = declared.eval().catch(&ctx).map_err(|err| err.to_string())?;
            // Draining the job queue is mandatory: a module with imports is not
            // fully linked (and its `default` export not initialized) until its
            // evaluation promise settles. Never swallow a rejected promise here,
            // or the failure resurfaces later as an opaque TDZ error.
            promise
                .finish::<()>()
                .catch(&ctx)
                .map_err(|err| err.to_string())?;
            while ctx.execute_pending_job() {}
            let namespace = evaluated.namespace().catch(&ctx).map_err(|err| err.to_string())?;
            ctx.globals()
                .set("__tvbox_exports", namespace)
                .catch(&ctx).map_err(|err| err.to_string())?;
        } else {
            ctx.eval::<(), _>(request.source.as_bytes())
                .catch(&ctx).map_err(|err| err.to_string())?;
        }

        let bootstrap = BOOTSTRAP_JS.replace("__TVBOX_EXT__", &js_literal(&request.ext));
        ctx.eval::<bool, _>(bootstrap.as_bytes())
            .catch(&ctx).map_err(|err| err.to_string())?;

        let call = if request.method == "proxy" {
            // Proxy bodies can be bytes; `text`/`b64` keep the frame JSON-safe.
            let params = request
                .args
                .first()
                .cloned()
                .unwrap_or_else(|| json!({}));
            PROXY_JS.replace("__TVBOX_PARAMS__", &js_literal(&params))
        } else {
            CALL_JS
                .replace("__TVBOX_METHOD__", &js_literal(&request.method))
                .replace("__TVBOX_ARGS__", &js_literal(&request.args))
        };
        let value: Value = ctx.eval(call.as_bytes()).catch(&ctx).map_err(|err| err.to_string())?;
        let promise = value
            .into_promise()
            .ok_or_else(|| "dispatch did not return a promise".to_string())?;
        let encoded: String = promise.finish().catch(&ctx).map_err(|err| err.to_string())?;
        serde_json::from_str::<JsonValue>(&encoded).map_err(|err| err.to_string())
    });

    match outcome {
        Ok(value) => Response {
            id: request.id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err(message) => {
            let code = if Instant::now() >= deadline {
                "SITE_TIMEOUT"
            } else {
                "SPIDER_CRASH"
            };
            Response::fail(request.id, code, message)
        }
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Request>(text) {
            Ok(request) => handle(request),
            Err(err) => Response::fail(0, "INVALID_ARGUMENT", err.to_string()),
        };
        if let Ok(encoded) = serde_json::to_string(&response) {
            let _ = writeln!(stdout, "{encoded}");
            let _ = stdout.flush();
        }
    }
}
