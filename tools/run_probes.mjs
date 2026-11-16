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
 *   - `probe_episode_switch` / `probe_live_audio` 走真实点播与直播（网络依赖）：前者用
 *     `LUMA_KEYWORD`（默认「庆余年」）搜片再点「下一集」逐拍采样信息卡；后者依赖 active
 *     配置的 `lives[]`，没有直播源时记 SKIP 不算失败。`probe_log_channels` 只往
 *     `logs/ui/` 写一条带随机标记的日志，再核对三通道是否各归各位。
 *   - `probe_artplayer` / `probe_player_nav` 也吃真实点播：控制栏的「下一集/刷新」是
 *     ArtPlayer 播放实例就绪后才 push 的（usePlayerEngine.ts:340/370），源解析慢时单帧读会
 *     假红，故改成带超时轮询。player_nav 在控制项超时仍缺失时按视频态分流——在播却没按钮判
 *     真回归（FAIL），根本没出画判环境（SKIP），与 episode_switch 同一口径。
 *   - `probe_search_history` 只改 localStorage 的搜索词历史并在收尾恢复；点历史词会触发一次
 *     后台聚合搜索，探针随即 reload 打断、不等待 20s 结果。
 *   - `probe_session_machine` 是播放会话状态机（2.0.0 解释器化）的「模型 ↔ 现实」比对：
 *     读 dev 窗口里的 `window.__lumaPlayerSession`，钉出画后必须 playing + hasPlayed、
 *     健康播放 12 拍内不得进 probing/recovering 或累计 unknown、真实换集必须进 switching
 *     再收口且 sessionId 自增。没出画 / 单集片源按环境 SKIP，只有机器状态不符才 FAIL。
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
 *   - 出画类探针用本地 stub 播放源（flv 的 sample.flv、playback 的 index.m3u8 等），
 *     必须用 `LUMA_PROXY_ALLOW_LOCAL=1` 启动 dev/Tauri：常驻播放反代默认按 SSRF 口径
 *     拒绝 loopback（proxy/mod.rs:144、guard.rs），否则桩流被 403「target 127.0.0.1 is
 *     not allowed」拦掉、解码断言拿不到帧。flv 探针在这种环境下会自报 SKIP（环境前置），
 *     不会把「代理拦本地源」误判成 mpegts 回归；allowLocal=true 时仍照常硬断言出画。
 */
import { spawnSync } from "node:child_process";

const STUB = "http://127.0.0.1:8787/config.json";
const CDP = "http://127.0.0.1:9222/json/list";

