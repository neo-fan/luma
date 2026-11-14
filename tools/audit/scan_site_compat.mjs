#!/usr/bin/env node
/**
 * 全站兼容性扫描：对真实配置的每个站点逐站验证 详情 / 封面 / 播放 / 下一集。
 *
 * 与 site_health 的区别：site_health 只发一次 homeContent，不代表详情/播放可用。
 * 本工具走真实前端链路：
 *   homeContent 聚合取种子 → detailContent → /image 封面 → playerContent
 *   → (parse/jx) parse_resolve → resolve_play → 本地反代探活 → 第二集重跑一遍。
 *
 * 口径（必须在报告里说清，别把探活当出画）：
 *   - 「播放可用」= 解析出媒体地址且本地反代返回真播放列表/媒体字节；
 *     真实解码出画由 UI 探针另行抽样验证（videoWidth/Height > 0）。
 *   - kind=page 表示需要网页嗅探/解析，记为「待嗅探」而非硬失败。
 *   - 单片只有 1 集、无 vod_pic 记为 n/a，不计入失败。
 *
 * 用法：
 *   node tools/audit/scan_site_compat.mjs                         # 全部启用站
 *   LUMA_LIMIT=6 node tools/audit/scan_site_compat.mjs           # 试跑前 6 站
 *   LUMA_CONCURRENCY=4 LUMA_KEYWORD=走马上任 node tools/audit/scan_site_compat.mjs
 *
 * 前置：dev 窗口带 CDP 9222、LUMA_PROXY_ALLOW_LOCAL=1、NO_PROXY 含 127.0.0.1。
 * 输出：.workbuddy/site-compat-raw.json（不入库）+ docs/site-compat-report.md
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// tools/audit/ -> repo root is two levels up.
const ROOT = resolve(import.meta.dirname ?? new URL("..", import.meta.url).pathname, "..", "..");
const KEYWORD = process.env.LUMA_KEYWORD || "走马上任";
const CONCURRENCY = Math.max(1, Number(process.env.LUMA_CONCURRENCY || 4));
const LIMIT = Number(process.env.LUMA_LIMIT || 0);
const CFG = {
  keyword: KEYWORD,
  seedMs: 30_000,
  perCallMs: 12_000,
  // 与前端一致：parses[] 整池 15s、level-4 嗅探 15s，各留 2s 余量，
  // 否则网页播放页会被扫描预算误判成失败。
  parseMs: 17_000,
  resolveMs: 17_000,
  nextResolveMs: 12_000,
  fetchMs: 7_000,
};

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, reject) => {
      this.ws.addEventListener("open", resolveReady, { once: true });
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

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    const reply = await new Promise((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 180_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveReply(msg);
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
      throw new Error(`eval failed: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description ?? ""}`);
    }
    return res.result?.value;
  }

  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForPage(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      const page = list.find(
        (t) => t.type === "page" && t.webSocketDebuggerUrl && t.url.startsWith("http://localhost:1420"),
      );
      if (page) return page;
    } catch {
      /* window not up yet */
    }
    await sleep(800);
  }
  throw new Error("CDP page target not found");
}

const PREFIX = (cfg) => `const CFG = ${JSON.stringify(cfg)};`;

/** 一次聚合拿全站首页种子，省掉 67 次单独 homeContent。 */
const seedExpression = (cfg) => `(async () => {
  ${PREFIX(cfg)}
  const inv = window.__TAURI_INTERNALS__.invoke;
  const race = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('seed timeout')), ms))]);
  try {
    const agg = await race(inv('spider_invoke', {
      request: { siteKey: 'all', method: 'homeContent', args: [], timeoutMs: CFG.seedMs }
    }), CFG.seedMs + 3000);
    const seeds = {}, classes = {}, responded = [];
    for (const row of (agg.results || [])) {
      responded.push(row.siteKey);
      const data = row.ok && row.data ? row.data : {};
      const list = Array.isArray(data.list) ? data.list : [];
      const first = list.find(v => v && String(v.vod_id ?? '') !== '');
      seeds[row.siteKey] = first ? String(first.vod_id) : '';
      // TVBox 大量站点首页只给 classes，真正的片单在 categoryContent。
      const cls = Array.isArray(data.classes) ? data.classes : [];
      const t = cls.find(c => c && String(c.type_id ?? '') !== '');
      classes[row.siteKey] = t ? String(t.type_id) : '';
    }
    return JSON.stringify({ ok: true, total: agg.total, okCount: agg.ok, failed: agg.failed,
                            skipped: agg.skipped ?? 0, seeds, classes, responded });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e && e.message || e), seeds: {} });
  }
})()`;

