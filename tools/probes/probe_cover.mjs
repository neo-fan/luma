#!/usr/bin/env node
/**
 * 封面图代理端到端回归（TVBox `vod_pic` 内嵌 @header 兑现）。
 *
 * TVBox 源把图片请求头拼进 vod_pic：`真实URL@Referer=..@User-Agent=..`。
 * 原生客户端在图片加载层注入这些头；WebView2 <img> 无法自带 header，
 * 走 Rust 本地反代 `/image`（宿主层，对应原生 ImgUtil 拦截器）。
 *
 * 断言：
 *   1. dev server 提供新前端（imageUrl.ts / useProxiedImage）；
 *   2. /image 后端路由：带内嵌 header 的豆瓣图 -> 200 + image/* + 真实字节；
 *      安全边界：data: 与「非图片 content-type」被拒（非 2xx）；
 *   3. 首页卡片 <img src> 指向 /image? 且 naturalWidth>0（真实出图）、
 *      不再出现「无封面」占位（豆瓣 frodo 通时；外网波动记观察不 FAIL）；
 *   4. 无未捕获页面异常。
 *
 * 不导入/切换配置，只 reload；不改后端配置、不留痕。
 */
const CDP = "http://127.0.0.1:9222/json/list";
// 固定豆瓣图床地址 + 真实的内嵌 header 后缀（取自 douban.py PIC_SUFFIX）。
// 只依赖图床 + 反代，不依赖 frodo 推荐接口，作为后端路由的稳定素材。
const DOUBAN_PIC =
  "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2936933522.jpg" +
  "@Referer=https://api.douban.com/@User-Agent=Mozilla%2F5.0%20(Windows%20NT%2010.0)";

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
        this.errors.push(msg.params?.exceptionDetails?.text || "unknown");
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
  close() {
    this.ws.close();
  }
}

const WAIT = (expression, timeout = 25000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const v = (() => { ${expression} })();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
})()`;

let failures = 0;
let observations = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const observe = (label, detail = "") => {
  console.log(`[obs ] ${label}${detail ? `  -- ${detail}` : ""}`);
  observations += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPage() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP)).json();
      const page = list.find((t) => t.type === "page" && t.url.startsWith("http://localhost:1420"));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  throw new Error("no luma CDP page");
}

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}\n`);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  // 强制 reload 载最新模块，等首屏卡片就绪（首页默认站自带内容）。
  await cdp.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  await cdp.eval(WAIT("return document.querySelector('.nav__item') ? 'OK' : null;", 30000));

  // 1. 源码新鲜度自检。
  const bust = Date.now();
  const [imgSrc, hookSrc] = await Promise.all([
    fetch(`http://localhost:1420/src/lib/imageUrl.ts?p=${bust}`).then((r) => r.text()).catch(() => ""),
    fetch(`http://localhost:1420/src/hooks/useProxiedImage.ts?p=${bust}`).then((r) => r.text()).catch(() => ""),
  ]);
  const fresh = imgSrc.includes("/image?url=") && hookSrc.includes("getProxyBaseUrl");
  assert(fresh, "dev server serves fresh image-proxy chain", fresh ? "" : "stale Vite module; restart dev");
  if (!fresh) throw new Error("stale dev module; abort");

  // 2. /image 后端路由：带内嵌 header 的豆瓣图出真字节。
  const route = await cdp.eval(`(async () => {
    const base = await window.__TAURI_INTERNALS__.invoke('proxy_status').then(s => s.baseUrl);
    const url = ${JSON.stringify(DOUBAN_PIC)};
    try {
      const r = await fetch(base + '/image?url=' + encodeURIComponent(url));
      const b = await r.arrayBuffer();
      return JSON.stringify({ status: r.status, type: r.headers.get('content-type') || '', size: b.byteLength,
        magic: b.byteLength >= 2 ? [new Uint8Array(b)[0], new Uint8Array(b)[1]] : [] });
    } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
  })()`);
  const rt = JSON.parse(route || "{}");
  console.log(`[info] /image direct: ${route}`);
  assert(!rt.err && rt.status === 200 && rt.type.startsWith("image/") && rt.size > 1000,
    "/image serves real image bytes for inline-header pic",
    rt.err || `status=${rt.status} type=${rt.type} size=${rt.size}`);
  assert(Array.isArray(rt.magic) && rt.magic[0] === 0xff && rt.magic[1] === 0xd8,
    "/image body is a real JPEG (FF D8 magic)", JSON.stringify(rt.magic));

  // 2b. 安全边界：data: 与「非图片」应被拒（不让 /image 变通用抓取器）。
  const guard = await cdp.eval(`(async () => {
    const base = await window.__TAURI_INTERNALS__.invoke('proxy_status').then(s => s.baseUrl);
    const hit = async (u) => { try { const r = await fetch(base + '/image?url=' + encodeURIComponent(u)); return r.status; } catch(e){ return -1; } };
    return JSON.stringify({ data: await hit('data:image/png;base64,AAAA'),
      nonImage: await hit('http://127.0.0.1:8787/play.m3u8') });
  })()`);
  const gd = JSON.parse(guard || "{}");
  assert((gd.data ?? 0) >= 400, "data: URI rejected by /image", JSON.stringify(gd));
  assert((gd.nonImage ?? 0) >= 400, "non-image content-type rejected by /image", JSON.stringify(gd));

  // 3. 首页 DOM：卡片 img 指向 /image 且真实出图，无「无封面」占位。
  await cdp.eval(WAIT("return document.querySelectorAll('.vod-card').length > 0 ? 'OK' : null;", 25000));
  await sleep(3500); // 等图片经 /image 加载
  const dom = await cdp.eval(`JSON.stringify((() => {
    const cards = [...document.querySelectorAll('.vod-card')].slice(0, 12);
    const imgs = cards.filter(c => c.querySelector('img'));
    return { total: cards.length, withImg: imgs.length,
      decoded: imgs.filter(c => c.querySelector('img').naturalWidth > 0).length,
      proxied: imgs.filter(c => (c.querySelector('img').getAttribute('src')||'').includes('/image?')).length,
      placeholders: cards.filter(c => c.querySelector('.vod-card__ph')).length };
  })())`);
  const d = JSON.parse(dom || "{}");
  console.log(`[info] DOM covers: ${dom}`);
  if ((d.decoded ?? 0) > 0) {
    assert((d.proxied ?? 0) === (d.withImg ?? 0), "all rendered <img> route through /image", dom);
    assert((d.decoded ?? 0) >= Math.min(4, d.total ?? 0), "home covers decoded with real pixels", dom);
    assert((d.placeholders ?? 0) === 0, "no '无封面' placeholder on home cards", dom);
  } else {
    observe("home DOM cover check skipped (frodo/external or default site has no images)", dom);
  }

  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 300));
} catch (err) {
  console.log(`[diag] ${String((err && err.stack) || err)}`);
  failures += 1;
} finally {
  cdp.close();
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s), ${observations} observation(s)`);
process.exit(failures === 0 ? 0 : 1);
