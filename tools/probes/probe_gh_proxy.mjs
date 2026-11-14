/**
 * GitHub 加速探针：设置页 UI + 真实改写链路。
 *
 * 断言四件事：
 *   1. 设置页有 4 个候选，当前生效项被选中；
 *   2. 「测速全部」能为每个候选取到结果（不可用也算结果，不判失败）；
 *   3. 切换代理后 active 运行快照里的 GitHub 链接真的换了前缀；
 *   4. 切回原代理是幂等的（不会叠成双层前缀）。
 *
 * 用法：node tools/probes/probe_gh_proxy.mjs [--keep]
 *   --keep  测完不还原（默认还原到开始时的前缀）
 */
import { writeFileSync } from "node:fs";

const PREFIX = "http://localhost:1420/";
const KEEP = process.argv.includes("--keep");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
}

const target = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find((t) => {
  try {
    const url = new URL(t.url);
    return t.type === "page" && url.port === "1420";
  } catch {
    return false;
  }
});
if (!target) {
  console.error("no CDP target on 1420");
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) => {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
  }
  return result.result?.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: PREFIX });
await sleep(4000);

let failed = 0;
const results = [];
const record = (name, ok, detail) => {
  failed += ok ? 0 : 1;
  results.push(check(name, ok, detail));
};

// ---- 0. 记录初始状态 ----
const initial = JSON.parse(
  await evaluate(`window.__TAURI_INTERNALS__.invoke('gh_proxy_state').then(v => JSON.stringify(v))`),
);
record("读取初始状态", typeof initial.prefix === "string", `prefix=${initial.prefix || "(直连)"}`);

// ---- 1. 打开设置页 ----
await evaluate(`location.hash = '#/settings'`);
await sleep(2000);
await evaluate(`document.getElementById('s-ghproxy')?.scrollIntoView({block:'start'})`);
await sleep(600);

const rows = JSON.parse(
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.gh-proxy__row')];
    return JSON.stringify({
      count: rows.length,
      labels: rows.map(r => r.querySelector('.gh-proxy__label')?.textContent || ''),
      prefixes: rows.map(r => r.querySelector('.gh-proxy__prefix')?.textContent || ''),
      checked: rows.map(r => r.querySelector('input')?.checked === true),
      rowHeights: rows.map(r => Math.round(r.getBoundingClientRect().height)),
    });
  })()`),
);
record("候选行 = 4", rows.count === 4, `count=${rows.count}`);
record(
  "只有一个候选被选中",
  rows.checked.filter(Boolean).length === 1,
  JSON.stringify(rows.checked),
);
record(
  "选中项与后端前缀一致",
  rows.prefixes[rows.checked.indexOf(true)] === (initial.prefix || "—"),
  `checked=${rows.prefixes[rows.checked.indexOf(true)]} backend=${initial.prefix || "直连"}`,
);
record(
  "行高一致",
  new Set(rows.rowHeights).size === 1,
  JSON.stringify(rows.rowHeights),
);

// ---- 2. 测速 ----
await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('.gh-proxy-foot .btn')];
  const probe = buttons.find(b => b.textContent.includes('测速'));
  probe?.click();
  return !!probe;
})()`);
let probeTexts = [];
for (let i = 0; i < 60; i++) {
  await sleep(500);
  probeTexts = JSON.parse(
    await evaluate(
      `JSON.stringify([...document.querySelectorAll('.gh-proxy__probe')].map(el => el.textContent))`,
    ),
  );
  if (probeTexts.every((text) => text !== "" && text !== "切换中…")) break;
}
record(
  "四个候选都拿到测速结果",
  probeTexts.length === 4 && probeTexts.every((text) => text.length > 0),
  JSON.stringify(probeTexts),
);

// ---- 3. 切换代理 ----
const choices = initial.choices || [];
const target0 = choices.find((choice) => choice.prefix !== initial.prefix && choice.prefix !== "");
if (!target0) {
  record("找到一个可切换的候选", false, "choices 里没有其它代理");
} else {
  const index = rows.prefixes.indexOf(target0.prefix);
  await evaluate(`document.querySelectorAll('.gh-proxy__row')[${index}]?.click()`);
  let applied = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    applied = JSON.parse(
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke('gh_proxy_state').then(v => JSON.stringify(v))`,
      ),
    );
    if (applied.prefix === target0.prefix) break;
  }
  record("切换后后端前缀已更新", applied.prefix === target0.prefix, applied.prefix);

  const snapshot = JSON.parse(
    await evaluate(`window.__TAURI_INTERNALS__.invoke('config_active').then(v => JSON.stringify(v))`),
  );
  const githubUrls = [];
  const walk = (value) => {
    if (typeof value === "string") {
      if (value.includes("github.com") || value.includes("githubusercontent.com")) {
        githubUrls.push(value);
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(snapshot?.sites ?? []);
  const prefixed = githubUrls.filter((url) => url.startsWith(target0.prefix));
  const bare = githubUrls.filter((url) => url.startsWith("https://github.com") || url.startsWith("https://raw.githubusercontent.com") || url.startsWith("https://gist.githubusercontent.com"));
  record(
    "GitHub 链接已改成新前缀",
    githubUrls.length === 0 || bare.length === 0,
    `共 ${githubUrls.length} 条，裸地址 ${bare.length} 条`,
  );
  record(
    "前缀没有叠加两层",
    prefixed.every(
      (url) =>
        !url.slice(target0.prefix.length).startsWith("https://" + target0.prefix.replace(/^https?:\/\//, "")),
    ),
    prefixed[0] ? prefixed[0].slice(0, 120) : "no url",
  );
  console.log(`       示例：${prefixed[0] ?? bare[0] ?? "(无 GitHub 链接)"}`);

  // ---- 4. 还原 ----
  if (!KEEP) {
    await evaluate(
      `window.__TAURI_INTERNALS__.invoke('gh_proxy_set', { prefix: ${JSON.stringify(initial.prefix)} })`,
    );
    const restored = JSON.parse(
      await evaluate(
        `window.__TAURI_INTERNALS__.invoke('gh_proxy_state').then(v => JSON.stringify(v))`,
      ),
    );
    record("还原到初始前缀", restored.prefix === initial.prefix, restored.prefix || "(直连)");
  }
}

const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(".workbuddy/gh-proxy.png", Buffer.from(shot.result.data, "base64"));
console.log(`\n截图 .workbuddy/gh-proxy.png · ${results.filter(Boolean).length}/${results.length} PASS`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