/** 探针清单：key → { script, label, needsStub } */
const PROBES = [
  { key: "rust_commands", script: "tools/probes/probe_rust_commands.mjs", label: "Rust command 连通性（分层后不丢 command）" },
  { key: "search_ui", script: "tools/probes/probe_search_ui.mjs", label: "真实配置 导入→搜索→详情→播放", needsStub: true },
  { key: "home_site", script: "tools/probes/probe_home_site.mjs", label: "首页站点记忆 + 默认站内容/自动顺延" },
  { key: "home_category", script: "tools/probes/probe_home_category.mjs", label: "首页分类原地切换（不进二级页）+ 无限滚动翻页" },
  { key: "home_video", script: "tools/probes/probe_home_video.mjs", label: "homeVideoContent 推荐流兜底（豆瓣出卡片）", needsStub: true },
  { key: "py_framework", script: "tools/probes/probe_py_framework.mjs", label: "py 框架对齐 TVBox（类属性 header 不被 __init__ 覆盖）", needsStub: true },
  { key: "cover", script: "tools/probes/probe_cover.mjs", label: "封面图经 /image 代理出真图（内嵌 header）" },
  { key: "source_cache", script: "tools/probes/probe_source_cache.mjs", label: "换源候选缓存（点换源不重检索）" },
  { key: "source_picker", script: "tools/probes/probe_source_picker.mjs", label: "手动换源面板" },
  { key: "page_cache", script: "tools/probes/probe_page_cache.mjs", label: "页面缓存与滚动恢复" },
  { key: "artplayer", script: "tools/probes/probe_artplayer.mjs", label: "ArtPlayer HLS 出画" },
  { key: "playback_ux", script: "tools/probes/probe_playback_ux.mjs", label: "连看体验（偏好记忆/自动下一集/Esc/复制错误）" },
  { key: "episode_switch", script: "tools/probes/probe_episode_switch.mjs", label: "换集只重挂播放器（信息卡/选集不闪空）" },
  { key: "session_machine", script: "tools/probes/probe_session_machine.mjs", label: "会话状态机 ↔ 现实（出画/换集/不误判死线）" },
  { key: "live_audio", script: "tools/probes/probe_live_audio.mjs", label: "直播播放器独占（切台/离开不残留出声）" },
  { key: "flv", script: "tools/probes/probe_flv.mjs", label: "FLV 经 mpegts.js 出画", needsStub: true },
  { key: "search_failures", script: "tools/probes/probe_search_failures.mjs", label: "搜索失败源明细与重试", needsStub: true },
  { key: "search_history", script: "tools/probes/probe_search_history.mjs", label: "最近搜索词（10 条上限 / 点击重搜 / 删除清空）" },
  { key: "history", script: "tools/probes/probe_history.mjs", label: "历史页（合成记录，不留痕）" },
  { key: "player_fav", script: "tools/probes/probe_player_fav.mjs", label: "播放页收藏按钮（加/减后恢复初始集合）" },
  { key: "player_nav", script: "tools/probes/probe_player_nav.mjs", label: "播放页新布局（器内上/下一集 → 信息卡 → 常驻选集）" },
  { key: "settings_logs", script: "tools/probes/probe_settings_logs.mjs", label: "版本 / 诊断 / 复制诊断" },
  { key: "log_channels", script: "tools/probes/probe_log_channels.mjs", label: "日志三通道（ui 不污染 app）" },
  { key: "settings_health", script: "tools/probes/probe_settings_health.mjs", label: "站点体检（并发测活 / 禁用持久化）", needsStub: true },
  { key: "sidebar", script: "tools/probes/probe_sidebar.mjs", label: "侧边栏收缩 / 展开" },
  // 会把 active 切成桩配置，必须最后；默认不跑。
  { key: "ui", script: "tools/probes/probe_ui.mjs", label: "UI 冒烟（会切桩配置）", needsStub: true, optIn: true },
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

/**
 * 每条探针开跑前把窗口归位到干净的首页。
 *
 * 常驻播放层（PlayerHost / 直播层）是「切页不卸载」的设计：上一条探针停在
 * `#/player` 时，下一条连上来的窗口带着一个活跃的后台会话。实测后果不是「难看」
 * 而是「假结果」——点击落到还没挂载完的页面上（设置页区块 MISSING），而搜索结果、
 * 剧集数这类读取会直接命中上一个会话的残留 DOM（`search_ui` 曾在 0.3 秒读到
 * 「聚合搜索完成」，详情页数出 66 集 = 详情页 33 + 常驻层 33），于是后面每一条
 * 依赖真实配置的探针全在错状态里超时。reload 结束后台会话并回到首页，代价一条命令。
 */
async function resetWindow(cdp) {
  try {
    await cdp.eval(`(() => { location.hash = '#/'; location.reload(); return 'OK'; })()`).catch(() => "RELOADING");
  } catch {
    /* reload 会销毁执行上下文，这里的异常是预期内的 */
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ready = await cdp
      .eval(`!!document.querySelector('.nav__item') && !!document.querySelector('.page')`)
      .catch(() => false);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log("[warn] 窗口归位超时，继续跑（探针可能读到残留状态）");
  return false;
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
  await resetWindow(cdp);
  const env = { ...process.env };
  if (probe.key === "search_ui" || probe.key === "artplayer") {
    // 这两个探针对关键词敏感：用完整片名能稳定命中。
    env.LUMA_KEYWORD = env.LUMA_KEYWORD || "走马上任";
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
