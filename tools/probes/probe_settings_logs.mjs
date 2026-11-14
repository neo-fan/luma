#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
/**
 * 试运行诊断回归：版本号、日志目录、一键复制与后端 diagnostics。
 *
 * 断言：
 *   1. 侧栏与设置页都显示当前版本（期望值从 package.json 动态读取，升版本无需改探针）；
 *   2. 「版本与日志」块列出数据目录 / 日志目录 / 日志文件数量 / 当前配置；
 *   3. `diagnostics` command 返回 version / logDir / config / logFiles；
 *   4. 「打开日志目录」「复制诊断信息」「导出反馈文件」按钮存在，复制有 tip 反馈；
 *   5. 「导出反馈文件」生成真实文件，内容含诊断与日志；
 *   6. 无未捕获页面异常。
 *
 * 依赖 dev 窗口（CDP 9222）与至少一份 active 配置。
 *   node tools/probes/probe_settings_logs.mjs
 */
const PKG = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const EXPECTED_VERSION = PKG.version;
// Mirror src/lib/version.ts::formatVersion() for the sidebar display form.
const DISPLAY_VERSION = EXPECTED_VERSION
  .replace(/-alpha$/i, ".a")
  .replace(/-beta$/i, ".b")
  .replace(/-rc$/i, ".rc");
