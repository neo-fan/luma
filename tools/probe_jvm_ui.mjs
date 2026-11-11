#!/usr/bin/env node
/**
 * P2 真实窗口验收：通过 CDP 打 Tauri IPC，验证 jar 运行时确实接入宿主。
 *
 * 1) 导入内联配置（指向自编 template-class.jar）→ Rust jvm.rs → JVM
 *    SpiderRunner 全链路可用，7 个 SpiderMethod 与 ext 透传正确。
 * 2) 导入真实 box.json → 28 个 csp_* 站点不再被聚合静默跳过，
 *    且给出「Android dex 不支持」的明确原因；JVM 进程保持单实例。
 *
 * 需要 dev 窗口（9222）与 9978 反代。用法：
 *   node tools/probe_jvm_ui.mjs
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CLASS_JAR = path.join(ROOT, "tests/fixtures/jars/template-class.jar").replace(/\\/g, "/");
const REAL_CONFIG =
  process.env.LUMA_CONFIG ||
  process.env.TVBOX_CONFIG ||
  "https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8/box.json";

let passed = 0;
let failed = 0;
function check(ok, name, note = "") {
  if (ok) {
    passed += 1;
    console.log(`[ok  ] ${name}${note ? "  -- " + note : ""}`);
  } else {
    failed += 1;
    console.log(`[FAIL] ${name}${note ? "  -- " + note : ""}`);
  }
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.pending.get(msg.id);
      if (slot) {
        this.pending.delete(msg.id);
        slot(msg);
      }
    });
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 120000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
    return reply.result;
  }
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`eval failed: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ""}`);
    }
    return res.result?.value;
  }
  async shot(name) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(ROOT, ".workbuddy", `${name}.png`), Buffer.from(res.data, "base64"));
  }
  close() {
    this.ws.close();
  }
}

/** Number of live java.exe processes; used to prove the JVM is reused. */
function javaProcessCount() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq java.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return out.split(/\r?\n/).filter((line) => /^"?java\.exe"?/i.test(line.trim())).length;
  } catch {
    return -1;
  }
}

async function main() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page (is the dev window running?)");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;

  const invoke = (cmd, args) =>
    cdp.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

  // ---- 1. self-authored class jar through the real Rust runtime ----
  const local = {
    sites: [
      {
        key: "jvm_template",
        name: "JVM 模板源",
        api: "csp_Template",
        jar: CLASS_JAR,
        ext: "stub-ext-jar",
        type: 3,
      },
    ],
  };
  const snapshot = await invoke("config_import", {
    source: { kind: "text", value: JSON.stringify(local) },
  });
  const site = (snapshot.sites || [])[0] || {};
  check(site.runtime === "jvm", "inline config routes to jvm", String(site.runtime));
  check(String(site.jar) === CLASS_JAR, "jar path preserved", String(site.jar).slice(-40));

  const before = javaProcessCount();
  const home = await invoke("spider_invoke", {
    request: { siteKey: "jvm_template", method: "homeContent", args: [], timeoutMs: 15000 },
  });
  check(Array.isArray(home?.list) && home.list.length > 0,
    "jvm homeContent via IPC", `${home?.list?.length ?? 0} items`);
  check(home?.extEcho === "stub-ext-jar", "ext passthrough via IPC", String(home?.extEcho));

  const shapes = {};
  for (const method of ["homeContent", "homeVideoContent", "categoryContent", "detailContent", "searchContent", "playerContent", "liveContent"]) {
    try {
      const value = await invoke("spider_invoke", {
        request: { siteKey: "jvm_template", method, args: method === "detailContent" ? ["1001"] : [], timeoutMs: 15000 },
      });
      shapes[method] = method === "detailContent" ? Array.isArray(value) && value.length > 0
        : value && typeof value === "object";
    } catch (err) {
      shapes[method] = false;
      console.log(`       ${method}: ${String(err).slice(0, 140)}`);
    }
  }
  check(Object.values(shapes).every(Boolean), `${Object.keys(shapes).length} SpiderMethods via IPC`, JSON.stringify(shapes));

  const after = javaProcessCount();
  check(before < 0 || after - before <= 1, "single JVM for repeated IPC calls", `java.exe ${before} -> ${after}`);

  const aggregateLocal = await invoke("spider_invoke", {
    request: { siteKey: "all", method: "homeContent", args: [], timeoutMs: 15000 },
  });
  check(aggregateLocal?.total === 1 && aggregateLocal?.ok === 1,
    "aggregate serves jvm site", JSON.stringify({ total: aggregateLocal?.total, ok: aggregateLocal?.ok }));

  // ---- 2. real upstream config: jvm sites are dispatched, not skipped ----
  const real = await invoke("config_import", { source: { kind: "url", value: REAL_CONFIG } });
  const counts = (real.sites || []).reduce((acc, s) => {
    acc[s.runtime] = (acc[s.runtime] || 0) + 1;
    return acc;
  }, {});
  check((counts.jvm || 0) >= 20, "real config has jvm sites", JSON.stringify(counts));
  const jvmKey = (real.sites || []).find((s) => s.runtime === "jvm")?.key;

  // A Tauri command rejection is a serialized AppError object, not an Error;
  // Runtime.evaluate would only report "Uncaught (in promise) Object". Catch it
  // inside the page and stringify the fields we need.
  const singleRaw = await cdp.eval(`(async () => {
    try {
      const value = await window.__TAURI_INTERNALS__.invoke('spider_invoke', ${JSON.stringify({
        request: { siteKey: jvmKey, method: "homeContent", args: [], timeoutMs: 20000 },
      })});
      return JSON.stringify({ unexpectedSuccess: true, value: value });
    } catch (e) {
      const obj = (e && typeof e === 'object') ? e : { message: String(e) };
      let object = '';
      try { object = JSON.stringify(obj); } catch (_) { object = String(e); }
      return JSON.stringify({ code: obj.code, message: obj.message, object: object, raw: String(e) });
    }
  })()`);
  const single = JSON.parse(singleRaw);
  const reason = [single.message, single.code, single.object, single.raw]
    .filter(Boolean)
    .join(" ");
  check(/dex|Android/i.test(reason), "dex jar reports an explicit reason", reason.slice(0, 150));
  check(!/runtime jvm is not available yet/i.test(reason), "jvm no longer reports unimplemented", reason.slice(0, 100));

  const started = Date.now();
  const aggregateReal = await invoke("spider_invoke", {
    request: { siteKey: "all", method: "homeContent", args: [], timeoutMs: 22000 },
  });
  const took = Date.now() - started;
  check(aggregateReal?.total >= 100, "aggregate includes jvm sites",
    `total=${aggregateReal?.total} ok=${aggregateReal?.ok} failed=${aggregateReal?.failed} took=${took}ms`);
  const dexErrors = (aggregateReal?.results || []).filter((r) => r.ok === false && /dex|Android/i.test(r.error?.message || ""));
  check(dexErrors.length > 0, "failed jvm sources carry the dex reason", `${dexErrors.length} entries`);

  await cdp.shot("jvm-1-real-config");
  cdp.close();
  console.log(`\nP2 UI summary: ${passed} pass / ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exitCode = 1;
});
