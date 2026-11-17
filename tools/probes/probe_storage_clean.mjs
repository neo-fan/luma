#!/usr/bin/env node
/**
 * 设置页「存储与清理」回归：
 *   1. 三个可清理条目（缓存 / 日志 / 反馈报告）都在，且用量数字是真读出来的；
 *   2. 条目为空时按钮禁用（不给人点了没反应的入口）；
 *   3. 点「清理」→ 二次确认 → 提示里必须给出释放量与剩余量；
 *   4. 清理后用量重新统计，剩余量不得高于清理前；
 *   5. 设置页不再有「观看历史」入口（清理归历史页，避免两处按钮做同一件事）。
 *
 * 只清封面缓存：它按内容寻址、清掉就是回源重取，不动用户的收藏/历史/配置。
 * 日志与报告的清理路径由 Rust 侧单测覆盖（含日志文件被 writer 占用时的清空回退）。
 *
 * 依赖 dev 窗口（CDP 9222）。  node tools/probes/probe_storage_clean.mjs
 */
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

const WAIT = (expression, timeout = 15000) => `(async () => {
  const deadline = Date.now() + ${timeout};
  while (Date.now() < deadline) {
    const value = await (async () => { ${expression} })();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
})()`;

/** 存储 block 的当前视图：三行的用量与按钮可用性。 */
const SNAPSHOT = `(() => {
  const block = [...document.querySelectorAll('.settings-block')].find((el) =>
    el.querySelector('.section-title')?.textContent.includes('存储与清理'));
  if (!block) return null;
  const rows = [...block.querySelectorAll('.config-item')].map((row) => ({
    label: row.querySelector('.config-item__name')?.textContent.trim() || '',
    usage: row.querySelector('.config-item__meta')?.textContent.trim() || '',
    disabled: row.querySelector('button')?.disabled !== false,
  }));
  const total = block.querySelector('.section-title')?.textContent.trim() || '';
  return JSON.stringify({
    rows,
    total,
    hasHistoryEntry: [...document.querySelectorAll('.settings-block')].some((el) =>
      el.querySelector('.section-title')?.textContent.includes('观看历史')),
  });
})()`;