console.log(`[info] expected version=${EXPECTED_VERSION} display=v${DISPLAY_VERSION}`);

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === "Runtime.exceptionThrown") {
        const detail = msg.params?.exceptionDetails;
        this.errors.push(detail?.exception?.description || detail?.text || "unknown exception");
        return;
      }
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
      throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      // WebView2 的 clipboard 权限弹窗会以 edge:// 页出现，别连错 target。
      const page =
        pages.find((t) => t.url.startsWith("http://localhost:1420")) ??
        pages.find((t) => !t.url.startsWith("edge://") && !t.url.startsWith("chrome://"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("CDP page target not found");
}

const CLICK = (label, selector = "button, a") => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const text = (n) => (n.textContent || '').trim();
  const target = nodes.find((n) => text(n) === ${JSON.stringify(label)})
              || nodes.find((n) => text(n).includes(${JSON.stringify(label)}));
  if (!target) return 'MISSING';
  target.click();
  return 'CLICKED';
})()`;

const WAIT = (expression, timeout = 15000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = (() => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.reload", { ignoreCache: true });

  const navReady = await cdp.eval(
    WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000),
  );
  assert(navReady === "OK", "sidebar rendered", String(navReady));

  const footer = await cdp.eval(
    `(() => { const el = document.querySelector('.sidebar__foot'); return el ? el.innerText.trim() : null; })()`,
  );
  assert(!!footer && footer.includes(`v${DISPLAY_VERSION}`), `sidebar shows v${DISPLAY_VERSION}`, String(footer));

  const opened = await cdp.eval(CLICK("设置", ".nav__item"));
  assert(opened === "CLICKED", "open settings page", opened);
  const blockReady = await cdp.eval(
    WAIT(
      "const kv = document.querySelector('.settings-kv'); return kv && !kv.innerText.includes('读取中') ? 'OK' : null;",
      20000,
    ),
  );
  assert(blockReady === "OK", "版本与日志 block hydrated", String(blockReady));

  const snapRaw = await cdp.eval(`(() => {
    const kv = document.querySelector('.settings-kv');
    const buttons = [...document.querySelectorAll('.settings-actions button')].map((n) => (n.textContent || '').trim());
    const body = document.body.innerText || '';
    return JSON.stringify({
      kv: kv ? kv.innerText.trim() : null,
      buttons,
      hasSection: body.includes('版本与日志'),
      hasVersion: body.includes('v${DISPLAY_VERSION}'),
      hasDataDir: body.includes('数据目录'),
      hasLogDir: body.includes('日志目录'),
    });
  })()`);
  const snap = snapRaw ? JSON.parse(snapRaw) : null;
  console.log(`[info] settings snapshot: ${snapRaw}`);
  assert(!!snap?.hasSection && !!snap?.hasVersion, `settings shows 版本与日志 + v${DISPLAY_VERSION}`, snapRaw);
  assert(!!snap?.hasDataDir && !!snap?.hasLogDir, "data/log dir rows present", snapRaw);
  assert(
    Array.isArray(snap?.buttons) && snap.buttons.some((t) => t.includes("打开日志目录")),
    "open-log-dir button present",
    JSON.stringify(snap?.buttons),
  );
  assert(
    Array.isArray(snap?.buttons) && snap.buttons.some((t) => t.includes("复制诊断信息")),
    "copy-diagnostics button present",
    JSON.stringify(snap?.buttons),
  );

  const diagRaw = await cdp.eval(
    `window.__TAURI_INTERNALS__.invoke('diagnostics').then((d) => JSON.stringify(d)).catch((e) => 'ERR:' + String(e))`,
  );
  const diag = typeof diagRaw === "string" && diagRaw.startsWith("{") ? JSON.parse(diagRaw) : null;
  console.log(`[info] diagnostics: ${String(diagRaw).slice(0, 600)}`);
  assert(diag?.version === EXPECTED_VERSION, `diagnostics version is ${EXPECTED_VERSION}`, String(diag?.version));
  assert(!!diag?.logDir && diag.logDir.endsWith("logs"), "diagnostics reports log dir", String(diag?.logDir));
  assert(Array.isArray(diag?.logFiles) && diag.logFiles.length >= 1, "at least one log file on disk", JSON.stringify(diag?.logFiles));
  assert(
    !!diag?.config && diag.config.sites > 0,
    "diagnostics includes active config stats",
    JSON.stringify(diag?.config),
  );

  const copied = await cdp.eval(CLICK("复制诊断信息", ".settings-actions button"));
  assert(copied === "CLICKED", "click 复制诊断信息", copied);
  const tip = await cdp.eval(
    WAIT("const t = document.querySelector('.settings-block .tip'); return t ? t.innerText.trim() : null;", 10000),
  );
  console.log(`[info] copy tip: ${String(tip)}`);
  assert(!!tip, "copy action produced a tip", String(tip));

  // 导出反馈文件：确认按钮在、路径回显、磁盘上真的生成了一个带诊断与日志的文件。
  const buttons = JSON.parse(
    (await cdp.eval(
      `JSON.stringify([...document.querySelectorAll('.settings-actions button')].map((n) => n.textContent.trim()))`,
    )) || "[]",
  );
  assert(buttons.includes("导出反馈文件"), "export report button present", JSON.stringify(buttons));
  const exported = await cdp.eval(CLICK("导出反馈文件", ".settings-actions button"));
  assert(exported === "CLICKED", "click 导出反馈文件", exported);
  const reportPath = await cdp.eval(
    WAIT(
      "const el = [...document.querySelectorAll('.settings-line code')].map((n) => n.textContent.trim()).find((t) => t.includes('luma-report-')); return el || null;",
      20000,
    ),
  );
  console.log(`[info] report path: ${String(reportPath)}`);
  assert(!!reportPath, "report path shown in settings", String(reportPath));
  if (reportPath) {
    const size = statSync(reportPath).size;
    const content = readFileSync(reportPath, "utf8");
    assert(size > 1000, "report file is not empty", `${size} bytes`);
    assert(content.includes("== 诊断 =="), "report contains diagnostics", "== 诊断 ==");
    assert(/== 日志/.test(content), "report contains logs", "== 日志");
  }
} catch (err) {
  console.log(`[diag] unexpected error: ${String((err && err.stack) || err)}`);
  failures += 1;
}

assert(
  cdp.errors.length === 0,
  "no uncaught page exceptions",
  cdp.errors.slice(0, 3).join(" | ").slice(0, 600),
);
cdp.close();
console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
process.exit(failures === 0 ? 0 : 1);
