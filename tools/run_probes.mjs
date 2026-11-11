#!/usr/bin/env node
/**
 * 一条命令跑完真实窗口的回归探针。
 *
 * 顺序是刻意的（都是踩过的坑）：
 *   - `probe_search_ui` 会重新导入真实配置，顺带把 active 归位，放最前面；
 *   - `probe_ui` 会把 active 切成桩配置，默认不跑，需要时用 `--with-ui` 放最后；
 *   - `probe_sidebar` 结束时会 reload，放在靠后；
 *   - 每个导入自己配置的探针（flv / search_failures / settings_health / config_manage）都会自清理；
 *   - `probe_home_site` / `probe_home_video` / `probe_py_framework` 只改 localStorage 的首页站偏好，
 *     结束恢复原值、删探针配置、恢复 active，不污染真实配置；
 *   - `probe_home_video` / `probe_py_framework` 依赖桩服务 fixture（strict_home / header_probe），
 *     `probe_py_framework` 另有豆瓣 frodo 外网正向观察项，偶发超时不影响本地断言；
 *   - `probe_cover` 只 reload、不切配置，验证封面经 Rust `/image` 代理出真图（豆瓣图床外网，
 *     偶发不可达时单跑复测；JPEG magic + 安全边界断言聚焦代理逻辑）。
 *
 * 跑之前先记住「原 active 配置 id」和「已有配置 id」，跑完恢复 active 并删掉
 * 本轮新建的配置——否则几轮探针下来 SQLite 里会堆一堆 stub 配置。
 *
 *   node tools/run_probes.mjs                 # 默认全套（不含 --with-ui）
 *   node tools/run_probes.mjs --with-ui       # 连 UI 冒烟一起（会切桩配置）
 *   node tools/run_probes.mjs --only=flv,history
 *   node tools/run_probes.mjs --list
 *
 * 前置：dev 窗口在跑（CDP 9222）、`python tests/stub_server.py` 在跑（8787）。
 */
import { spawnSync } from "node:child_process";

const STUB = "http://127.0.0.1:8787/config.json";
const CDP = "http://127.0.0.1:9222/json/list";

/** 探针清单：key → { script, label, needsStub } */
const PROBES = [
  { key: "rust_commands", script: "tools/probe_rust_commands.mjs", label: "Rust command 连通性（分层后不丢 command）" },
  { key: "search_ui", script: "tools/probe_search_ui.mjs", label: "真实配置 导入→搜索→详情→播放", needsStub: true },
  { key: "home_site", script: "tools/probe_home_site.mjs", label: "首页站点记忆 + 默认站内容/自动顺延" },
  { key: "home_video", script: "tools/probe_home_video.mjs", label: "homeVideoContent 推荐流兜底（豆瓣出卡片）", needsStub: true },
  { key: "py_framework", script: "tools/probe_py_framework.mjs", label: "py 框架对齐 TVBox（类属性 header 不被 __init__ 覆盖）", needsStub: true },
  { key: "cover", script: "tools/probe_cover.mjs", label: "封面图经 /image 代理出真图（内嵌 header）" },
  { key: "source_cache", script: "tools/probe_source_cache.mjs", label: "换源候选缓存（点换源不重检索）" },
  { key: "source_picker", script: "tools/probe_source_picker.mjs", label: "手动换源面板" },
  { key: "page_cache", script: "tools/probe_page_cache.mjs", label: "页面缓存与滚动恢复" },
  { key: "artplayer", script: "tools/probe_artplayer.mjs", label: "ArtPlayer HLS 出画" },
  { key: "playback_ux", script: "tools/probe_playback_ux.mjs", label: "连看体验（偏好记忆/自动下一集/Esc/复制错误）" },
  { key: "flv", script: "tools/probe_flv.mjs", label: "FLV 经 mpegts.js 出画", needsStub: true },
  { key: "search_failures", script: "tools/probe_search_failures.mjs", label: "搜索失败源明细与重试", needsStub: true },
  { key: "history", script: "tools/probe_history.mjs", label: "历史页（合成记录，不留痕）" },
  { key: "settings_logs", script: "tools/probe_settings_logs.mjs", label: "版本 / 诊断 / 复制诊断" },
  { key: "settings_health", script: "tools/probe_settings_health.mjs", label: "站点体检（并发测活 / 禁用持久化）", needsStub: true },
  { key: "sidebar", script: "tools/probe_sidebar.mjs", label: "侧边栏收缩 / 展开" },
  // 会把 active 切成桩配置，必须最后；默认不跑。
  { key: "ui", script: "tools/probe_ui.mjs", label: "UI 冒烟（会切桩配置）", needsStub: true, optIn: true },
];

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name) => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : "";
};

if (has("--list")) {
  for (const probe of PROBES) {
    console.log(`${probe.key.padEnd(16)} ${probe.optIn ? "(需 --with-ui) " : ""}${probe.label}`);
  }
  process.exit(0);
}

const only = valueOf("--only")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const withUi = has("--with-ui");
const selected = PROBES.filter((probe) => {
  if (only.length > 0) return only.includes(probe.key);
  return withUi || !probe.optIn;
});

