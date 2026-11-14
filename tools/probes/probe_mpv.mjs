#!/usr/bin/env node
/**
 * T-30 mpv 兜底验收：
 * 1) 随包 mpv.exe 存在且能报版本；
 * 2) mpv_play 能拉起进程并返回 pid（带防盗链头参数不报错）；
 * 3) 进程确实是 mpv，随后清理掉；
 * 4) 非 http(s) 地址被拒。
 *
 *   node tools/probes/probe_mpv.mjs
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const MPV = path.join(ROOT, "sidecars", "mpv", "mpv.exe");
const MEDIA = "http://127.0.0.1:8787/media/sample.mp4";

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
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 60000);
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
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }
  close() {
    this.ws.close();
  }
}

function processExists(pid) {
  // `tasklist` can block in a non-interactive child shell; signal 0 is a cheap
  // liveness probe and works on Windows (throws ESRCH when the pid is gone).
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  try {
    const version = execFileSync(MPV, ["--version"], { encoding: "utf8", windowsHide: true });
    check(/mpv/i.test(version), "bundled mpv.exe runs", version.split("\n")[0].slice(0, 60));
  } catch (err) {
    check(false, "bundled mpv.exe runs", String(err).slice(0, 120));
    console.log(`\nT-30 mpv summary: ${passed} pass / ${failed} fail`);
    process.exitCode = 1;
    return;
  }

  const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("no CDP page (is the dev window running?)");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;

  const invoke = (cmd, args) =>
    cdp.eval(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

  const rejected = await cdp.eval(`(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke('mpv_play', { url: 'file:///etc/passwd' });
      return 'accepted';
    } catch (e) { return String(e && e.code || e); }
  })()`);
  check(rejected === "INVALID_ARGUMENT", "non-http url rejected", String(rejected));

  // Tauri rejections are serialized AppError objects; catch inside the page so
  // the real code/message is visible instead of "Uncaught (in promise)".
  const started = await cdp.eval(`(async () => {
    try {
      const value = await window.__TAURI_INTERNALS__.invoke('mpv_play', ${JSON.stringify({
        url: MEDIA,
        title: "p3 mpv probe",
        headers: [["Referer", "http://127.0.0.1:8787/"]],
      })});
      return { ok: true, value: value };
    } catch (e) {
      return { ok: false, code: e && e.code, message: e && e.message, raw: String(e) };
    }
  })()`);
  check(started?.ok === true && Number(started?.value?.pid) > 0,
    "mpv_play returned a pid",
    started?.ok ? JSON.stringify(started.value) : `${started?.code || ""} ${started?.message || started?.raw || ""}`.slice(0, 140));

  const pid = started?.value?.pid;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const alive = processExists(pid);
  check(alive, "mpv process is running", `pid=${pid}`);

  try {
    process.kill(Number(pid));
  } catch {
    /* already gone */
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  check(!processExists(pid), "mpv process cleaned up", `pid=${pid}`);

  cdp.close();
  console.log(`\nT-30 mpv summary: ${passed} pass / ${failed} fail`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("PROBE FAILED:", err);
  process.exitCode = 1;
});