let failures = 0;
const assert = (ok, label, detail = "") => {
  console.log(`[${ok ? "ok  " : "FAIL"}] ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/** `3.4 MB · 128 个文件` / `0 B · 0 个文件` → `{bytes, files}`；解析不出来返回 null 让上层判失败。 */
function parseUsage(text) {
  const match = /^([\d.]+)\s*(B|KB|MB|GB)\s*·\s*(\d+)\s*个文件$/.exec(text);
  if (!match) return null;
  const units = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
  return {
    bytes: Math.round(Number(match[1]) * units[match[2]]),
    files: Number(match[3]),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
console.log(`target: ${page.url}`);

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // 封面缓存可能是空的（全新安装，或上一次运行刚清过），那样「清理」这一步就没东西
  // 可验。先去首页把封面拉起来。
  await cdp.eval(`location.hash = '#/'`);
  await cdp.eval(
    WAIT(`return document.querySelectorAll('.poster-tile').length > 0 ? 'OK' : null;`, 40000),
  );
  // 海报是 loading=lazy：不滚进视口就根本不发请求。
  for (const ratio of [0.25, 0.5, 0.75]) {
    await cdp.eval(`(() => { window.scrollTo(0, document.body.scrollHeight * ${ratio}); return true; })()`);
    await sleep(1500);
  }
  // 光加载还不够：`<img>` 带 max-age=604800，第二次起 WebView2 自己就把它答了，
  // Rust 侧磁盘缓存根本不写。用 cache:'reload' 强制回源一趟，才有可清理的条目。
  const warmed = await cdp.eval(`(async () => {
    const imgs = [...document.querySelectorAll('.poster-tile img')].filter((img) => img.naturalWidth > 0);
    let forced = 0;
    for (const img of imgs.slice(0, 12)) {
      try {
        const res = await fetch(img.src, { cache: 'reload' });
        if (res.ok) forced += 1;
      } catch {
        /* 单张失败不影响其余 */
      }
    }
    await new Promise((r) => setTimeout(r, 800));
    return forced > 0 ? forced : null;
  })()`);
  console.log(`[info] 强制回源的封面数: ${warmed}`);

  await cdp.eval(`location.hash = '#/settings'`);
  assert(
    (await cdp.eval(WAIT("return document.querySelector('.settings-block .config-list') ? 'OK' : null;", 30000))) === "OK",
    "settings page rendered",
  );

  // 用量是异步 IPC 读的，先等它出真数字，否则断言会落在「统计中…」上。
  await cdp.eval(
    WAIT(`const raw = ${SNAPSHOT}; if (!raw) return null;
      const snap = JSON.parse(raw);
      return snap.rows.length === 3 && snap.rows.every((r) => !r.usage.includes('统计中')) ? raw : null;`, 30000),
  );

  const before = JSON.parse((await cdp.eval(SNAPSHOT)) || "null");
  console.log(`[info] before: ${JSON.stringify(before?.rows)}`);
  assert(before !== null, "storage block present", String(before === null));
  assert(before?.rows?.length === 3, "3 clearable rows", String(before?.rows?.length));
  assert(
    JSON.stringify(before?.rows?.map((row) => row.label)) ===
      JSON.stringify(["缓存", "日志", "反馈报告"]),
    "row labels are 缓存/日志/反馈报告",
    JSON.stringify(before?.rows?.map((row) => row.label)),
  );
  assert(before?.hasHistoryEntry === false, "settings no longer hosts a 观看历史 entry", String(before?.hasHistoryEntry));

  const parsed = new Map(
    (before?.rows ?? []).map((row) => [row.label, parseUsage(row.usage)]),
  );
  assert(
    [...parsed.values()].every((value) => value !== null),
    "usage numbers parsed from UI",
    JSON.stringify([...parsed]),
  );
  assert(/共\s*\d/.test(before?.total ?? ""), "total size shown in title", before?.total);

  const cacheRow = before.rows.find((row) => row.label === "缓存");
  const cacheUsage = parsed.get("缓存");
  if (cacheUsage.files === 0) {
    // 空缓存没有可清理内容，按钮必须禁用；这条断言本身就有效，不算 SKIP 掉整段。
    assert(cacheRow.disabled === true, "empty cache disables its button", JSON.stringify(cacheRow));
    console.log("[info] 封面缓存为空，跳过清理动作（环境状态，不是失败）");
  } else {
    assert(cacheRow.disabled === false, "non-empty cache enables its button", JSON.stringify(cacheRow));

    const clicked = await cdp.eval(`(() => {
      const block = [...document.querySelectorAll('.settings-block')].find((el) =>
        el.querySelector('.section-title')?.textContent.includes('存储与清理'));
      const row = [...block.querySelectorAll('.config-item')].find((r) =>
        r.querySelector('.config-item__name')?.textContent.trim() === '缓存');
      row.querySelector('button').click();
      return 'CLICKED';
    })()`);
    assert(clicked === "CLICKED", "click 清理 on 缓存", clicked);

    const dialog = await cdp.eval(
      WAIT(`const el = document.querySelector('.confirm[role="alertdialog"]');
        return el ? (el.querySelector('.confirm__title')?.textContent.trim() || 'OPEN') : null;`, 8000),
    );
    assert(typeof dialog === "string" && dialog.includes("缓存"), "confirm dialog names 缓存", String(dialog));

    const confirmed = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.confirm__actions button')].pop();
      if (!btn) return 'MISSING';
      btn.click();
      return btn.textContent.trim();
    })()`);
    assert(confirmed === "清理", "dialog confirm is 清理", String(confirmed));

    const notice = await cdp.eval(
      WAIT(`const tip = document.querySelector('.tip.tip--ok');
        return tip && tip.textContent.includes('已清理缓存') ? tip.textContent.trim() : null;`, 30000),
    );
    console.log(`[info] notice: ${notice}`);
    assert(typeof notice === "string", "notice reports the clear", String(notice));
    const freed = /释放\s*([\d.]+\s*(?:B|KB|MB|GB))/.exec(notice ?? "");
    const remaining = /剩余\s*([\d.]+\s*(?:B|KB|MB|GB))/.exec(notice ?? "");
    assert(freed !== null, "notice states freed size", notice);
    assert(remaining !== null, "notice states remaining size", notice);

    // 提示文案之外，还要看界面重新统计后的用量。就绪信号取「日志行按钮可用」：
    // 清理进行中三行按钮都被 busy 挡着（防连点重复提交），过早读到的是清理前的
    // 数字；而刚清空的缓存行本身就该是禁用（空条目不可清），不能拿它当信号。
    const readyRaw = await cdp.eval(
      WAIT(`const raw = ${SNAPSHOT}; if (!raw) return null;
        const snap = JSON.parse(raw);
        if (snap.rows.some((r) => r.usage.includes('统计中'))) return null;
        const logRow = snap.rows.find((r) => r.label === '日志');
        return logRow && !logRow.disabled ? raw : null;`, 30000),
    );
    const after = JSON.parse(readyRaw || (await cdp.eval(SNAPSHOT)) || "null");
    const cacheRowAfter = after?.rows?.find((row) => row.label === "缓存");
    const afterCache = parseUsage(cacheRowAfter?.usage ?? "");
    console.log(`[info] after: ${JSON.stringify(after?.rows)}`);
    assert(
      afterCache !== null && cacheRowAfter !== undefined,
      "cache usage re-measured",
      JSON.stringify(after?.rows),
    );
    assert(
      afterCache !== null && afterCache.bytes < cacheUsage.bytes / 2,
      "cache usage dropped after clear",
      `${cacheUsage.bytes} → ${afterCache?.bytes}`,
    );
  }

  assert(cdp.errors.length === 0, "no uncaught page exceptions", cdp.errors.slice(0, 3).join(" | ").slice(0, 600));
} catch (err) {
  console.log(`[diag] unexpected error: ${String((err && err.stack) || err)}`);
  failures += 1;
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${failures} failed step(s)`);
cdp.close();
process.exit(failures === 0 ? 0 : 1);