if (selected.length === 0) {
  console.error(`没有匹配的探针：${only.join(",")}`);
  process.exit(2);
}

// ---- 最小 CDP 客户端：只用来读写 active 配置，不参与断言 --------------------
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

  async eval(expression) {
    await this.ready;
    const id = ++this.id;
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("cdp timeout")), 30000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (reply.error) throw new Error(reply.error.message);
    return reply.result?.result?.value;
  }

  close() {
    this.ws.close();
  }
}

async function connect() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(CDP)).json();
      const page =
        list.find((t) => t.type === "page" && t.url.startsWith("http://localhost:1420")) ??
        list.find((t) => t.type === "page" && t.webSocketDebuggerUrl && !t.url.startsWith("edge://"));
      if (page) return new Cdp(page.webSocketDebuggerUrl);
    } catch {
      /* 窗口还没起来 */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return null;
}

async function readState(cdp) {
  const raw = await cdp.eval(`(async () => {
    try {
      const [list, active] = await Promise.all([
        window.__TAURI_INTERNALS__.invoke('config_list'),
        window.__TAURI_INTERNALS__.invoke('config_active'),
      ]);
      return JSON.stringify({
        ids: list.map((r) => r.id),
        names: list.map((r) => r.name),
        activeId: active ? active.id : '',
        activeName: active ? active.name : '',
      });
    } catch (err) {
      return 'ERR:' + JSON.stringify(err);
    }
  })()`);
  if (typeof raw !== "string" || raw.startsWith("ERR:")) {
    throw new Error(`读取配置失败：${raw}`);
  }
  return JSON.parse(raw);
}

async function restoreConfigs(cdp, before) {
  try {
    const after = await readState(cdp);
    const created = after.ids.filter((id) => !before.ids.includes(id));
    for (const id of created) {
      await cdp.eval(
        `window.__TAURI_INTERNALS__.invoke('config_remove', { id: ${JSON.stringify(id)} }).then(() => 'OK').catch(() => 'ERR')`,
      );
    }
    if (before.activeId) {
      await cdp.eval(
        `window.__TAURI_INTERNALS__.invoke('config_activate', { id: ${JSON.stringify(before.activeId)} }).then(() => 'OK').catch(() => 'ERR')`,
      );
    }
    return { removed: created.length, activeId: before.activeId };
  } catch (err) {
    return { removed: 0, activeId: before.activeId, error: String(err && err.message ? err.message : err) };
  }
}

// ---- 主流程 ----------------------------------------------------------------
const stubOk = await fetch(STUB, { signal: AbortSignal.timeout?.(5000) })
  .then((res) => res.ok)
  .catch(() => false);
if (!stubOk && selected.some((probe) => probe.needsStub)) {
  console.error("桩服务 8787 未就绪：先跑 `python tests/stub_server.py`（FLV / 失败源 / UI 冒烟依赖它）");
  process.exit(2);
}

const cdp = await connect();
if (!cdp) {
  console.error("连不上 dev 窗口（CDP 9222）：先跑 `corepack pnpm tauri dev`");
  process.exit(2);
}

let before = null;
try {
  before = await readState(cdp);
} catch (err) {
  console.error(`[warn] 读取初始配置失败，跑完不做恢复：${err.message}`);
}
console.log(
  `初始 active：${before?.activeName || before?.activeId || "未知"}；配置数：${before?.ids.length ?? "?"}`,
);
console.log(`计划运行 ${selected.length} 个探针\n`);

const results = [];
for (const probe of selected) {
  const startedAt = Date.now();
  console.log(`\n=== ${probe.label}（${probe.script}）===`);
  const env = { ...process.env };
  if (probe.key === "search_ui" || probe.key === "artplayer") {
    // 这两个探针对关键词敏感：用完整片名能稳定命中。
    env.LUMA_KEYWORD = env.LUMA_KEYWORD || "庆余年 第二季";
  }
  const run = spawnSync(process.execPath, [probe.script], {
    stdio: "inherit",
    env,
    shell: false,
  });
  const ok = run.status === 0;
  results.push({ key: probe.key, label: probe.label, ok, ms: Date.now() - startedAt });
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${probe.key}（${((Date.now() - startedAt) / 1000).toFixed(0)}s）`);
}

// 收尾：恢复 active、删掉本轮新建的配置（探针自己的 stub 配置不留垃圾）。
let cleanup = null;
if (before) {
  cleanup = await restoreConfigs(cdp, before);
  console.log(
    `\n恢复：active → ${cleanup.activeId}；清理新建配置 ${cleanup.removed} 个${cleanup.error ? `（${cleanup.error}）` : ""}`,
  );
}
cdp.close();

const failed = results.filter((item) => !item.ok);
console.log("\n=== 汇总 ===");
for (const item of results) {
  console.log(`${item.ok ? "ok  " : "FAIL"}  ${item.key.padEnd(16)} ${(item.ms / 1000).toFixed(0)}s  ${item.label}`);
}
console.log(failed.length === 0 ? "\n全部通过" : `\n${failed.length} 个探针失败`);
process.exit(failed.length === 0 ? 0 : 1);
