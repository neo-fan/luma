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
//! and a few `__luma_*` internals are injected; `require`, `process`, `fetch`
//! stay undefined (verified by `tests/acceptance/p1.py`).
//!
//! A hard wall-clock limit interrupts the interpreter, so an infinite loop
//! cannot wedge the sidecar; the host additionally kills the process tree.

use base64::Engine as _;
use md5::{Digest, Md5};
use percent_encoding::percent_decode_str;
use rquickjs::{
    loader::{Loader, Resolver},
    module::Declared,
    CatchResultExt, Context, Ctx, Error as JsError, Function, Module, Runtime, Value,
};
use std::sync::Arc;
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
        _ => "__luma_unknown",
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

/// Same as `http_agent()` but tolerates broken server certificate chains.
///
/// TVBox 生态里「服务端漏发中间证书」的源很常见（浏览器靠 AIA 抓取能救回来，
/// rustls 不会，直接 `invalid peer certificate: UnknownIssuer`）。严格模式
/// 先试一次，命中 TLS 证书错误再用这个 agent 重试一次——证书错误是确定性的，
/// 重试无副作用；正常源的信任路径完全不变。宽容路径走 native-tls/SChannel，
/// 与 rustls 严格路径互不影响。
fn tolerant_connector() -> Option<Arc<native_tls::TlsConnector>> {
    native_tls::TlsConnector::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .ok()
        .map(Arc::new)
}

fn http_agent_cert_tolerant() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let builder = ureq::AgentBuilder::new().try_proxy_from_env(false);
        match tolerant_connector() {
            Some(connector) => builder.tls_connector(connector).build(),
            None => builder.build(),
        }
    })
}

/// 模块加载用的宽容 agent：与 `http_agent_cert_tolerant` 的差别是跟随环境
/// 代理（模块加载走的是默认全局代理行为，见 `load_source`）。
fn module_agent_cert_tolerant() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let builder = ureq::AgentBuilder::new();
        match tolerant_connector() {
            Some(connector) => builder.tls_connector(connector).build(),
            None => builder.build(),
        }
    })
}

