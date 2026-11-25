#!/usr/bin/env node
/**
 * 性能链路分析器：把一次用户操作拆成「前端任务 / IPC / 业务 trace」三段看。
 *
 * 为什么需要它：此前性能观测是点状的——`switchTrace` 只覆盖解析/切台，
 * `diag_resolve_timing.mjs` 只计时单个 command，CDP 手动看 Performance 面板
 * 又和日志对不上。本工具在真实窗口里同时采集三层，合成一条时间线：
 *
 *   1. CDP Performance.getMetrics 增量（TaskDuration / ScriptDuration /
 *      LayoutDuration / RecalcStyleDuration / JSHeapUsedSize）
 *   2. PerformanceObserver 的 longtask（>50ms 主线程阻塞，带归因容器）
 *   3. 前端 IPC 环形缓冲（src/lib/perfTrace.ts，dev 下由 invoke.ts 写入）
 *   4. 业务 trace（日志里的 `ui: trace` 行，从 ui 日志按时间窗过滤）
 *
 * 用法（dev 窗口必须已就绪，CDP :9222）：
 *   node tools/perf/analyse.mjs --scenario home
 *   node tools/perf/analyse.mjs --scenario play --site 创享 --vod 92593 --line 量子
 *   node tools/perf/analyse.mjs --scenario custom --expr "location.hash='#/search?q=信号'" --wait 5000
 *   node tools/perf/analyse.mjs --scenario idle --wait 3000   # 只测空闲基线
 *
 * 输出：tools/.out/perf/<scenario>-<timestamp>.json（结构化，可 diff）
 *       stdout 可读摘要（瓶颈 top-N）。不写日志、不改应用状态（除导航到目标页）。
 */
import { connect } from "../probes/lib/cdp.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "tools/.out/perf";

function parseArgs(argv) {
  const args = {
    scenario: "idle",
    wait: 4000,
    untilIdle: false,
    maxWait: 60000,
    site: "",
    vod: "",
    line: "",
    expr: "",
    out: "",
    port: process.env.CDP_PORT || "9222",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--scenario") args.scenario = argv[++i];
    else if (a === "--wait") args.wait = Number(argv[++i]);
    else if (a === "--until-idle") args.untilIdle = true;
    else if (a === "--max-wait") args.maxWait = Number(argv[++i]);
    else if (a === "--site") args.site = argv[++i];
    else if (a === "--vod") args.vod = argv[++i];
    else if (a === "--line") args.line = argv[++i];
    else if (a === "--expr") args.expr = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--port") args.port = argv[++i];
    else if (a === "--help") {
      console.log("usage: node tools/perf/analyse.mjs [--scenario idle|home|search|detail|play|custom] [--wait ms] [--until-idle] [--max-wait ms] [--site key] [--vod id] [--line name] [--expr js] [--out file]");
      process.exit(0);
    }
  }
  return args;
}

/** 场景导航表达式：直接返回一段在页面里执行的 JS。 */
function scenarioExpr(args) {
  switch (args.scenario) {
    case "idle":
      return null;
    case "home":
      return "location.hash = '#/'";
    case "search":
      return `location.hash = '#/search?q=${encodeURIComponent(args.site || "信号")}'`;
    case "detail":
      if (!args.site || !args.vod) throw new Error("detail 场景需要 --site 与 --vod");
      return `location.hash = '#/detail/${encodeURIComponent(args.site)}/${encodeURIComponent(args.vod)}'`;
    case "play":
      if (!args.site || !args.vod) throw new Error("play 场景需要 --site 与 --vod");
      // 播放走 handoff 才能拿到 playUrl；用页面内的 invoke 取详情首集后导航。
      return `(async () => {
        const inv = window.__TAURI_INTERNALS__.invoke;
        const { navNavigate } = await import('/src/lib/nav.ts');
        const detail = await inv('spider_invoke', { request: { siteKey: ${JSON.stringify(args.site)}, method: 'detailContent', args: [${JSON.stringify(args.vod)}] } });
        const vod = detail?.[0];
        if (!vod) throw new Error('detail empty');
        const froms = String(vod.vod_play_from || '').split('$$$');
        const urls = String(vod.vod_play_url || '').split('$$$');
        let i = 0;
        if (${JSON.stringify(args.line)}) {
          const k = froms.findIndex(f => f.includes(${JSON.stringify(args.line)}));
          if (k >= 0) i = k;
        }
        const seg = String(urls[i] || '').split('#')[0];
        const playUrl = seg.slice(seg.indexOf('$') + 1);
        const from = froms[i];
        const name = String(seg.split('$')[0] || '第01集');
        // 走真实导航桥，不能自己 pushState：React Router 不感知裸 pushState，
        // 会出现 URL 变了但 PlayerPageRoute 没收到 state 的假场景。
        navNavigate({ name: 'player', siteKey: ${JSON.stringify(args.site)}, vodId: ${JSON.stringify(args.vod)}, vodName: vod.vod_name || '', playUrl, episodeName: name, playFrom: from });
        return { from, name };
      })()`;
    case "custom":
      if (!args.expr) throw new Error("custom 场景需要 --expr");
      return args.expr;
    default:
      throw new Error(`未知场景: ${args.scenario}`);
  }
}

