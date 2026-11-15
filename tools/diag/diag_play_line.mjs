#!/usr/bin/env node
/**
 * 单线路播放链路体检：详情 → playerContent 解析 → 本地反代 → 首个分片。
 * 用来定位「源能播但客户端没画面」卡在哪一环（解析 / 反代 / 分片内容 / 体积耗时）。
 *
 * 用法：node tools/diag/diag_play_line.mjs <siteKey> <vodId> <线路名关键字>
 * 例：  node tools/diag/diag_play_line.mjs py_bubuzhuiju 163030 zijianm3u8
 */
import { writeFileSync, mkdirSync } from "node:fs";

const CDP = "http://127.0.0.1:9222/json/list";
const [siteKey, vodId, lineWord] = process.argv.slice(2);
if (!siteKey || !vodId) {
  console.error("usage: node tools/diag/diag_play_line.mjs <siteKey> <vodId> [lineWord]");
  process.exit(2);
}

function isApp(t) {
  if (t.type !== "page" || !t.webSocketDebuggerUrl) return false;
  try {
    const u = new URL(t.url);
    return u.port === "1420" && u.pathname === "/";
  } catch {
    return false;
  }
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", rej, { once: true });
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
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 90000);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
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
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
    return res.result?.value;
  }
  async shot(name) {
    const res = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 86 });
    mkdirSync("tools/.out/shots", { recursive: true });
    writeFileSync(`tools/.out/shots/${name}.jpg`, Buffer.from(res.data, "base64"));
    console.log(`[shot] tools/.out/shots/${name}.jpg`);
  }
}

const target = (await (await fetch(CDP)).json()).find(isApp);
if (!target) throw new Error("app target not found");
const cdp = new Cdp(target.webSocketDebuggerUrl);

// 1) 详情：找线路与第一集地址（走 spider_invoke，与前端 api.detail 同一条命令）
const info = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('spider_invoke', { request: {
  siteKey: ${JSON.stringify(siteKey)}, method: 'detailContent', args: [${JSON.stringify(vodId)}] } })
  .then((rows) => {
    const vod = rows && rows[0];
    if (!vod) return 'EMPTY';
    const from = String(vod.vod_play_from || '').split('$$$');
    const url = String(vod.vod_play_url || '').split('$$$');
    return { name: vod.vod_name, from, url };
  }).catch((e) => 'ERR:' + e)`);

if (typeof info === "string") {
  console.log("[detail]", info);
  process.exit(1);
}
const word = lineWord || "";
let idx = info.from.findIndex((f) => String(f).includes(word));
if (idx < 0) idx = 0;
const lineName = info.from[idx];
const episodes = String(info.url[idx] || "").split("#");
const first = episodes[0] || "";
const sep = first.indexOf("$");
const epName = sep >= 0 ? first.slice(0, sep) : "";
const epUrl = sep >= 0 ? first.slice(sep + 1) : first;
console.log(`[line] ${lineName} · ${episodes.length} 集 · 首集 ${epName}`);
console.log(`[ep-url] ${epUrl.slice(0, 160)}`);

// 2) 源侧解析（playerContent）：前端 resolveEpisodeTarget 同款调用
const t0 = Date.now();
const target2 = await cdp.eval(`(async () => {
  const mod = await import('/src/lib/episodeResolve.ts');
  try {
    const r = await mod.resolveEpisodeTarget(${JSON.stringify(siteKey)}, ${JSON.stringify(lineName)}, ${JSON.stringify(epUrl)}, { playerContentTimeoutMs: 20000 });
    return { url: String(r.url || '').slice(0, 300), ua: r.ua || '', referer: r.referer || '', parser: r.parser || '', unresolvable: !!r.unresolvable };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
})()`);
console.log(`[playerContent ${Date.now() - t0}ms]`, JSON.stringify(target2));
if (!target2 || target2.error || !target2.url) {
  console.log("STOP: playerContent failed");
  process.exit(1);
}

// 3) 本地反代
const t1 = Date.now();
const resolved = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('resolve_play', { request: {
  siteKey: ${JSON.stringify(siteKey)},
  url: ${JSON.stringify(target2.url)},
  ua: ${JSON.stringify(target2.ua || "")},
  referer: ${JSON.stringify(target2.referer || "")},
  cookie: "",
} }).then((r) => r).catch((e) => 'ERR:' + e)`);
console.log(`[resolve_play ${Date.now() - t1}ms]`, JSON.stringify(resolved).slice(0, 600));
if (typeof resolved === "string") process.exit(1);

