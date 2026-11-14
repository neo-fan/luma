#!/usr/bin/env node
/**
 * `parses[]` 解析池验收：走真实窗口的 `parse_resolve` command。
 *
 * 断言（桩配置里的解析器是 type 1，指向 8787/parse）：
 * 1) flag 命中 `ext.flag` 时走该解析器，返回 m3u8；
 * 2) flag 不命中时回退全池（上游 `VodConfig.getParses(type, flag)` 语义）；
 * 3) 返回 header 是 `[name, value]` 数组，可直接喂给本地反代；
 * 4) 解析器全失败时返回结构化错误，不抛 panic；
 * 5) 结束时把用户原来的配置导回来。
 *
 * 需要 dev 窗口（9222）与 8787 桩服务：
 *   node tools/probes/probe_parse.mjs
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
    writeFileSync(path.join(ROOT, ".workbuddy", `${name}.png`), Buffer.from(res.data, "base64"));
  }
  close() {
    this.ws.close();
  }
}

/** 调用可能抛错的 command，返回 { ok, value | error }。 */
const attempt = (cdp, command, args) =>
  cdp.eval(`(async () => {
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: typeof err === "object" && err !== null ? (err.message || JSON.stringify(err)) : String(err), code: err && err.code };
    }
  })()`);

async function main() {
  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page (is the dev window running?)");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;

  // 记住用户原本的配置，结束时导回来。必须跳过探针自己导入的 fixture，
  // 否则第二次运行会把上次的坏配置当「用户配置」恢复回去。
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

  const imported = await attempt(cdp, "config_import", {
    source: { kind: "url", value: `${STUB}/config.json` },
  });
  check(imported.ok, "stub config imported", imported.ok ? "" : String(imported.error));

  const base = { siteKey: "stub_probe", url: "https://v.example.com/cover/1.html" };

  const hit = await attempt(cdp, "parse_resolve", {
    request: { ...base, flag: "qq", headers: { Referer: `${STUB}/` } },
  });
  check(hit.ok, "parse_resolve returned", hit.ok ? "" : String(hit.error));
  const first = hit.value || {};
  check(String(first.url || "").includes("/play.m3u8"), "type-1 parser produced a stream", String(first.url || ""));
  check(first.parser === "Stub Parse", "parser name reported", String(first.parser));
  check(first.kind === "json", "kind is json", String(first.kind));
  check(
    Array.isArray(first.headers) && first.headers.every((pair) => Array.isArray(pair) && pair.length === 2),
    "headers are [name, value] pairs",
    JSON.stringify(first.headers || []).slice(0, 120),
  );

  // flag 不命中 -> 回退全池（上游语义），不应因此失败。
  const fallback = await attempt(cdp, "parse_resolve", {
    request: { ...base, flag: "no-such-flag" },
  });
  check(
    fallback.ok && String((fallback.value || {}).url || "").includes("/play.m3u8"),
    "unknown flag falls back to the full pool",
    fallback.ok ? String((fallback.value || {}).url || "") : String(fallback.error),
  );

  // 解析器全失败时必须是结构化错误，而不是 panic 或挂死。
  // 用一份只有坏解析器的内联配置：目标是 8787 上一个不存在的路径。
  const brokenConfig = JSON.stringify({
    name: "broken-parsers",
    sites: [{ key: "broken", name: "Broken", api: `${STUB}/cms/vod` }],
    parses: [
      { name: "dead-json", type: 1, url: `${STUB}/missing-jx/?url=` },
      { name: "dead-web", type: 0, url: `${STUB}/missing-page/?url=` },
    ],
  });
  const brokenImport = await attempt(cdp, "config_import", {
    source: { kind: "text", value: brokenConfig },
  });
  check(brokenImport.ok, "broken-parser config imported", brokenImport.ok ? "" : String(brokenImport.error));

  const broken = await attempt(cdp, "parse_resolve", {
    request: { siteKey: "broken", url: "https://v.example.com/cover/2.html", flag: "" },
  });
  check(!broken.ok, "all-dead pool reports failure", broken.ok ? "unexpected success" : "");
  check(
    !broken.ok && String(broken.code || "") === "PLAY_RESOLVE_FAIL",
    "failure uses PLAY_RESOLVE_FAIL",
    String(broken.code || broken.error || ""),
  );

  // 失败之后应用必须还活着（command 层没 panic）。
  const alive = await attempt(cdp, "config_list", {});
  check(Array.isArray(alive.value), "app still responsive after pool failure");

  await cdp.shot("parse-1-result");

  // 恢复用户配置。
  if (previous?.source?.value) {
    const restored = await attempt(cdp, "config_import", { source: previous.source });
    check(restored.ok, "previous config restored", previous.source.value.slice(0, 60));
  } else {
    check(true, "no previous config to restore");
  }

  cdp.close();
  console.log(`\nparse pool summary: ${passed} pass / ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exitCode = 1;
});
