#!/usr/bin/env node
/** 在页面里直接计时 invoke resolve_play，判断卡在前端还是后端。 */
const CDP = "http://127.0.0.1:9222/json/list";
const [siteKey, vodId, lineWord = ""] = process.argv.slice(2);
const target = (await (await fetch(CDP)).json()).find((t) => {
  try {
    const u = new URL(t.url);
    return t.type === "page" && u.port === "1420" && u.pathname === "/";
  } catch {
    return false;
  }
});
if (!target) throw new Error("no target");
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const s = pending.get(m.id);
    pending.delete(m.id);
    s(m);
  }
});
const send = async (method, params = {}) => {
  const id = ++seq;
  const reply = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(method + " timeout")), 90000);
    pending.set(id, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
};
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result?.value;
};

const out = await evaluate(`(async () => {
  const nav = await import('/src/lib/nav.ts');
  const inv = await import('/src/lib/invoke.ts');
  const detail = await window.__TAURI_INTERNALS__.invoke('spider_invoke', { request: { siteKey: ${JSON.stringify(siteKey)}, method: 'detailContent', args: [${JSON.stringify(vodId)}] } });
  const vod = detail[0];
  const from = String(vod.vod_play_from).split('$$$');
  const urls = String(vod.vod_play_url).split('$$$');
  const i = Math.max(0, from.findIndex((f) => String(f).includes(${JSON.stringify(lineWord)})));
  const firstEp = String(urls[i]).split('#')[0];
  const epUrl = firstEp.slice(firstEp.indexOf('$') + 1);
  const er = await import('/src/lib/episodeResolve.ts');
  const t0 = performance.now();
  const target = await er.resolveEpisodeTarget(${JSON.stringify(siteKey)}, from[i], epUrl, { playerContentTimeoutMs: 20000 });
  const t1 = performance.now();
  let resolved = null, err = '';
  try {
    resolved = await Promise.race([
      inv.api.resolvePlay({ siteKey: ${JSON.stringify(siteKey)}, url: target.url, ua: target.ua, referer: target.referer, cookie: target.cookie }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('resolvePlay timeout 20s')), 20000)),
    ]);
  } catch (e) { err = String(e && e.message || e); }
  const t2 = performance.now();
  return {
    line: from[i],
    playerContentMs: Math.round(t1 - t0),
    resolvePlayMs: Math.round(t2 - t1),
    resolveError: err,
    kind: resolved?.kind,
    proxyUrl: String(resolved?.proxyUrl || '').slice(0, 80),
    hasUrl: !!resolved?.url,
  };
})()`);
console.log(JSON.stringify(out, null, 2));
ws.close();