// 必须走 proxyUrl：`resolved.url` 是源站直链，直接 fetch 它会绕过反代，
// 看不到重写后的分片地址，也拿不到 UA/referer（上一版就是取错了这个字段）。
const proxyUrl = resolved.proxyUrl || "";
if (!proxyUrl) {
  console.log("STOP: resolve_play 没有返回 proxyUrl");
  process.exit(1);
}
console.log("[proxy]", proxyUrl.slice(0, 200));

// 4) 拉清单：确认反代返回的是真 m3u8，且分片/密钥都改写成反代地址
const t2 = Date.now();
const manifest = await cdp.eval(`(async () => {
  const res = await fetch(${JSON.stringify(proxyUrl)}, { cache: 'no-store' });
  const text = await res.text();
  const lines = text.split('\\n').map((l) => l.trim()).filter(Boolean);
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    marker: res.headers.get('x-luma-proxy'),
    len: text.length,
    key: lines.find((l) => l.startsWith('#EXT-X-KEY')) || '',
    segments: lines.filter((l) => !l.startsWith('#')).slice(0, 2),
    proxiedSegments: lines.filter((l) => !l.startsWith('#') && l.includes('127.0.0.1')).length,
    totalSegments: lines.filter((l) => !l.startsWith('#')).length,
  };
})()`);
console.log(`[manifest ${Date.now() - t2}ms]`, JSON.stringify(manifest, null, 2));

// 5) 首个分片（已重写为反代地址）：Content-Type / 字节头 / 体积 / 耗时
const segUrl = (manifest.segments || [])[0];
if (segUrl) {
  const t3 = Date.now();
  const seg = await cdp.eval(`(async () => {
    const res = await fetch(${JSON.stringify(segUrl)}, { cache: 'no-store' });
    const buf = new Uint8Array(await res.arrayBuffer());
    const hex = [...buf.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const png = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    return { status: res.status, type: res.headers.get('content-type'), bytes: buf.length, hex, png };
  })()`);
  console.log(`[seg ${Date.now() - t3}ms]`, JSON.stringify(seg));
}

// 5b) AES key 也要能经反代取到，否则 hls.js 无法解密分片
if (manifest.key) {
  const keyUri = (manifest.key.match(/URI="([^"]+)"/) || [])[1];
  if (keyUri) {
    const t4 = Date.now();
    const key = await cdp.eval(`(async () => {
      const res = await fetch(${JSON.stringify(keyUri)}, { cache: 'no-store' });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bytes: buf.length };
    })()`);
    console.log(`[key ${Date.now() - t4}ms]`, JSON.stringify(key));
  }
}

// 6) 走真实 UI 进播放页（player 参数走 history.state，不能靠 URL query 拼）
console.log("[step] 从详情页点该线路第一集，观察 30s …");
const click = await cdp.eval(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  location.hash = '#/detail/' + encodeURIComponent(${JSON.stringify(siteKey)}) + '/' + encodeURIComponent(${JSON.stringify(vodId)});
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(250); } return null; };
  if (!(await waitFor(() => document.querySelector('.chip-row--lines .chip'), 30000))) return 'NO_CHIPS';
  // 线路 chip 可能比分类 chip 晚到：等目标线路名出现，别只看「有 chip」。
  const chip = await waitFor(() => [...document.querySelectorAll('.chip-row--lines .chip')]
    .find((c) => (c.textContent || '').includes(${JSON.stringify(lineName)})), 20000);
  if (!chip) return 'NO_CHIP:' + ${JSON.stringify(lineName)};
  chip.click();
  await sleep(600);
  const ep = await waitFor(() => document.querySelector('.episode-grid .episode'), 10000);
  if (!ep) return 'NO_EPISODE';
  ep.click();
  return 'CLICKED';
})()`);
console.log("[step] click ->", click);
const video = await cdp.eval(`(async () => {
  const end = Date.now() + 35000;
  let last = null;
  while (Date.now() < end) {
    const v = document.querySelector('video');
    if (v) {
      last = { vw: v.videoWidth, vh: v.videoHeight, t: +v.currentTime.toFixed(1), ready: v.readyState, err: v.error ? v.error.code + ':' + v.error.message : '' };
      if (v.videoWidth > 0 && v.currentTime > 0.5) return last;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return last || 'NO_VIDEO';
})()`);
console.log("[video]", JSON.stringify(video));
await cdp.shot("diag-line-player");
cdp.ws.close();
