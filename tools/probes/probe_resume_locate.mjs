#!/usr/bin/env node
/**
 * 续播定位验收：造一条「上次线路 = 第 2 条、上次集 = 第 3 集」的历史记录，
 * 重新打开详情页，检查线路 chip 是否自动选中第 2 条、剧集工具行是否提示
 * 「上次看到」、剧集格是否打上 is-seen 角标。跑完删除这条测试历史。
 *
 * 用法：node tools/probes/probe_resume_locate.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";

const CDP = "http://127.0.0.1:9222/json/list";

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
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
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
await cdp.send("Page.enable");

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "[ok  ]" : "[FAIL]"} ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) failures += 1;
};

// 1) 回首页，打开第一张卡片（保证详情有剧集）
await cdp.eval(`(() => { location.hash = '#/'; return true; })()`);
const opened = await cdp.eval(`(async () => {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    const card = document.querySelector('.vod-card');
    if (card) { card.click(); return 'CLICKED'; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'NO_CARD';
})()`);
check(opened === "CLICKED", "打开首页第一张卡片", String(opened));

const meta = await cdp.eval(`(async () => {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    const chips = [...document.querySelectorAll('.chip-row--lines .chip')];
    if (chips.length > 0 && document.querySelectorAll('.episode-grid .episode').length > 2) {
      const hash = location.hash;
      const [, , site, vod] = hash.split('/');
      const title = document.querySelector('.detail-title-row .page-title__name')?.textContent?.trim()
        || document.querySelector('.detail-title-row')?.textContent?.trim() || '';
      const names = chips.map((c) => (c.textContent || '').replace(/\\s+/g, ' ').trim());
      // chip 文案是「线路名（N）」，取线路名本体
      const lineName = (i) => names[i].replace(/（\\d+）$/, '').trim();
      // 集名必须取自**目标线路**：不同线路的集名可能完全不同（金鹰 5 集特辑
      // vs 闪电 16 集正片），拿第 1 条线路的集名去造第 2 条线路的历史，
      // 「同线路 + 同集名」的 is-seen 兜底就永远命中不了。
      chips[1] && chips[1].click();
      await new Promise((r) => setTimeout(r, 400));
      const eps2 = [...document.querySelectorAll('.episode-grid .episode')].map((e) => (e.textContent || '').trim());
      return {
        site: decodeURIComponent(site || ''),
        vod: decodeURIComponent(vod || ''),
        title,
        lines: names,
        line2: lineName(1) || lineName(0),
        ep3: eps2[2] || eps2[0] || '',
        episodeCount: eps2.length,
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'TIMEOUT';
})()`);
if (typeof meta === "string") throw new Error("detail not ready: " + meta);
console.log("[detail meta]", JSON.stringify(meta));
check(!!meta.line2 && !!meta.ep3, "拿到第 2 条线路与第 3 集", `${meta.line2} / ${meta.ep3}`);

// 2) 造历史：上次线路 = 第 2 条，上次集 = 第 3 集
const upsert = await cdp.eval(`window.__TAURI_INTERNALS__.invoke('history_upsert', { item: {
  siteKey: ${JSON.stringify(meta.site)},
  vodId: ${JSON.stringify(meta.vod)},
  name: ${JSON.stringify(meta.title)},
  siteName: ${JSON.stringify(meta.site)},
  playUrl: '',
  episodeName: ${JSON.stringify(meta.ep3)},
  playFrom: ${JSON.stringify(meta.line2)},
  positionMs: 123000,
  durationMs: 2700000,
  updatedAt: Date.now(),
} }).then(() => 'OK').catch((e) => 'ERR:' + e)`);
check(upsert === "OK", "写入测试历史", String(upsert));
await cdp.eval(`window.__TAURI_INTERNALS__.invoke('page_cache_clear').catch(() => null)`).catch(() => null);

// 3) 先离开详情页再回来（同一路由不会重新挂载）
await cdp.eval(`(() => { location.hash = '#/favorites'; return true; })()`);
await new Promise((r) => setTimeout(r, 700));
await cdp.eval(
  `(() => { location.hash = '#/detail/' + encodeURIComponent(${JSON.stringify(meta.site)}) + '/' + encodeURIComponent(${JSON.stringify(meta.vod)}); return true; })()`,
);

const result = await cdp.eval(`(async () => {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    const chips = [...document.querySelectorAll('.chip-row--lines .chip')];
    if (chips.length > 0 && document.querySelector('.episode-grid')) {
      await new Promise((r) => setTimeout(r, 600));
      const again = [...document.querySelectorAll('.chip-row--lines .chip')];
      const active = again.findIndex((c) => c.classList.contains('is-active'));
      return {
        activeIndex: active,
        activeText: (again[active]?.textContent || '').replace(/\\s+/g, ' ').trim(),
        seenCount: document.querySelectorAll('.episode.is-seen').length,
        seenText: document.querySelector('.episode.is-seen')?.textContent?.trim() || '',
        hint: document.querySelector('.detail-episode-tools__seen')?.textContent?.trim() || '',
      };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'TIMEOUT';
})()`);
console.log("[result]", JSON.stringify(result, null, 2));

if (typeof result === "object") {
  check(
    result.activeIndex === 1,
    "线路自动定位到第 2 条（上次用的）",
    `activeIndex=${result.activeIndex} ${result.activeText}`,
  );
  check(result.seenCount === 1, "上次那集打上 is-seen 角标", `count=${result.seenCount} ${result.seenText}`);
  check(result.hint.includes(meta.ep3), "剧集工具行提示「上次看到」", result.hint);
}
await cdp.shot("resume-locate");

// 4) 清理测试历史
await cdp
  .eval(
    `window.__TAURI_INTERNALS__.invoke('history_remove', { siteKey: ${JSON.stringify(meta.site)}, vodId: ${JSON.stringify(meta.vod)} }).then(() => 'CLEANED').catch((e) => 'ERR:' + e)`,
  )
  .then((r) => console.log("[cleanup]", r));

cdp.ws.close();
console.log(failures === 0 ? "PASS" : `FAILED ${failures}`);
process.exit(failures === 0 ? 0 : 1);