const METRIC_KEYS = [
  "TaskDuration",
  "ScriptDuration",
  "LayoutDuration",
  "RecalcStyleDuration",
  "LayoutCount",
  "RecalcStyleCount",
  "JSHeapUsedSize",
  "Nodes",
  "Documents",
  "Frames",
];

function metricMap(result) {
  return Object.fromEntries((result?.metrics || []).map((m) => [m.name, m.value]));
}

function delta(before, after) {
  const out = {};
  for (const key of METRIC_KEYS) {
    const b = before[key];
    const a = after[key];
    if (typeof b === "number" && typeof a === "number") {
      out[key] = key === "JSHeapUsedSize" || key === "Nodes" || key === "Documents" || key === "Frames"
        ? a - b
        : Math.round((a - b) * 1000) / 1000;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expr = scenarioExpr(args);
  const cdp = await connect({ port: args.port });

  try {
    await cdp.send("Performance.enable");

    // 安装 longtask / LCP 观察者：结果挂在 window.__perfProbe，采样结束一次性取走。
    await cdp.eval(`(() => {
      if (window.__perfProbeInstalled) return;
      window.__perfProbeInstalled = true;
      window.__perfProbe = { longtasks: [], paints: [] };
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            window.__perfProbe.longtasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration), container: e.attribution?.[0]?.containerName || '' });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
      for (const type of ['largest-contentful-paint', 'first-contentful-paint']) {
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) window.__perfProbe.paints.push({ type, start: Math.round(e.startTime), size: e.size || 0 });
          }).observe({ type, buffered: true });
        } catch {}
      }
    })()`);

    // 无论哪个场景都清空 IPC 缓冲 + 观察者历史，保证只统计本次采样窗口。
    const sampleStart = await cdp.eval(`(async () => {
      const m = await import('/src/lib/perfTrace.ts');
      m.drainIpcSamples();
      m.drainSiteTimings();
      const probe = window.__perfProbe || { longtasks: [], paints: [] };
      window.__perfProbe = { longtasks: [], paints: [] };
      return Math.round(performance.now());
    })()`);

    const before = metricMap(await cdp.send("Performance.getMetrics"));
    const t0 = Date.now();
    if (expr) {
      await cdp.eval(expr);
    }

    // 采集 IPC：固定 wait 或「连续 wait 毫秒无新 IPC」两种收尾策略。
    // 冷搜索扇出要 30s+，固定 4s 会只看到开头几个 command，误判成「没有请求」。
    const ipcAll = [];
    const siteAll = [];
    let lastActivity = Date.now();
    const tick = 500;
    const deadline = t0 + args.maxWait;
    while (Date.now() < deadline) {
      await cdp.sleep(tick);
      const fresh = await cdp.eval(`(async () => (await import('/src/lib/perfTrace.ts')).drainIpcSamples())()`);
      if (Array.isArray(fresh) && fresh.length) {
        ipcAll.push(...fresh);
        lastActivity = Date.now();
      }
      // 站点耗时与 IPC 同窗口采集：聚合搜索的分解只在 search 场景有值。
      const freshSites = await cdp.eval(`(async () => (await import('/src/lib/perfTrace.ts')).drainSiteTimings())()`);
      if (Array.isArray(freshSites) && freshSites.length) {
        siteAll.push(...freshSites);
        lastActivity = Date.now();
      }
      if (!args.untilIdle) {
        if (Date.now() - t0 >= args.wait) break;
      } else if (Date.now() - lastActivity >= args.wait) {
        // 已经静默了 wait 毫秒。但一个 IPC 都没有时不能算「链路结束」——
        // 页面初始化 / 防抖期间本来就没有请求，需给一段启动宽限期。
        if (ipcAll.length === 0 && Date.now() - t0 < args.wait * 2) continue;
        break;
      }
    }
    const wallMs = Date.now() - t0;
    const after = metricMap(await cdp.send("Performance.getMetrics"));

    const browser = await cdp.eval(`(async () => {
      const probe = window.__perfProbe || { longtasks: [], paints: [] };
      window.__perfProbe = { longtasks: [], paints: [] };
      const since = ${sampleStart};
      return {
        longtasks: probe.longtasks.filter(t => t.start >= since),
        paints: probe.paints.filter(p => p.start >= since),
        now: Math.round(performance.now()),
      };
    })()`);

    // 业务 trace：从 ui 日志过滤本次采样窗口内的行。
    const traces = await readUiTraces(t0 - 2000, Date.now() + 1000);

    const report = {
      scenario: args.scenario,
      at: new Date(t0).toISOString(),
      wallMs,
      waitMs: args.wait,
      metrics: delta(before, after),
      ipc: ipcAll,
      sites: siteAll,
      longtasks: browser.longtasks,
      paints: browser.paints,
      traces,
    };

    await mkdir(OUT_DIR, { recursive: true });
    const file = args.out || join(OUT_DIR, `${args.scenario}-${t0}.json`);
    await writeFile(file, JSON.stringify(report, null, 2), "utf8");

    printSummary(report, file);
  } finally {
    cdp.close();
  }
}

/** 只读 ui 日志：按 ISO 时间戳过滤窗口内的 trace 行，不触碰其它通道。 */
async function readUiTraces(fromMs, toMs) {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  // dev 通道 identifier=app.luma.dev，日志按天切分。
  const day = new Date(fromMs).toISOString().slice(0, 10);
  const logs = [
    join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "app.luma.dev", "logs", "ui", `ui.${day}.log`),
  ];
  const out = [];
  for (const logPath of logs) {
    let text;
    try {
      text = await readFile(logPath, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(" ui: ") || !line.includes("\"stage\"")) continue;
      // 日志时间戳形如 2026-11-24T21:39:32.647469+08:00
      const m = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+)([+-]\d\d:\d\d)?/);
      if (!m) continue;
      const ts = Date.parse(`${m[1]}${m[2] || "Z"}`);
      if (ts < fromMs || ts > toMs) continue;
      try {
        const stage = JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1));
        out.push({ at: ts, stage });
      } catch {
        // 日志行被截断（长 context 会带 [truncated]）：跳过，不影响其它行。
      }
    }
  }
  return out;
}

