#!/usr/bin/env node
/**
 * JS 源首页探针：配置里每个 quickjs 站能不能在首页拿到「分类」或「卡片」。
 *
 * 为什么单独一条：`homeContent` 在 TVBox 协议里给的是 `class` 字段，py 适配层
 * 会改写成 `classes`，而 quickjs 源是原样透传。少了这层映射，JS 源首页看起来
 * 完全没数据（分类空白 + 无卡片），但搜索/详情其实是好的——这条探针专门盯
 * 这个「首页」维度，逐站真跑前端链路（切站 → 重新加载 → 等稳定）。
 *
 * 用法：
 *   node tools/probes/probe_js_home.mjs                # 全部 js 源
 *   node tools/probes/probe_js_home.mjs 荐片 apple     # 指定站点
 *   node tools/probes/probe_js_home.mjs --strict       # 已知死链也判失败
 *
 * 前置：dev 窗口带 CDP 9222、vite 在 1420、NO_PROXY 含 127.0.0.1,localhost。
 * 口径：分类数 > 1（「推荐」之外至少一个分类）或卡片数 > 0 即「首页有内容」。
 *       推荐流为空但分类可点，算合格——DRPY 型源的推荐流本来就常空。
 */
import { writeFileSync } from "node:fs";

const STRICT = process.argv.includes("--strict");
const ONLY = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));

/**
 * 已知的**源侧**死链：客户端修不了，别让它每天把探针刷红。
 * 排查口径：`curl -s --noproxy '*' -o /dev/null -w "%{http_code}" <ext>`。
 */
const KNOWN_DEAD = {
  js_KTV歌厅: "ext=https://raw.githubusercontent.com/cluntop/tvbox/main/js/drpy2.js 上游 404（规则文件已删）",
};

const SETTLE_MS = 25_000;
const SHOT_DIR = "tools/.out";

function pickTarget(list) {
  return list.find((item) => {
    try {
      const url = new URL(item.url);
      return item.type === "page" && url.port === "1420";
    } catch {
      return false;
    }
  });
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
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      const slot = this.pending.get(msg.id);
      if (slot) {
        this.pending.delete(msg.id);
        slot(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const reply = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (reply.result?.exceptionDetails) {
      throw new Error(JSON.stringify(reply.result.exceptionDetails).slice(0, 400));
    }
    return reply.result?.result?.value;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const target = pickTarget(targets);
if (!target) {
  console.error("找不到 1420 的页面目标：先起 dev（vite + luma）再跑探针");
  process.exit(2);
}

const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.ready;
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
// 页面可能停在导航失败的白页上（vite 没起时 localStorage 会 SecurityError）。
await cdp.send("Page.navigate", { url: "http://localhost:1420/" });
await sleep(3500);

const snapRaw = await cdp.eval(
  `window.__TAURI_INTERNALS__.invoke('config_active').then((v) => JSON.stringify(v))`,
);
const sites = (JSON.parse(snapRaw).sites ?? []).filter(
  (site) => String(site.jar ?? "") === "js" || String(site.api ?? "").includes(".js"),
);
const queue = ONLY.length ? sites.filter((site) => ONLY.includes(site.key)) : sites;

console.log(`[setup] js 源 ${sites.length} 个，本轮跑 ${queue.length} 个`);

const rows = [];
for (const site of queue) {
  await cdp.eval(
    `localStorage.setItem('luma:home:site:v1', ${JSON.stringify(site.key)}); sessionStorage.clear();`,
  );
  await cdp.eval(`location.hash = '#/'`);
  await cdp.send("Page.reload", { ignoreCache: false });

  const startedAt = Date.now();
  let state = null;
  let sawLoading = false;
  for (let tick = 0; tick < 100; tick += 1) {
    await sleep(300);
    state = JSON.parse(
      await cdp.eval(`(() => {
        const chips = [...document.querySelectorAll('.chip-row .chip')].map((el) => el.textContent);
        // 「推荐」是固定入口，「暂无分类」是占位符：两者都不是真实分类。
        const real = chips.filter((text) => text !== '推荐' && text !== '暂无分类');
        return JSON.stringify({
          trigger: document.querySelector('.app-select__trigger')?.textContent || '',
          chips: real.length,
          sample: chips.slice(0, 3),
          cards: document.querySelectorAll('.vod-card').length,
          empty: document.querySelector('.empty__title')?.textContent || '',
          error: document.querySelector('.error-bar')?.textContent || '',
          loading: Boolean(document.querySelector('.spinner, .sk-grid, .vod-skeleton')),
        });
      })()`),
    );
    if (state.loading) {
      sawLoading = true;
    }
    // 冷启动时 loading 可能还没置起来，先空跑几轮再认结果。
    const settled = !state.loading && (state.cards > 0 || state.empty || state.error);
    if (settled && (sawLoading || tick > 10)) {
      break;
    }
  }

  const elapsed = Date.now() - startedAt;
  const hasContent = state && (state.chips > 0 || state.cards > 0);
  const knownDead = blockedBySource(site.key);
  rows.push({ ...site, ...state, elapsed, hasContent, knownDead });

  const tag = hasContent ? "PASS" : knownDead ? "SKIP" : "FAIL";
  console.log(
    `${tag} ${site.key} ${elapsed}ms 分类=${state.chips} 卡片=${state.cards}` +
      (hasContent ? ` 例：${state.sample.join(" / ")}` : ` ${state.empty || state.error}`) +
      (!hasContent && knownDead ? `\n     已知源缺陷：${knownDead}` : ""),
  );

  writeFileSync(
    `${SHOT_DIR}/js-home-${site.key.replace(/[^\w\u4e00-\u9fa5]/g, "_")}.png`,
    Buffer.from(
      (await cdp.send("Page.captureScreenshot", { format: "png" })).result.data,
      "base64",
    ),
  );
}
cdp.ws.close();

const failed = rows.filter((row) => !row.hasContent && (STRICT || !row.knownDead));
const known = rows.filter((row) => !row.hasContent && !STRICT && row.knownDead);
console.log(
  `\n结果：${rows.length - failed.length - known.length} 通过 / ${known.length} 已知源缺陷 / ${failed.length} 失败`,
);
if (failed.length) {
  for (const row of failed) {
    console.error(`  - ${row.key}：分类 ${row.chips}、卡片 ${row.cards}、错误「${row.error}」`);
  }
  process.exit(1);
}

function blockedBySource(key) {
  return KNOWN_DEAD[key] ?? "";
}
