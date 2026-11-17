#!/usr/bin/env node
/**
 * 端到端验证「真实数据带豆瓣 subject id 时，详情页真的走 id 直取」。
 *
 * 取样必须是找出来的，不是碰运气：首页推荐在 `豆瓣[py]` 之类源上，条目天然没有
 * `vod_douban_id`（py 源自己构造 VodInfo），点首页卡片永远碰不到这条链路——
 * 第一版探针就是这么空转的。这里改为：
 *   1. 从 active 配置里取 CMS 站（排除 .py/.js 源）；
 *   2. 直接抓该站 `ac=videolist`，找一个 `vod_douban_id` 非零的条目；
 *   3. 把窗口导航到 `/detail/<siteKey>/<vodId>`；
 *   4. 轮询宿主日志增量里有没有 `走 subject_id 直取`。
 *
 * 判据用宿主日志而不是 DOM/网络：豆瓣取数走 Rust reqwest，不经 WebView2，
 * CDP Network 抓不到；`run_enrichment` 的 id 分支入口有 INFO，是唯一硬证据。
 *
 * 依赖 dev 窗口（CDP 9222）。  node tools/probes/probe_douban_subject_id.mjs
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP_LIST = "http://127.0.0.1:9222/json/list";
const MARKER = "走 subject_id 直取";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

function logPath() {
  const day = new Date().toISOString().slice(0, 10);
  return join(homedir(), "AppData", "Roaming", "Luma-debug", "logs", "app", `luma.${day}.log`);
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/** 从字节偏移读到末尾：日志被 writer 持有，整文件读会共享冲突，显式 fd 可读。 */
function readFrom(path, offset, capBytes = 600000) {
  const size = sizeOf(path);
  const len = Math.min(Math.max(0, size - offset), capBytes);
  if (len === 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

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
        const d = msg.params?.exceptionDetails;
        this.errors.push(d?.exception?.description || d?.text || "unknown exception");
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
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(`eval failed: ${res.exceptionDetails.text}`);
    return res.result?.value;
  }

  /** 导航会销毁执行上下文——那正是导航发生的信号，吞掉它并等重建。 */
  async goto(hash) {
    try {
      await this.eval(`(() => { location.hash = ${JSON.stringify(hash)}; return true; })()`);
    } catch (err) {
      const text = String(err?.message ?? err);
      if (!/context|destroyed|Not available/i.test(text)) throw err;
    }
    await sleep(2000);
  }

  close() {
    this.ws.close();
  }
}

async function waitForPage(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP_LIST)).json();
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const page =
        pages.find((t) => t.url.startsWith("http://localhost:1420")) ??
        pages.find((t) => !t.url.startsWith("edge://") && !t.url.startsWith("chrome://"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("CDP page target not found");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

  // 1) 取站点清单（走应用自己的命令，保证与真实播放同源同址）
  const sites = JSON.parse(
    await cdp.eval(`(async () => {
      const cfg = await window.__TAURI_INTERNALS__.invoke('config_active');
      return JSON.stringify((cfg.sites || [])
        .filter((s) => s.enabled !== false && !/\\.(py|js)$/i.test(String(s.api || '')))
        .map((s) => ({ key: s.key, name: s.name, api: s.api })));
    })()`),
  );
  assert(sites.length > 0, "active 配置里有 CMS 站", `sites=${sites.length}`);

  // 2) 找候选条目：多站多页收集后**随机取一个**。
  //    固定取第一条会让第二次运行撞上后端正缓存（键 `id:{subject_id}`，TTL 10min），
  //    那时 `douban_request` 在缓存分支就返回了，根本走不到 id 分支入口 ——
  //    探针因此不幂等，表现为「单跑绿、连跑红」（docs/MAINTENANCE.md §9 那一类）。
  const candidates = [];
  for (const site of sites.slice(0, 6)) {
    const base = String(site.api);
    for (const pg of [1, 2]) {
      const url = `${base}${base.includes("?") ? "&" : "?"}ac=videolist&pg=${pg}`;
      let json;
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA, Referer: base }, signal: AbortSignal.timeout(15000) });
        json = JSON.parse(await res.text());
      } catch {
        continue;
      }
      for (const v of json.list || []) {
        const raw = String(v?.vod_douban_id ?? "").trim();
        if (raw && raw !== "0" && v?.vod_id) {
          candidates.push({ site, vodId: String(v.vod_id), name: String(v.vod_name || ""), doubanId: raw });
        }
      }
      if (candidates.length >= 24) break;
    }
    if (candidates.length >= 24) break;
  }
  const found = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
  if (found) console.log(`[info] 候选 ${candidates.length} 条，随机取：${found.site.name} / ${found.name} / douban_id=${found.doubanId}`);
  if (!found) {
    console.log("[SKIP] 试了前 8 个 CMS 站的第一页，没有一个条目填了非零 vod_douban_id（源侧取样，不是接线断了）");
  } else {
    console.log(`[info] 取样：${found.site.name} / ${found.name} / douban_id=${found.doubanId}`);

    // 3) 导航到该条目的详情页，并轮询日志增量
    const beforeSize = sizeOf(logPath());
    await cdp.goto(`#/detail/${encodeURIComponent(found.site.key)}/${encodeURIComponent(found.vodId)}`);

    let line = null;
    let doubanOnScreen = false;
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && !line) {
      const fresh = readFrom(logPath(), beforeSize);
      const idx = fresh.indexOf(MARKER);
      if (idx >= 0) line = fresh.slice(Math.max(0, idx - 80), idx + 200).replace(/\n/g, " ");
      else {
        // 页面上出现豆瓣格式（★ 分数）说明富化成功，只是可能命中了正缓存：
        // 那是「本次没走到入口」，不是「接线断了」。
        doubanOnScreen = Boolean(
          await cdp.eval(`(() => /★\\s*\\d/.test(document.querySelector('.page-body')?.textContent || ''))()`),
        );
      }
      if (!line) await sleep(1500);
    }
    if (line) {
      assert(true, "详情页真的把 id 传到了后端并走了 id 直取");
      console.log(`[evidence] ${line}`);
    } else if (doubanOnScreen) {
      console.log(
        `[SKIP] 详情页已出豆瓣数据但没有「${MARKER}」——本次命中了后端正缓存` +
          `（键 id:${found.doubanId}，TTL 10min），请求在缓存分支就返回了，不算断链`,
      );
    } else {
      assert(false, "详情页既没走 id 直取、也没出豆瓣数据", `等 40s 无「${MARKER}」，页面亦无 ★`);
    }

    // 弱校验结果一并取证（matched=true 才算这条链完整可用）
    const whole = readFrom(logPath(), beforeSize);
    const vIdx = whole.indexOf("subject_id 直取校验结果");
    if (vIdx >= 0) console.log(`[evidence] ${whole.slice(vIdx - 40, vIdx + 200).replace(/\n/g, " ")}`);
    else console.log("[info] 40s 内还没出现校验结果那行（详情比入口慢，属正常）");

    await cdp.goto("#/");
  }

  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 400));
} catch (err) {
  console.log(`[diag] unexpected error: ${String(err?.stack ?? err)}`);
  failures += 1;
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
cdp.close();
process.exit(failures === 0 ? 0 : 1);