/** 单站四能力链路。返回 JSON 字符串，任何一步失败都记原因而不中断整轮。 */
const scanExpression = (site, seedMeta, cfg) => `(async () => {
  ${PREFIX(cfg)}
  const S = ${JSON.stringify(site)};
  const M = ${JSON.stringify(seedMeta)};
  let SEED = M.id || '';
  let TID = M.tid || '';
  const inv = window.__TAURI_INTERNALS__.invoke;
  const race = (p, ms, tag) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' timeout')), ms))
  ]);
  const call = (cmd, args, ms, tag) => race(inv(cmd, args), ms, tag || cmd);
  const spider = (method, args, ms) => call('spider_invoke', {
    request: { siteKey: S.key, method, args, timeoutMs: ms || CFG.perCallMs }
  }, (ms || CFG.perCallMs) + 1800, method);
  const listOf = (v) => Array.isArray(v) ? v
    : (v && Array.isArray(v.list) ? v.list : (v && Array.isArray(v.data) ? v.data : []));
  const et = (e) => String(e && (e.message || e) || e).slice(0, 160);
  const out = { key: S.key, name: S.name, runtime: S.runtime || '', seed: '',
                detail: {}, cover: {}, play: {}, next: {}, notes: [], seedTrace: [] };

  // --- 种子：聚合首页 → 单站首页 → 推荐流 → 分类 → 搜索 ---
  const tryMethod = async (m, args) => {
    try {
      const v = await spider(m, args);
      const items = listOf(v);
      const cls = Array.isArray(v?.classes) ? v.classes : [];
      out.seedTrace.push(m + ':list=' + items.length + ',cls=' + cls.length);
      const first = items.find(x => x && String(x.vod_id ?? '') !== '');
      return { v, first };
    } catch (e) {
      out.notes.push(m + ': ' + et(e));
      out.seedTrace.push(m + ':err=' + et(e).slice(0, 40));
      return null;
    }
  };
  const take = (hit, label) => {
    if (!hit || !hit.first) return false;
    SEED = String(hit.first.vod_id);
    out.seed = label;
    return true;
  };
  if (SEED) out.seed = 'homeContent(聚合)';
  else {
    // 聚合预算内没响应的站，单独补一次 homeContent（同时取 classes）。
    if (!M.responded) {
      const h = await tryMethod('homeContent', []);
      if (h) {
        const cls = Array.isArray(h.v?.classes) ? h.v.classes : [];
        const t = cls.find(c => c && String(c.type_id ?? '') !== '');
        if (t) TID = String(t.type_id);
        take(h, 'homeContent(单站)');
      }
    }
    if (!SEED) take(await tryMethod('homeVideoContent', []), 'homeVideoContent');
    if (!SEED && TID) take(await tryMethod('categoryContent', [TID, 1]), 'categoryContent');
    if (!SEED) take(await tryMethod('searchContent', [CFG.keyword, false, 1]), 'searchContent');
  }
  if (!SEED) {
    out.overall = 'no_seed';
    out.notes.push('首页/分类/推荐/搜索均无可用条目');
    return JSON.stringify(out);
  }

  // --- 详情 + 剧集 ---
  let v = null, eps = [], froms = [];
  try {
    const items = listOf(await spider('detailContent', [SEED]));
    if (!items.length) out.detail = { ok: false, reason: 'empty(发现/推荐型源无播放列表)' };
    else {
      v = items[0] || {};
      froms = String(v.vod_play_from || '').split('$$$');
      const lines = String(v.vod_play_url || '').split('$$$');
      eps = (lines[0] || '').split('#').filter(Boolean).map((chunk, i) => {
        const cut = chunk.indexOf('$');
        return cut >= 0
          ? { name: chunk.slice(0, cut).trim(), url: chunk.slice(cut + 1).trim() }
          : { name: '第' + (i + 1) + '集', url: chunk.trim() };
      }).filter(e => e.url);
      out.detail = { ok: true, title: String(v.vod_name || '').slice(0, 60),
                     items: items.length, lines: froms.length, episodes: eps.length };
    }
  } catch (e) { out.detail = { ok: false, reason: et(e) }; }
  if (!out.detail.ok || !eps.length) {
    out.overall = out.detail.ok ? 'no_episodes'
      : (String(out.detail.reason).startsWith('empty') ? 'capability_gap' : 'detail_failed');
    return JSON.stringify(out);
  }

  // --- 封面：/image 代理必须返回 2xx + image/* ---
  const pic = String(v.vod_pic || '');
  if (!pic) out.cover = { status: 'n/a', reason: '无 vod_pic' };
  else {
    try {
      const ps = await call('proxy_status', {}, 3000, 'proxy_status');
      const r = await fetch(ps.baseUrl + '/image?url=' + encodeURIComponent(pic),
                            { signal: AbortSignal.timeout(CFG.fetchMs) });
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!r.ok) out.cover = { status: 'fail', code: r.status, type: ct, reason: '代理返回非 2xx' };
      else if (!ct.startsWith('image/')) out.cover = { status: 'fail', code: r.status, type: ct, reason: '非图片响应' };
      else {
        const b = new Uint8Array(await r.arrayBuffer());
        out.cover = { status: 'ok', type: ct, bytes: b.length };
      }
    } catch (e) { out.cover = { status: 'fail', reason: et(e) }; }
  }

  // --- 播放地址解析 + 本地反代探活（首集与第二集复用） ---
  const flag = froms[0] || '';
  const parseEpisode = async (ep, isNext) => {
    const r = {};
    let target = ep.url, header = {};
    try {
      const played = await spider('playerContent', [flag, ep.url, []], CFG.perCallMs);
      if (played && typeof played === 'object') {
        header = played.header || {};
        const candidate = String(played.playUrl || played.url || '');
        const lower = candidate.toLowerCase();
        const valid = lower.startsWith('http://') || lower.startsWith('https://');
        // 与 usePlayResolution.ts 一致：只采用 http(s) 返回值。脚本给的
        // 相对路径 / ?type=m3u8&url=... 这类返回值前端会忽略并沿用原剧集地址。
        if (valid) target = candidate;
        r.played = true;
        r.playerCandidate = valid ? 'http' : 'ignored(非 http)';
        // 第二集跳过解析池：同池规则重复跑一次要 15s，收益极低；只验证地址解析与可达性。
        if (valid && !isNext && (Number(played.parse ?? 0) !== 0 || Number(played.jx ?? 0) !== 0)) {
          try {
            const hit = await call('parse_resolve', {
              request: { siteKey: S.key, url: target, flag, headers: header }
            }, CFG.parseMs, 'parse_resolve');
            if (hit && hit.url) { target = hit.url; r.parser = String(hit.parser || '').slice(0, 40); }
          } catch (e) { r.parseError = et(e); }
        }
      } else r.played = false;
    } catch (e) { r.played = false; r.playerError = et(e); }
    const pick = (k) => {
      for (const [kk, vv] of Object.entries(header)) if (kk.toLowerCase() === k) return String(vv);
      return undefined;
    };
    r.target = String(target).slice(0, 90);
    let resolved;
    try {
      resolved = await call('resolve_play', {
        request: { siteKey: S.key, url: target,
                   ua: pick('user-agent'), referer: pick('referer'), cookie: pick('cookie') }
      }, isNext ? CFG.nextResolveMs : CFG.resolveMs, 'resolve_play');
      r.kind = resolved.kind;
    } catch (e) { r.ok = false; r.reason = 'resolve_play: ' + et(e); return r; }
    if (resolved.kind === 'page') { r.ok = null; r.reason = '需网页嗅探/解析（page）'; return r; }
    try {
      const f = await fetch(resolved.proxyUrl, {
        headers: resolved.kind === 'hls' ? undefined : { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(CFG.fetchMs),
      });
      const ct = (f.headers.get('content-type') || '').toLowerCase();
      if (resolved.kind === 'hls') {
        const text = await f.text();
        r.ok = f.ok && (text.includes('#EXTM3U') || ct.includes('mpegurl') || ct.includes('m3u8'));
        r.code = f.status; r.type = ct; r.bytes = text.length;
        if (!r.ok) r.reason = 'm3u8 探活未返回播放列表';
      } else {
        const b = new Uint8Array(await f.arrayBuffer());
        r.ok = (f.ok || f.status === 206) && b.length > 0 && !ct.includes('text/html');
        r.code = f.status; r.type = ct; r.bytes = b.length;
        if (!r.ok) r.reason = '媒体流探活失败';
      }
    } catch (e) { r.ok = false; r.reason = 'fetch: ' + et(e); }
    return r;
  };

  out.play = await parseEpisode(eps[0], false);
  out.next = eps.length > 1
    ? await parseEpisode(eps[1], true)
    : { ok: null, reason: '单片/仅 1 集，不适用' };

  const checks = [out.detail.ok, out.cover.status !== 'fail',
                  out.play.ok !== false, out.next.ok !== false];
  const bad = checks.filter(x => x === false).length;
  out.overall = bad > 0 ? 'fail'
    : (out.play.ok === true && out.next.ok !== false ? 'ok' : 'partial');
  return JSON.stringify(out);
})()`;

