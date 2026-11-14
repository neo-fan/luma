#!/usr/bin/env node
/**
 * 配置级 `headers[]`（host → header）验收。
 *
 * 桩服务的 `/echo` 会回显收到的请求头，正好用来验证：
 * 1) `resolve_play` 返回的 headers 带上了配置里针对该 host 的 UA；
 * 2) 本地反代转发时真的把这些头发给了上游（不只是返回给前端看）；
 * 3) 爬虫显式给的 UA 覆盖配置表（反代不能发出两个 User-Agent）。
 *
 * 需要 dev 窗口（9222）与 8787 桩服务：
 *   node tools/probes/probe_headers.mjs
 */
import path from "node:path";
import { writeFileSync } from "node:fs";

const ROOT = process.cwd();
const STUB = "http://127.0.0.1:8787";
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
      throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    }
    return res.result?.value;
  }
  async shot(name) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path.join(ROOT, "tools/.out", `${name}.png`), Buffer.from(res.data, "base64"));
  }
  close() {
    this.ws.close();
  }
}

const attempt = (cdp, command, args) =>
  cdp.eval(`(async () => {
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  })()`);

/** `/echo?probe=m3u8` avoids the 15s sniff that a bare page URL would trigger. */
const ECHO = `${STUB}/echo?probe=m3u8`;

/** Pull the header map out of the echo payload. */
const echoHeaders = (cdp, proxyUrl) =>
  cdp.eval(`(async () => {
    const response = await fetch(${JSON.stringify(proxyUrl)});
    const text = await response.text();
    try {
      return { status: response.status, headers: JSON.parse(text).headers || {} };
    } catch {
      return { status: response.status, headers: {}, raw: text.slice(0, 120) };
    }
  })()`);

async function main() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page (is the dev window running?)");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;

  const before = await attempt(cdp, "config_list", {});
  // Skip anything this probe (or a sibling probe) imported: inline text configs
  // and the local stub server. Otherwise a second run "restores" the fixture.
  const configs = Array.isArray(before.value) ? before.value : [];
  const isUserConfig = (item) => {
    const source = item?.source || {};
    if (!source.value || source.kind === "text") return false;
    return !String(source.value).includes("127.0.0.1:8787");
  };
  const previous = configs.find(isUserConfig);

  const config = JSON.stringify({
    name: "headers-probe",
    headers: [{ host: "127.0.0.1", header: { "User-Agent": "config-ua", "X-From-Config": "1" } }],
    sites: [{ key: "probe", name: "Probe", api: `${STUB}/cms/vod` }],
  });
  const imported = await attempt(cdp, "config_import", {
    source: { kind: "text", value: config },
  });
  check(imported.ok, "probe config imported", imported.ok ? "" : String(imported.error));

  // 1) resolve_play 把配置表的头合并进返回结果。
  const plain = await attempt(cdp, "resolve_play", {
    request: { siteKey: "probe", url: ECHO },
  });
  check(plain.ok, "resolve_play returned", plain.ok ? "" : String(plain.error));
  const returned = Object.fromEntries(
    (plain.value?.headers || []).map(([name, value]) => [String(name).toLowerCase(), value]),
  );
  check(returned["user-agent"] === "config-ua", "config UA reaches resolve_play", JSON.stringify(returned));
  check(returned["x-from-config"] === "1", "extra config header kept", JSON.stringify(returned));

  // 2) 反代真的把头发给了上游（echo 回显）。
  const seen = await echoHeaders(cdp, plain.value?.proxyUrl || "");
  check(seen.status === 200, "proxy reached upstream", `status=${seen.status}`);
  check(
    seen.headers["user-agent"] === "config-ua",
    "upstream saw the config UA",
    String(seen.headers["user-agent"] || ""),
  );
  check(
    seen.headers["x-from-config"] === "1",
    "upstream saw the extra header",
    String(seen.headers["x-from-config"] || ""),
  );

  // 3) 爬虫显式 UA 覆盖配置表，且不会发出两个 User-Agent。
  const explicit = await attempt(cdp, "resolve_play", {
    request: { siteKey: "probe", url: ECHO, ua: "spider-ua" },
  });
  const seenExplicit = await echoHeaders(cdp, explicit.value?.proxyUrl || "");
  check(
    seenExplicit.headers["user-agent"] === "spider-ua",
    "explicit UA overrides the table",
    String(seenExplicit.headers["user-agent"] || ""),
  );
  check(
    seenExplicit.headers["x-from-config"] === "1",
    "other table headers still apply",
    String(seenExplicit.headers["x-from-config"] || ""),
  );

  // 4) 不匹配的 host 不应被塞进配置表里的头。`localhost` 指向同一台桩服务，
  //    但 host 名不同，规则是精确匹配 127.0.0.1。
  const unmatched = await attempt(cdp, "resolve_play", {
    request: { siteKey: "probe", url: `${STUB.replace("127.0.0.1", "localhost")}/echo?probe=m3u8` },
  });
  const unmatchedHeaders = Object.fromEntries(
    (unmatched.value?.headers || []).map(([name, value]) => [String(name).toLowerCase(), value]),
  );
  check(
    unmatchedHeaders["x-from-config"] === undefined,
    "unmatched host stays clean",
    JSON.stringify(unmatchedHeaders),
  );

  await cdp.shot("headers-1-result");

  if (previous?.source?.value) {
    const restored = await attempt(cdp, "config_import", { source: previous.source });
    check(restored.ok, "previous config restored", previous.source.value.slice(0, 60));
  } else {
    check(true, "no previous config to restore");
  }

  cdp.close();
  console.log(`\nhost headers summary: ${passed} pass / ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exitCode = 1;
});
