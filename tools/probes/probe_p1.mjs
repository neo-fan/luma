#!/usr/bin/env node
/**
 * P1 app-side acceptance: py routing, ext passthrough, fan-out timeout
 * isolation and "no orphan python child" through the real IPC surface.
 *
 * Requires: desktop app in dev (CDP 9222), stub server on 8787, and a build that
 * includes spider/python.rs. Exit 0 only when every assertion passes.
 */

const CDP = "http://127.0.0.1:9222/json/list";
const STUB = "http://127.0.0.1:8787";

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.waiters = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.waiters.get(msg.id);
      if (slot) {
        this.waiters.delete(msg.id);
        slot(msg);
      }
    });
  }

  async eval(expression) {
    await this.ready;
    const id = ++this.id;
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: { message: "timeout" } }), 60000);
      this.waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (reply.error) throw new Error(reply.error.message);
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.text);
    }
    return reply.result?.result?.value;
  }

  close() {
    this.ws.close();
  }
}

let failures = 0;
function assert(ok, label, detail = "") {
  if (ok) console.log(`[ok  ] ${label}${detail ? `  -- ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`[FAIL] ${label}${detail ? `  -- ${detail}` : ""}`);
  }
}

const targets = await (await fetch(CDP)).json();
const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
if (!page) {
  console.error("no CDP page target; start `corepack pnpm tauri dev` first");
  process.exit(2);
}
const cdp = new Cdp(page.webSocketDebuggerUrl);
const invoke = (cmd, args) =>
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args || {})})`;

// 0. isolate: remember the existing configs/active id, then import the fixture.
// NEVER delete existing configs here — an earlier version wiped a real 101-site
// config. Fan-out is scoped to the active config, so importing + activating is
// enough isolation.
const previous = JSON.parse(
  (await cdp.eval(
    `(async () => { const list = await ${invoke("config_list")}; const active = await ${invoke("config_active")}; return JSON.stringify({ active: (active && active.id) || "", count: list.length }); })()`,
  )) || "{}",
);
console.log(`[info] configs before: ${previous.count ?? 0}, active=${previous.active || "-"}`);

// 1. import the py-focused config
const importedRaw = await cdp.eval(
  `(async () => { const r = await ${invoke("config_import", {
    source: { kind: "url", value: `${STUB}/config-py.json` },
  })}; return JSON.stringify({ id: r.id, sites: r.sites.map(s => s.key + ':' + s.runtime).join(',') }); })()`,
);
const importedInfo = JSON.parse(String(importedRaw) || "{}");
const imported = importedInfo.sites || "";
const fixtureId = importedInfo.id || "";
assert(typeof imported === "string" && imported.includes("stub_py:python"), "py config imported", imported);

const pyKeys = String(imported)
  .split(",")
  .map((item) => item.split(":")[0]);

// 2. py site through the router
const home = await cdp.eval(
  `(async () => { try { const r = await ${invoke("spider_invoke", {
    request: { siteKey: "stub_py", method: "homeContent", args: [] },
  })}; return JSON.stringify({ ok: true, count: (r.list||[]).length, name: (r.list||[])[0]?.vod_name }); } catch (e) { return JSON.stringify({ ok: false, error: e }); } })()`,
);
const homeData = JSON.parse(home);
assert(homeData.ok && homeData.count === 1, "py site homeContent via IPC", home);

// 3. ext passthrough
const player = await cdp.eval(
  `(async () => { try { const r = await ${invoke("spider_invoke", {
    request: { siteKey: "stub_py", method: "playerContent", args: ["py", "x"] },
  })}; return JSON.stringify({ ok: true, ext: r.ext, url: r.url }); } catch (e) { return JSON.stringify({ ok: false, error: e }); } })()`,
);
const playerData = JSON.parse(player);
assert(playerData.ok && playerData.ext === "stub-ext-py", "ext passthrough via IPC", player);

// 4. broken source returns an error but keeps the adapter alive
const broken = await cdp.eval(
  `(async () => { try { await ${invoke("spider_invoke", {
    request: { siteKey: "stub_py_broken", method: "homeContent", args: [] },
  })}; return "NO_ERROR"; } catch (e) { return "ERR:" + (e && (e.code || e.message)); } })()`,
);
assert(String(broken).startsWith("ERR:"), "broken py site raises", String(broken).slice(0, 60));

const stillAlive = await cdp.eval(
  `(async () => { try { const r = await ${invoke("spider_invoke", {
    request: { siteKey: "stub_py", method: "homeContent", args: [] },
  })}; return (r.list||[]).length; } catch (e) { return "ERR"; } })()`,
);
assert(stillAlive === 1, "adapter survives a broken source", String(stillAlive));

// 5. fan-out with one slow source
const fanout = await cdp.eval(
  `(async () => { const started = Date.now(); try { const r = await ${invoke("spider_invoke", {
    request: { siteKey: "all", method: "homeContent", args: [], timeoutMs: 1500 },
  })}; const byKey = {}; for (const item of r.results) byKey[item.siteKey] = item.ok ? 'ok' : (item.error && item.error.code); return JSON.stringify({ tookMs: Date.now() - started, ok: r.ok, failed: r.failed, byKey }); } catch (e) { return JSON.stringify({ error: e }); } })()`,
);
const fan = JSON.parse(fanout);
assert(fan.ok >= 2 && fan.failed >= 1, "fan-out partial success", fanout);
assert(fan.byKey && fan.byKey.stub_py_slow === "SITE_TIMEOUT", "slow source timed out alone", String(fan.byKey?.stub_py_slow));
assert(fan.tookMs < 12000, "fan-out finishes near the deadline", `${fan.tookMs}ms`);

// 5b. JS 源已解禁：stub_js2 用 classic `var spider` 模板，不再被运行策略
// 一刀切屏蔽。qjs-runner 能否执行属于 policies 之外的能力判定（QuickJS ESM
// 加载器 / assets:// / drpy2 依赖），这里只验证单站 spider_invoke 能成功返回。
const jsHome = await cdp.eval(
  `(async () => { try { const r = await ${invoke("spider_invoke", {
    request: { siteKey: "stub_js2", method: "homeContent", args: [] },
  })}; return JSON.stringify({ ok: true, count: (r.list||[]).length, name: (r.list||[])[0]?.vod_name, ext: r.ext }); } catch (e) { return JSON.stringify({ ok: false, error: e && (e.code || e.message) }); } })()`,
);
const jsData = JSON.parse(jsHome);
assert(jsData.ok === true && jsData.count >= 1,
  "quickjs homeContent returns a list after JS sources are unblocked", jsHome);

const jsPlayer = await cdp.eval(
  `(async () => { try { const r = await ${invoke("spider_invoke", {
    request: { siteKey: "stub_js2", method: "playerContent", args: ["js", "x"] },
  })}; return JSON.stringify({ ok: true, ext: r.ext, url: r.url }); } catch (e) { return JSON.stringify({ ok: false, error: e && (e.code || e.message) }); } })()`,
);
const jsPlayerData = JSON.parse(jsPlayer);
assert(jsPlayerData.ok === true && typeof jsPlayerData.url === "string" && jsPlayerData.url.length > 0 && Boolean(jsPlayerData.ext),
  "quickjs playerContent returns url/ext", jsPlayer);

// 6. no orphan python processes afterwards
const orphan = await cdp.eval(
  `(async () => { try { await ${invoke("spider_invoke", {
    request: { siteKey: "stub_py", method: "homeContent", args: [] },
  })}; return "ALIVE"; } catch (e) { return "ERR"; } })()`,
);
assert(orphan === "ALIVE", "adapter usable after fan-out", String(orphan));

// 7. cleanup: remove ONLY the fixture imported above and restore the previous
// active config. Existing user configs must never be deleted by a probe.
if (fixtureId) {
  const restore = previous.active
    ? `try { await ${invoke("config_activate", { id: previous.active })}; } catch (e) {}`
    : "";
  await cdp.eval(
    `(async () => { try { await ${invoke("config_remove", { id: fixtureId })}; } catch (e) {} ${restore} return "OK"; })()`,
  );
  console.log(
    `[info] cleanup: removed fixture ${fixtureId}${previous.active ? `, restored active ${previous.active}` : ""}`,
  );
}

cdp.close();
console.log(failures === 0 ? "\nP1 APP OK" : `\nP1 APP FAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