const mark = (cell) => {
  if (cell === undefined || cell === null) return "—";
  return cell === true ? "✓" : cell === false ? "✗" : cell === null ? "?" : String(cell);
};
const short = (s, n = 60) => String(s || "").replace(/\|/g, "\\|").slice(0, n);
const statusText = (part) => {
  if (!part || Object.keys(part).length === 0) return "未测";
  if (part.status) {
    if (part.status === "ok") return `✓ ${part.bytes}B`;
    if (part.status === "n/a") return "n/a";
    return `✗ ${short(part.reason || part.type || "", 46)}`;
  }
  if (part.ok === true) return `✓ ${part.kind || ""}${part.code ? ` ${part.code}` : ""}`;
  if (part.ok === false) return `✗ ${short(part.reason || "", 46)}`;
  if (part.ok === null) return `? ${short(part.reason || "", 40)}`;
  return short(part.reason || "", 46);
};

function buildReport({ sites, rows, seed, startedAt, durationMs, keyword }) {
  const enabled = sites.filter((s) => s.enabled !== false && !s.disabledReason);
  const blocked = sites.filter((s) => s.enabled === false || s.disabledReason);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const count = (fn) => rows.filter(fn).length;
  const blockedReasons = {};
  for (const s of blocked) {
    const reason = s.disabledReason || "手动禁用";
    // 新策略下导入不再因 quickjs/drpy2 屏蔽源；命中该分支通常是旧缓存里的
    // 历史 disabledReason，故标注为历史口径，报告结构保持不变。
    const k = /jar|jvm|dex/i.test(reason) ? "jar/jvm(dex)" : /js|quickjs|drpy/i.test(reason) ? "js 源(历史口径)" : reason.slice(0, 40);
    blockedReasons[k] = (blockedReasons[k] || 0) + 1;
  }
  const runtimeStats = {};
  for (const s of enabled) {
    const k = s.runtime || "none";
    runtimeStats[k] ??= { total: 0, ok: 0, fail: 0, partial: 0 };
    runtimeStats[k].total += 1;
    const overall = byKey.get(s.key)?.overall || "untested";
    if (overall === "ok") runtimeStats[k].ok += 1;
    else if (overall === "fail" || overall === "detail_failed" || overall === "no_seed") runtimeStats[k].fail += 1;
    else runtimeStats[k].partial += 1;
  }
  const noSeedRows = rows.filter((r) => r.overall === "no_seed");
  const seedReasons = {};
  for (const r of noSeedRows) {
    const text = [...(r.seedTrace || []), ...(r.notes || [])].join(" ").toLowerCase();
    let key;
    if (/exceeded|timeout|timed out/.test(text)) key = "脚本/扫描超时";
    else if (/connectionpool|ssl|fetch |signal timed out|127\.0\.0\.1/.test(text)) key = "源站不可达 / SSL 失败 / 依赖本地服务";
    else if (/mismatched tag|not well-formed|cannot access local/.test(text)) key = "源返回畸形 XML / 脚本自身异常";
    else if (/list=0/.test(text)) key = "首页/分类/搜索均返回空列表";
    else key = "其它";
    seedReasons[key] = (seedReasons[key] || 0) + 1;
  }
  const reasons = {};
  for (const r of rows) {
    for (const [part, name] of [["detail", "详情"], ["cover", "封面"], ["play", "播放"], ["next", "下一集"]]) {
      const cell = r[part] || {};
      const failed = cell.ok === false || cell.status === "fail";
      if (!failed) continue;
      const reason = cell.reason || cell.type || "未知";
      const key = `${name}｜${/timeout/i.test(reason) ? "超时" : /empty|无可用/i.test(reason) ? "空结果" : /resolve_play/i.test(reason) ? "地址解析" : /探活|fetch|非 2xx|非图片/i.test(reason) ? "反代/探活" : "其它"}`;
      reasons[key] = (reasons[key] || 0) + 1;
    }
  }

  const lines = [];
  lines.push("# 站点兼容性实测报告（真实配置 box）");
  lines.push("");
  lines.push(`- 时间：${startedAt}`);
  lines.push(`- 关键词：\`${keyword}\`；并发：${CONCURRENCY}；单步超时：详情/播放 ${CFG.perCallMs / 1000}s、解析池 ${CFG.parseMs / 1000}s、resolve ${CFG.resolveMs / 1000}s、探活 ${CFG.fetchMs / 1000}s（与前端 15s 解析/嗅探预算对齐）`);
  lines.push(`- 首页聚合种子：${seed.ok ? `${seed.okCount}/${seed.total} 站响应` : `失败（${seed.error}）`}；总耗时 ${(durationMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("## 口径说明");
  lines.push("");
  lines.push("- **播放可用 = 地址可解析 + 本地反代返回真 m3u8/媒体字节**，不等于真实解码出画；真实出画由 UI 探针抽样（`videoWidth/Height > 0`）。");
  lines.push("- `kind=page` 记「? 需网页嗅探」不计硬失败：真实前端会自动嗅探/换源，但嗅探有 15s 预算，扫描不等它。");
  lines.push("- 单片只有 1 集、无 `vod_pic` 记 n/a 不计失败；被导入侧屏蔽的 jar/JS 源单列，不参与通过率。");
  lines.push("- `detailContent` 返回空列表的发现/推荐型源（如豆瓣）记为 `capability_gap`，是源的能力缺口而非客户端 bug；前端已有按片名回查兜底。");
  lines.push("- 站点名含「直播」的源有独立 `live_parse` 链路，按 VOD 口径失败记为 `live_n/a`，不算兼容缺陷。");
  lines.push("- 外网源有时效/防盗链，单次探活失败可能是瞬时状态；结论按「问题类型」看，不按单次成败给站点判死刑。");
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("|---|---|");
  lines.push(`| 配置站点总数 | ${sites.length} |`);
  lines.push(`| 可运行站点（实测） | ${enabled.length} |`);
  lines.push(`| 导入侧屏蔽 | ${blocked.length}（${Object.entries(blockedReasons).map(([k, v]) => `${k} ${v}`).join("、")}） |`);
  lines.push(`| 实测站点 | ${rows.length} |`);
  lines.push(`| 全部四项通过（ok） | ${count((r) => r.overall === "ok")} |`);
  lines.push(`| 部分可用（partial：page/单片/n-a） | ${count((r) => r.overall === "partial")} |`);
  lines.push(`| 有硬失败（fail/detail_failed/no_episodes） | ${count((r) => ["fail", "detail_failed", "no_episodes"].includes(r.overall))} |`);
  lines.push(`| 无可用条目 no_seed（含源不可达/超时） | ${noSeedRows.length} |`);
  lines.push(`| 能力缺口（空详情） | ${count((r) => r.overall === "capability_gap")} |`);
  lines.push(`| 直播型源（VOD 口径不适用） | ${count((r) => r.overall === "live_n/a")} |`);
  lines.push(`| 详情可用 | ${count((r) => r.detail?.ok === true)} / ${rows.length} |`);
  lines.push(`| 封面可用（含 n/a） | ${count((r) => r.cover?.status !== "fail")} / ${rows.length} |`);
  lines.push(`| 首集地址可达 | ${count((r) => r.play?.ok === true)} / ${rows.length} |`);
  lines.push(`| 下一集可达或 n/a | ${count((r) => r.next?.ok !== false)} / ${rows.length} |`);
  lines.push("");
  lines.push("## 按运行时分组");
  lines.push("");
  lines.push("| runtime | 站点数 | ok | partial | 失败 |");
  lines.push("|---|---|---|---|---|");
  for (const [k, v] of Object.entries(runtimeStats).sort()) {
    lines.push(`| ${k} | ${v.total} | ${v.ok} | ${v.partial} | ${v.fail} |`);
  }
  lines.push("");
  lines.push("## 失败原因归类");
  lines.push("");
  if (!Object.keys(reasons).length) lines.push("（本轮未出现硬失败）");
  else {
    lines.push("| 类型 | 次数 |");
    lines.push("|---|---|");
    for (const [k, v] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("## 无可用条目（no_seed）原因归类");
  lines.push("");
  if (!noSeedRows.length) lines.push("（无）");
  else {
    lines.push("| 类型 | 站点数 |");
    lines.push("|---|---|");
    for (const [k, v] of Object.entries(seedReasons).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${k} | ${v} |`);
    }
  }
  lines.push("");
  lines.push("## 逐站明细");
  lines.push("");
  lines.push("| # | 站点 | runtime | 结论 | 详情 | 封面 | 首集 | 下一集 | 备注 |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  sites.forEach((s, i) => {
    const r = byKey.get(s.key);
    if (!r) {
      const why = s.disabledReason ? short(s.disabledReason, 52) : "未纳入本轮";
      lines.push(`| ${i + 1} | ${short(s.name, 24)} | ${s.runtime || "none"} | 屏蔽/未测 | — | — | — | — | ${why} |`);
      return;
    }
    const notes = [];
    if (r.seed) notes.push(`种子:${r.seed}`);
    if (r.detail?.episodes !== undefined) notes.push(`${r.detail.episodes}集`);
    if (r.play?.parser) notes.push(`解析器:${short(r.play.parser, 18)}`);
    if (r.play?.target) notes.push(`地址形态:${/^https?:/i.test(r.play.target) ? "http" : short(r.play.target.split(":")[0], 12)}`);
    if (r.play?.parseError) notes.push(`解析池:${short(r.play.parseError, 24)}`);
    if (r.play?.playerError) notes.push(`playerContent:${short(r.play.playerError, 24)}`);
    if (["no_seed", "capability_gap"].includes(r.overall) && r.seedTrace?.length) {
      notes.push(`种子:${short(r.seedTrace.join("/"), 78)}`);
    }
    if (r.notes?.length) notes.push(...r.notes.map((n) => short(n, 34)));
    lines.push(`| ${i + 1} | ${short(s.name, 24)} | ${s.runtime || "none"} | ${r.overall} | ${statusText(r.detail)} | ${statusText(r.cover)} | ${statusText(r.play)} | ${statusText(r.next)} | ${notes.join("；") || "—"} |`);
  });
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------- 主流程
const page = await waitForPage();
const cdp = new Cdp(page.webSocketDebuggerUrl);
let originalActive = "";
let boxId = "";
const rows = [];
const started = Date.now();
const startedAt = new Date().toLocaleString("zh-CN", { hour12: false });
let sites = [];
let seed = { ok: false, seeds: {} };

