#!/usr/bin/env node
/**
 * 直接调 IPC 拿 resolve_play / get_vod_detail 的真实错误文案。
 * 页面上的 `[luma:warn] resolve failed Object` 只有对象壳，看不到 code/message，
 * 这个探针绕开 UI 直接把异常序列化出来。
 *
 * 用法：node tools/diag_resolve_error.mjs <siteKey> <vodId> <playUrl|-> [lineWord]
 */
const CDP = "http://127.0.0.1:9222/json/list";
const [siteKey, vodId, playUrlArg = "-", lineWord = ""] = process.argv.slice(2);
if (!siteKey || !vodId) {
  console.error("usage: node tools/diag_resolve_error.mjs <siteKey> <vodId> [playUrl|-] [lineWord]");
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

const target = (await (await fetch(CDP)).json()).find(isApp);
if (!target) throw new Error("app target not found");

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
const ready = new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const slot = pending.get(msg.id);
    pending.delete(msg.id);
    slot(msg);
  }
});
async function send(method, params = {}) {
  await ready;
  const id = ++seq;
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timeout`)), 90000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
}
async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 4500));

// 从详情页 DOM 里捞出真实线路（排除分类标签：分类 chip 没有 line 语义，
// 直接按「chip 数量 == 线路数」不可靠，改用点击后 playUrl 是否含 m3u8 判断）。
const out = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (!invoke) return { fatal: 'no tauri invoke' };
  const call = async (cmd, args) => {
    try { return { ok: true, value: await invoke(cmd, args) }; }
    catch (e) { return { ok: false, error: String(e && (e.message || e.code || e)) }; }
  };
  const pack = (r) => {
    if (!r.ok) return r;
    const v = r.value;
    return { ok: true, keys: Object.keys(v || {}), url: v?.url, proxyUrl: v?.proxyUrl,
             playFrom: v?.playFrom, headers: v?.headers, kind: v?.kind };
  };

  const detail = await call('spider_invoke', {
    request: { siteKey: ${JSON.stringify(siteKey)}, method: 'detailContent', args: [${JSON.stringify(vodId)}] },
  });
  const vod = detail.ok ? (Array.isArray(detail.value) ? detail.value[0] : (detail.value?.data?.[0] ?? detail.value)) : null;
  if (!vod) return { fatal: 'empty detail', raw: JSON.stringify(detail).slice(0, 400) };
  // TVBox 线路格式：from = "A$$$B"，url = "<A集1#A集2>$$$<B集1#B集2>"，集内 "名$地址"。
  const froms = vod.lines ? [] : String(vod.vod_play_from || '').split('$$$');
  const groups = vod.lines ? [] : String(vod.vod_play_url || '').split('$$$');
  const lines = vod.lines || froms.map((name, i) => ({
    name: name || ('线路' + (i + 1)),
    episodes: String(groups[i] || '')
      .split('#')
      .filter(Boolean)
      .map((pair) => {
        const at = pair.indexOf('$');
        return { name: at > 0 ? pair.slice(0, at) : '', url: at > 0 ? pair.slice(at + 1) : pair };
      }),
  }));
  const detailMeta = detail.ok
    ? { lineCount: lines.length, lines: lines.map((l) => [l.name, (l.episodes || []).length]) }
    : detail;

  let playUrl = ${JSON.stringify(playUrlArg)};
  if (!playUrl || playUrl === '-') {
    const line = ${JSON.stringify(lineWord)}
      ? lines.find((l) => (l.name || '').includes(${JSON.stringify(lineWord)}))
      : lines[0];
    playUrl = line?.episodes?.[0]?.url || '';
  }
  if (!playUrl) return { fatal: 'no playUrl', detail: detailMeta };

  // 多试几集：首集坏片很常见，用第 1/4/12 集区分「线路整体坏」与「单片坏」。
  const line = lines.find((l) => (l.episodes || []).some((e) => e.url === playUrl)) 
    || lines.find((l) => (l.name || '').includes(${JSON.stringify(lineWord)}));
  const probes = [];
  const eps = line?.episodes || [];

  // 后端链路：spider playerContent（把 opaque token 换成真地址）→ resolve_play（走反代）
  const stepProbe = async (ep) => {
    const started = Date.now();
    const pc = await call('spider_invoke', {
      request: { siteKey: ${JSON.stringify(siteKey)}, method: 'playerContent',
                 args: [line?.name || '', ep.url, []] },
    });
    const raw = pc.ok ? (Array.isArray(pc.value) ? pc.value[0] : pc.value) : null;
    const playUrl = raw?.url || raw?.playUrl || '';
    const result = { ep: ep.name, playerContentMs: Date.now() - started,
                     playerContentOk: pc.ok, playUrl: String(playUrl).slice(0, 120),
                     parse: raw?.parse, jx: raw?.jx, pcError: pc.ok ? null : pc.error };
    if (!playUrl) return result;
    const r = await call('resolve_play', { request: { siteKey: ${JSON.stringify(siteKey)}, url: playUrl } });
    const packed = pack(r);
    return { ...result, resolveMs: Date.now() - started, resolve: packed };
  };

  for (const idx of [0, 3, 11]) {
    const ep = eps[idx];
    if (!ep) continue;
    const one = await stepProbe(ep);
    probes.push(one);
    // 拿到可用直链就停，避免把源打爆
    if (one.resolve?.ok) break;
  }
  return { detail: detailMeta, line: line?.name, playUrl: playUrl.slice(0, 160), probes };
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