function printSummary(r, file) {
  const line = (s) => console.log(s);
  line(`\n=== perf: ${r.scenario} ===`);
  line(`wall=${r.wallMs}ms  task=${r.metrics.TaskDuration ?? "-"}ms  script=${r.metrics.ScriptDuration ?? "-"}ms  layout=${r.metrics.LayoutDuration ?? "-"}ms`);
  line(`heapDelta=${r.metrics.JSHeapUsedSize ?? 0}B  nodesDelta=${r.metrics.Nodes ?? 0}`);
  const slow = [...r.ipc].sort((a, b) => b.ms - a.ms).slice(0, 8);
  line(`ipc calls=${r.ipc.length}  slowest: ${slow.map((s) => `${s.cmd}=${s.ms}ms`).join(", ") || "-"}`);
  printSiteBreakdown(r.sites || []);
  const long = [...r.longtasks].sort((a, b) => b.duration - a.duration).slice(0, 5);
  line(`longtasks=${r.longtasks.length}  top: ${long.map((t) => `${t.duration}ms@${t.start}`).join(", ") || "-"}`);
  if (r.paints.length) line(`paints: ${r.paints.map((p) => `${p.type}=${p.start}ms`).join(", ")}`);
  if (r.traces.length) {
    const last = r.traces[r.traces.length - 1];
    line(`ui traces=${r.traces.length}  last=${last.stage.kind || ""}#${last.stage.id || ""} ${last.stage.stage || ""}@${last.stage.ms}ms`);
  }
  line(`report: ${file}`);
}

/**
 * per-site 耗时分解：把长尾归因到「排队」还是「源站」。
 *
 * 只看总时长会把两种完全不同的原因混成一件事——第 4 波才拿到并发许可的
 * 健康源，总耗时和跑满超时的死站一样难看。所以这里按 queueMs / runMs
 * 谁占大头分流：queue 主导 = 我的并发度问题，run 主导 = 源站问题。
 */
function printSiteBreakdown(sites) {
  if (!sites.length) return;
  const line = (s) => console.log(s);
  const pct = (arr, p) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  };
  const byStatus = sites.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  const queueBound = sites.filter((s) => s.queueMs > s.runMs).length;
  const runMs = sites.map((s) => s.runMs);
  line(
    `sites=${sites.length}  status=${Object.entries(byStatus)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")}`,
  );
  line(
    `runMs p50=${pct(runMs, 0.5)} p90=${pct(runMs, 0.9)} max=${Math.max(...runMs)}  queue>run=${queueBound}/${sites.length}（排队超过执行段）`,
  );
  const top = [...sites].sort((a, b) => b.doneMs - a.doneMs).slice(0, 8);
  line("slowest sites (done = queue + run):");
  for (const s of top) {
    line(
      `  ${s.siteKey.padEnd(12)} done=${String(s.doneMs).padStart(6)}ms  queue=${String(s.queueMs).padStart(6)}  run=${String(s.runMs).padStart(6)}  ${s.status.padEnd(7)} ${verdictOf(s)}`,
    );
  }
}

/**
 * 归因规则：只看「谁占大头」不够——排队 17s + 自己跑 14s 的站，两件事都成立，
 * 硬归到排队会漏掉一个该屏蔽的慢源。所以先按超时判死，再看执行段是否本身就慢。
 */
function verdictOf(s) {
  if (s.status === "timeout") return "源站超时→屏蔽候选";
  // 1.5s 是「健康源」的经验上界：p50 之外还快过一个数量级的执行段，
  // 总时长再长也怪不到它头上。
  const fastRun = s.runMs < 1500;
  if (s.queueMs > s.runMs) {
    return fastRun ? "排队主导→并发度" : "双高→慢源+排队";
  }
  return "执行主导→源站慢";
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