/// ureq 的 rustls 后端把 TLS 握手失败统一包成 `ConnectionFailed`
/// ("tls connection init failed: ...")，错误类别里没有 TLS；只能按消息识别。
/// 识别条件收窄到证书语义，避免把普通断连误判成证书问题。
fn is_tls_cert_failure(err: &ureq::Error) -> bool {
    let text = err.to_string().to_ascii_lowercase();
    text.contains("invalid peer certificate") || text.contains("unknown issuer")
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
    let build = |agent: &'static ureq::Agent| {
        let mut request = agent
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
    let send = |agent: &'static ureq::Agent| match &body {
        Some(text) if !text.is_empty() => build(agent).send_string(text),
        _ => build(agent).call(),
    };
    let response = match send(http_agent()) {
        // 服务端证书链不完整（TVBox 生态常见，浏览器能救、rustls 不能）：
        // 先严格试一次，命中 TLS 证书错误换宽容 agent 重试一次。证书错误是
        // 确定性的，重试无副作用；正常源的信任路径完全不变。
        Err(err) if is_tls_cert_failure(&err) => {
            send(http_agent_cert_tolerant())
        }
        // Some source APIs close an idle keep-alive connection mid-response
        // ("Unexpected EOF"); one immediate retry on GET is cheap and fixes it.
        Err(ureq::Error::Transport(_)) if method == "GET" => {
            std::thread::sleep(Duration::from_millis(120));
            send(http_agent())
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
  var DEFAULT_HEADERS = __luma_HEADERS__;
  var PREFIX = __luma_SITE__ + ':';
  var PROXY_PORT = __luma_PROXY_PORT__ || 0;

  // -- console ---------------------------------------------------------------
  // Flattened on the JS side: a typed `String` parameter in Rust rejects
  // `console.log(undefined)`, and real sources log optional values constantly.
  var _fmt = function (x) {
    if (typeof x === 'undefined') return 'undefined';
    if (typeof x === 'string') return x;
    if (x === null) return 'null';
    if (x instanceof Error) return x.name + ': ' + x.message;
    try { return JSON.stringify(x); } catch (e) { return String(x); }
  };
  var _emit = function (prefix, args) {
    var parts = [], i;
    for (i = 0; i < args.length; i++) parts.push(_fmt(args[i]));
    __luma_log(prefix + parts.join(' '));
  };
  globalThis.console = {
    log: function () { _emit('', arguments); },
    info: function () { _emit('', arguments); },
    debug: function () { _emit('', arguments); },
    warn: function () { _emit('[warn] ', arguments); },
    error: function () { _emit('[error] ', arguments); }
  };

  // FongMi native bridge. drpy2 defines its own `getProxyUrl()` which calls
  // `getProxy(true)` and *falls back to a hardcoded 9978*. Without this global
  // a port fallback (9978 taken) pointed playback at the wrong port, and the
  // host's own getProxyUrl stub never got a chance to run.
  globalThis.getProxy = function () {
    if (!PROXY_PORT) return '';
    return 'http://127.0.0.1:' + PROXY_PORT + '/proxy?do=js';
  };
  var raw = globalThis.__luma_req_raw;
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
    // FongMi's `req` is synchronous and drpy2 reads `req(url).content` directly
    // (no await). Returning a bare Promise handed every drpy2 rule a Promise
    // object, so `.content` was undefined and JSON.parse got 'undefined' — the
    // rule then silently produced an empty list. Returning the plain object
    // keeps that path working, and the injected `then` keeps `await req(...)`
    // working for the spiders that do await.
    if (out && typeof out === 'object' && typeof out.then !== 'function') {
      out.then = function (ok, fail) {
        var plain = {};
        for (var f in out) if (f !== 'then' && f !== 'catch') plain[f] = out[f];
        return Promise.resolve(plain).then(ok, fail);
      };
      out.catch = function (fail) { return out.then(null, fail); };
    }
    return out;
  };
  globalThis.local = {
    get: function (k) { return globalThis.__luma_local_get(PREFIX + String(k)); },
    set: function (k, v) { return globalThis.__luma_local_set(PREFIX + String(k), String(v)); },
    'delete': function (k) { return globalThis.__luma_local_del(PREFIX + String(k)); }
  };
  globalThis.md5X = function (s) {
    if (typeof globalThis.__luma_md5 === 'function') return globalThis.__luma_md5(String(s));
    if (typeof globalThis.CryptoJS !== 'undefined') return CryptoJS.MD5(String(s)).toString();
    return '';
  };
  // jsjiami-obfuscated sources (live2vod.js) assign/read this host global.
  if (!('__JS_SPIDER__' in globalThis)) globalThis.__JS_SPIDER__ = undefined;

  // -- Web globals -----------------------------------------------------------
  // rquickjs ships the JS core (Uint8Array/DataView/Promise/Proxy) but none of
  // the Web layer. drpy2 rules call atob/btoa when signing requests,
  // TextDecoder for charset repair and URLSearchParams for form bodies; each
  // missing global surfaces as "x is not a function" deep inside a minified
  // engine, which is why they are installed unconditionally.
  var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  globalThis.btoa = function (input) {
    var s = String(input == null ? '' : input), out = '', i;
    for (i = 0; i < s.length; i += 3) {
      var c1 = s.charCodeAt(i) & 255;
      var c2 = i + 1 < s.length ? s.charCodeAt(i + 1) & 255 : -1;
      var c3 = i + 2 < s.length ? s.charCodeAt(i + 2) & 255 : -1;
      out += B64C.charAt(c1 >> 2);
      out += B64C.charAt(((c1 & 3) << 4) | (c2 < 0 ? 0 : c2 >> 4));
      out += c2 < 0 ? '=' : B64C.charAt(((c2 & 15) << 2) | (c3 < 0 ? 0 : c3 >> 6));
      out += c3 < 0 ? '=' : B64C.charAt(c3 & 63);
    }
    return out;
  };
  globalThis.atob = function (input) {
    // Keep '=' so a short final quartet is detectable. Stripping it made
    // `charAt` run past the end, and `B64C.indexOf('')` returned 0 — which
    // decoded `aGVsbG8=` to "hello\u0000" instead of "hello".
    var s = String(input == null ? '' : input).replace(/[^A-Za-z0-9+/=]/g, ''), out = '', i;
    for (i = 0; i < s.length; i += 4) {
      var n1 = B64C.indexOf(s.charAt(i));
      var n2 = B64C.indexOf(s.charAt(i + 1));
      var n3 = s.charAt(i + 2) === '=' || s.charAt(i + 2) === '' ? -1 : B64C.indexOf(s.charAt(i + 2));
      var n4 = s.charAt(i + 3) === '=' || s.charAt(i + 3) === '' ? -1 : B64C.indexOf(s.charAt(i + 3));
      if (n1 < 0 || n2 < 0) break;
      out += String.fromCharCode((n1 << 2) | (n2 >> 4));
      if (n3 >= 0) out += String.fromCharCode(((n2 & 15) << 4) | (n3 >> 2));
      if (n4 >= 0) out += String.fromCharCode(((n3 & 3) << 6) | n4);
    }
    return out;
  };

  function _utf8Encode(str) {
    str = String(str == null ? '' : str);
    var out = [], i = 0;
    while (i < str.length) {
      var c = str.charCodeAt(i++);
      // Join a surrogate pair before encoding, otherwise emoji in titles
      // become two lone surrogates (invalid UTF-8).
      if (c >= 0xD800 && c <= 0xDBFF && i < str.length) {
        var lo = str.charCodeAt(i);
        if (lo >= 0xDC00 && lo <= 0xDFFF) { c = ((c - 0xD800) << 10) + (lo - 0xDC00) + 0x10000; i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function _toBytes(buf) {
    if (!buf) return [];
    if (typeof buf === 'string') return _utf8Encode(buf);
    if (buf.buffer) return [].slice.call(new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength));
    return [].slice.call(buf);
  }
  if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = function () {};
    globalThis.TextEncoder.prototype.encode = function (s) {
      return new Uint8Array(_utf8Encode(s));
    };
  }
  if (typeof globalThis.TextDecoder === 'undefined') {
    // `label` is honoured for gbk/gb2312 only when the engine brought its own
    // gbkTool (drpy2 imports it); plain UTF-8 otherwise. A silent wrong charset
    // is worse than a loud one, so unknown labels fall back to utf-8.
    globalThis.TextDecoder = function (label) {
      this.encoding = String(label || 'utf-8').toLowerCase();
    };
    globalThis.TextDecoder.prototype.decode = function (buf) {
      var bytes = _toBytes(buf);
      if (this.encoding === 'gbk' || this.encoding === 'gb2312' || this.encoding === 'gb18030') {
        // drpy2 ships gbkTool as a factory; its `decode` consumes a
        // percent-encoded GBK string (`%C4%E3`), not raw bytes.
        var tool = globalThis.gbkTool;
        if (typeof tool === 'function') { try { tool = tool(); } catch (e) { tool = null; } }
        if (tool && typeof tool.decode === 'function') {
          try {
            var pct = [];
            for (var g = 0; g < bytes.length; g++) {
              pct.push('%' + (bytes[g] < 16 ? '0' : '') + bytes[g].toString(16).toUpperCase());
            }
            return tool.decode(pct.join(''));
          } catch (e) { console.error('gbk decode failed: ' + e); }
        }
      }
      var s = '', i = 0;
      while (i < bytes.length) {
        var b = bytes[i++];
        if (b < 0x80) { s += String.fromCharCode(b); continue; }
        if (b >= 0xC0 && b < 0xE0 && i < bytes.length) {
          s += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
        } else if (b >= 0xE0 && b < 0xF0 && i + 1 < bytes.length) {
          s += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
        } else if (b >= 0xF0 && i + 2 < bytes.length) {
          var cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
          cp -= 0x10000;
          s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 1023));
        }
      }
      return s;
    };
  }

  if (typeof globalThis.URLSearchParams === 'undefined') {
    var _pairs = function (init) {
      var list = [];
      if (!init) return list;
      if (typeof init === 'string') {
        var raw = init.charAt(0) === '?' ? init.slice(1) : init;
        if (!raw) return list;
        var parts = raw.split('&');
        for (var i = 0; i < parts.length; i++) {
          if (!parts[i]) continue;
          var kv = parts[i].split('=');
          list.push([
            decodeURIComponent(kv[0].replace(/\+/g, ' ')),
            decodeURIComponent((kv[1] || '').replace(/\+/g, ' '))
          ]);
        }
        return list;
      }
      if (typeof init.length === 'number' && typeof init !== 'function' && init.charAt === undefined) {
        for (var j = 0; j < init.length; j++) list.push([String(init[j][0]), String(init[j][1])]);
      } else {
        for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) list.push([k, String(init[k])]);
      }
      return list;
    };
    var USP = function (init) { this._l = _pairs(init); };
    USP.prototype.append = function (k, v) { this._l.push([String(k), String(v)]); };
    USP.prototype.set = function (k, v) {
      k = String(k);
      for (var i = this._l.length - 1; i >= 0; i--) if (this._l[i][0] === k) this._l.splice(i, 1);
      this._l.push([k, String(v)]);
    };
    USP.prototype.get = function (k) {
      k = String(k);
      for (var i = 0; i < this._l.length; i++) if (this._l[i][0] === k) return this._l[i][1];
      return null;
    };
    USP.prototype.getAll = function (k) {
      k = String(k);
      var out = [];
      for (var i = 0; i < this._l.length; i++) if (this._l[i][0] === k) out.push(this._l[i][1]);
      return out;
    };
    USP.prototype.has = function (k) { return this.get(k) !== null; };
    USP.prototype['delete'] = function (k) {
      k = String(k);
      for (var i = this._l.length - 1; i >= 0; i--) if (this._l[i][0] === k) this._l.splice(i, 1);
    };
    USP.prototype.forEach = function (fn, thisArg) {
      for (var i = 0; i < this._l.length; i++) fn.call(thisArg, this._l[i][1], this._l[i][0], this);
    };
    USP.prototype.keys = function () { return this._l.map(function (p) { return p[0]; }); };
    USP.prototype.values = function () { return this._l.map(function (p) { return p[1]; }); };
    USP.prototype.entries = function () { return this._l.slice(); };
    USP.prototype.toString = function () {
      var out = [];
      for (var i = 0; i < this._l.length; i++) {
        out.push(encodeURIComponent(this._l[i][0]) + '=' + encodeURIComponent(this._l[i][1]));
      }
      return out.join('&');
    };
    globalThis.URLSearchParams = USP;
  }

  // Timer shims: sources await `sleep` helpers before retries. There is no
  // event loop in a single request, so run the callback as a microtask —
  // ordering is preserved and the delay collapses to zero.
  if (typeof globalThis.setTimeout === 'undefined') {
    var _timerSeq = 0;
    globalThis.setTimeout = function (fn) {
      var args = [].slice.call(arguments, 2);
      var id = ++_timerSeq;
      if (typeof fn === 'function') {
        queueMicrotask(function () {
          try { fn.apply(null, args); } catch (e) { console.error('timer: ' + e); }
        });
      }
      return id;
    };
    globalThis.clearTimeout = function () {};
  }
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
        "__luma_req_raw",
        Function::new(ctx.clone(), |url: String, options: String| -> String {
            http_request(&url, &options)
        })?,
    )?;
    globals.set(
        "__luma_bytes_b64",
        Function::new(ctx.clone(), |bytes: Vec<u8>| -> String {
            base64::engine::general_purpose::STANDARD.encode(bytes)
        })?,
    )?;
    globals.set(
        "__luma_local_get",
        Function::new(ctx.clone(), |key: String| -> String {
            local_store()
                .lock()
                .map(|guard| guard.get(&key).cloned().unwrap_or_default())
                .unwrap_or_default()
        })?,
    )?;
    globals.set(
        "__luma_local_set",
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
        "__luma_local_del",
        Function::new(ctx.clone(), |key: String| -> bool {
            local_store()
                .lock()
                .map(|mut guard| guard.remove(&key).is_some())
                .unwrap_or(false)
        })?,
    )?;

    // Single-string sink; the JS side in HOST_JS flattens
    // `console.log(a, b, undefined)`. Declaring the parameter as `String` made
    // `console.log(RKEY)` throw "Error converting from js 'undefined' into type
    // 'string'" and abort the whole script — real sources log optional values
    // all the time, so this was a silent whole-site killer.
    globals.set(
        "__luma_log",
        Function::new(ctx.clone(), |line: String| {
            eprintln!("[qjs] {line}");
        })?,
    )?;
    globals.set("__luma_ext", request.ext.clone())?;
    globals.set(
        "__luma_site",
        if request.site_key.is_empty() {
            "default".to_string()
        } else {
            request.site_key.clone()
        },
    )?;
    globals.set("__luma_api", request.api.clone())?;
    // `md5X` is a host helper in FongMi. Use the md-5 crate instead of
    // evaluating the 204 KB crypto-js UMD bundle for every call.
    globals.set(
        "__luma_md5",
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
        .replace("__luma_HEADERS__", &headers)
        .replace("__luma_SITE__", &site)
        .replace("__luma_PROXY_PORT__", &request.proxy_port.to_string());
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
        // 与 `req` 相同的证书宽容回落：引擎/依赖/规则文件可能落在漏发中间
        // 证书的站点上，严格失败后用宽容 agent 再试一次。模块加载走默认全局
        // 代理行为，所以宽容 agent 也不关代理（与 `req` 的直连口径不同）。
        let fetch = |agent: &ureq::Agent| -> Result<ureq::Response, ureq::Error> {
            agent.get(url).timeout(Duration::from_secs(10)).call()
        };
        let default_agent = ureq::agent();
        let response = match fetch(&default_agent) {
            Ok(resp) => resp,
            Err(err) if is_tls_cert_failure(&err) => fetch(module_agent_cert_tolerant())
                .map_err(|err| JsError::new_loading_message(url.to_string(), err.to_string()))?,
            Err(err) => {
                return Err(JsError::new_loading_message(url.to_string(), err.to_string()))
            }
        };
        response
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
  var ext = __luma_EXT__;
  var mod = globalThis.__luma_exports || null;
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
  globalThis.__luma_candidates = cands;
  for (var i = 0; i < cands.length; i++) {
    var o = cands[i];
    if (typeof o.init === 'function' && !o.__luma_inited) {
      try { o.init(ext); } catch (e) { console.error('init: ' + e); }
      try { o.__luma_inited = true; } catch (e) {}
    }
  }
  return true;
})()"#;