try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const configs = JSON.parse(
    await cdp.eval(`window.__TAURI_INTERNALS__.invoke('config_list').then(v => JSON.stringify(v))`),
  );
  const active = JSON.parse(
    await cdp.eval(`window.__TAURI_INTERNALS__.invoke('config_active').then(v => JSON.stringify(v))`),
  );
  originalActive = active?.id || "";
  const box = configs.find((c) => c.name === "box") || configs.find((c) => c.id !== originalActive);
  if (!box) throw new Error("找不到 box 配置");
  boxId = box.id;
  console.log(`[setup] 原 active=${originalActive || "(none)"}；切换至 box=${boxId}`);
  await cdp.eval(`window.__TAURI_INTERNALS__.invoke('config_activate', { id: ${JSON.stringify(boxId)} }).then(() => 'OK')`);

  const snapshot = JSON.parse(
    await cdp.eval(`window.__TAURI_INTERNALS__.invoke('config_active').then(v => JSON.stringify(v))`),
  );
  sites = (snapshot.sites || []).map((s) => ({
    key: s.key, name: s.name, runtime: s.runtime || "none",
    enabled: s.enabled !== false, disabledReason: s.disabledReason || "",
  }));
  const runnable = sites.filter((s) => s.enabled && !s.disabledReason);
  console.log(`[setup] 站点 ${sites.length}，可运行 ${runnable.length}，屏蔽 ${sites.length - runnable.length}`);

  seed = JSON.parse(await cdp.eval(seedExpression(CFG)));
  console.log(`[seed] ${seed.ok ? `${seed.okCount}/${seed.total} 站响应，${Object.values(seed.seeds).filter(Boolean).length} 站有首页条目` : `失败 ${seed.error}`}`);

  const queue = (LIMIT ? runnable.slice(0, LIMIT) : runnable).slice();
  const total = queue.length;
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      try {
        const meta = {
          id: seed.seeds?.[s.key] || "",
          tid: seed.classes?.[s.key] || "",
          responded: (seed.responded || []).includes(s.key),
        };
        const raw = await cdp.eval(scanExpression(s, meta, CFG));
        const parsed = JSON.parse(raw || "{}");
        // 直播型源有独立的 live_parse 链路，按 VOD 口径失败不算兼容缺陷。
        if (/直播|live/i.test(s.name || "") && parsed.overall === "fail") parsed.overall = "live_n/a";
        rows.push(parsed);
      } catch (e) {
        rows.push({ key: s.key, name: s.name, runtime: s.runtime, overall: "scan_error",
                    detail: {}, cover: {}, play: {}, next: {}, notes: [String(e?.message || e).slice(0, 120)] });
      }
      done += 1;
      const last = rows[rows.length - 1];
      console.log(`[${String(done).padStart(2, "0")}/${total}] ${s.name} (${s.runtime}) → ${last.overall}` +
        (last.play?.reason ? ` | ${last.play.reason}` : ""));
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
} catch (err) {
  console.error(`[fatal] ${err?.message || err}`);
} finally {
  // 恢复原 active，避免把用户的窗口留在测试配置上。
  try {
    if (originalActive) {
      await cdp.eval(`window.__TAURI_INTERNALS__.invoke('config_activate', { id: ${JSON.stringify(originalActive)} }).then(() => 'OK').catch(() => 'ERR')`);
      console.log(`[cleanup] active 恢复为 ${originalActive}`);
    }
  } catch {
    /* best effort */
  }
  cdp.close();
}

const durationMs = Date.now() - started;
const rawPath = resolve(ROOT, ".workbuddy/site-compat-raw.json");
writeFileSync(rawPath, JSON.stringify({ startedAt, durationMs, keyword: KEYWORD, sites, seed, rows }, null, 2), "utf8");
if (sites.length) {
  const report = buildReport({ sites, rows, seed, startedAt, durationMs, keyword: KEYWORD });
  const reportPath = resolve(ROOT, "docs/site-compat-report.md");
  writeFileSync(reportPath, report, "utf8");
  console.log(`\n[report] ${reportPath}`);
}
console.log(`[raw] ${rawPath}`);
console.log(`[done] ${rows.length} 站，${(durationMs / 1000).toFixed(1)}s`);
