//! QuickJS sidecar for TVBox JS spiders (spec 7.3 / 7.2 `spider.js` / T-16).
//!
//! One JSON frame per line on stdin/stdout, same shape as the Python adapter.
//! The script runs in a dedicated `Context`; only `req`, `local`, `console` and
//! the ECMAScript builtins are injected. `require`, `process`, `fetch` and
//! friends stay undefined, which is what the "越权 API 被拒" assertion checks.
//!
//! A hard wall-clock limit interrupts the interpreter, so an infinite loop
//! cannot wedge the sidecar; the host additionally kills the process tree.

use rquickjs::{Context, Ctx, Function, Object, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Deserialize)]
struct Request {
    id: u64,
    source: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    args: Vec<Value>,
    #[serde(default)]
    ext: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
struct Response {
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
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

fn install_host(ctx: &Ctx<'_>, ext: &str) -> Result<(), rquickjs::Error> {
    let globals = ctx.globals();

    // `req`: blocking HTTP. Only http/https; 10s per request.
    let req = Function::new(
        ctx.clone(),
        |url: String| -> String {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return "{\"code\":\"INVALID_ARGUMENT\",\"message\":\"scheme not allowed\"}".to_string();
            }
            match ureq::get(&url).timeout(Duration::from_secs(10)).call() {
                Ok(response) => response.into_string().unwrap_or_default(),
                Err(err) => format!(
                    "{{\"code\":\"SITE_TIMEOUT\",\"message\":\"{}\"}}",
                    err.to_string().replace('"', "'")
                ),
            }
        },
    )?;
    globals.set("req", req)?;

    // `local`: in-memory key/value, wiped with the context.
    let local = Object::new(ctx.clone())?;
    local.set(
        "get",
        Function::new(ctx.clone(), |key: String| -> String { key })?,
    )?;
    local.set(
        "set",
        Function::new(ctx.clone(), |key: String, _value: String| -> bool {
            let _ = key;
            true
        })?,
    )?;
    globals.set("local", local)?;

    let console = Object::new(ctx.clone())?;
    console.set(
        "log",
        Function::new(ctx.clone(), |line: String| {
            eprintln!("[qjs] {line}");
        })?,
    )?;
    globals.set("console", console)?;
    globals.set("__tvbox_ext", ext.to_string())?;

    Ok(())
}

fn call_method(ctx: &Ctx<'_>, method: &str, args: &[Value], ext: &str) -> Result<Value, String> {
    let bootstrap = format!(
        r#"(function () {{
            var ext = {ext};
            var spider = globalThis.spider;
            if (!spider && typeof globalThis.Spider === 'function') {{
                spider = new globalThis.Spider(ext);
            }}
            if (!spider) throw new Error('spider object not found');
            if (typeof spider.init === 'function' && !spider.__tvbox_inited) {{
                spider.init(ext);
                spider.__tvbox_inited = true;
            }}
            globalThis.spider = spider;
            return true;
        }})()"#,
        ext = serde_json::to_string(ext).unwrap_or_else(|_| "\"\"".to_string())
    );
    ctx.eval::<bool, _>(bootstrap.as_bytes())
        .map_err(|err| err.to_string())?;

    let call = format!(
        r#"(function () {{
            var s = globalThis.spider;
            var f = s[{method}];
            if (typeof f !== 'function') throw new Error('method ' + {method} + ' missing');
            var out = f.apply(s, {args});
            return JSON.stringify(out === undefined ? null : out);
        }})()"#,
        method = serde_json::to_string(method).unwrap_or_else(|_| "\"\"".to_string()),
        args = serde_json::to_string(args).unwrap_or_else(|_| "[]".to_string()),
    );

    let encoded: String = ctx
        .eval::<String, _>(call.as_bytes())
        .map_err(|err| err.to_string())?;
    serde_json::from_str(&encoded).map_err(|err| err.to_string())
}

fn handle(request: Request) -> Response {
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
    let runtime = match Runtime::new() {
        Ok(runtime) => runtime,
        Err(err) => return Response::fail(request.id, "RUNTIME_UNAVAILABLE", err.to_string()),
    };

    let deadline = Instant::now() + timeout;
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));

    let ctx = match Context::full(&runtime) {
        Ok(ctx) => ctx,
        Err(err) => return Response::fail(request.id, "RUNTIME_UNAVAILABLE", err.to_string()),
    };

    let outcome = ctx.with(|ctx| {
        install_host(&ctx, &request.ext).map_err(|err| err.to_string())?;
        ctx.eval::<(), _>(request.source.as_bytes())
            .map_err(|err| err.to_string())?;
        call_method(&ctx, &request.method, &request.args, &request.ext)
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
    let _ = json!({});
}