/// Long TVBox method names map to the short names used by JS0 / drpy2 sources.
const CALL_JS: &str = r#"(async function () {
  var TARGET = __luma_METHOD__;
  var ARGS = __luma_ARGS__;
  var MAP = {
    homeContent: 'home', homeVideoContent: 'homeVod', categoryContent: 'category',
    detailContent: 'detail', searchContent: 'search', playerContent: 'play',
    liveContent: 'live'
  };
  var short = MAP[TARGET] || TARGET;
  var pool = globalThis.__luma_candidates || [];
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
  var PARAMS = __luma_PARAMS__;
  var pool = globalThis.__luma_candidates || [];
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
    try { b64 = globalThis.__luma_bytes_b64(Array.prototype.slice.call(view)); }
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
                "luma:main.js".to_string()
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
                .set("__luma_exports", namespace)
                .catch(&ctx).map_err(|err| err.to_string())?;
        } else {
            ctx.eval::<(), _>(request.source.as_bytes())
                .catch(&ctx).map_err(|err| err.to_string())?;
        }

        let bootstrap = BOOTSTRAP_JS.replace("__luma_EXT__", &js_literal(&request.ext));
        ctx.eval::<bool, _>(bootstrap.as_bytes())
            .catch(&ctx).map_err(|err| err.to_string())?;

        let call = if request.method == "proxy" {
            // Proxy bodies can be bytes; `text`/`b64` keep the frame JSON-safe.
            let params = request
                .args
                .first()
                .cloned()
                .unwrap_or_else(|| json!({}));
            PROXY_JS.replace("__luma_PARAMS__", &js_literal(&params))
        } else {
            CALL_JS
                .replace("__luma_METHOD__", &js_literal(&request.method))
                .replace("__luma_ARGS__", &js_literal(&request.args))
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
