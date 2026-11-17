#!/usr/bin/env node
// 针对性补测：对 resolve_play 返回的资源直链，经反代用 Range 实拉，看是否 206/200、
// 字节与 content-type 正常，并用真实 <video> 元素经 hls/native 观察能否解码出画。
import { connect } from "../probes/lib/cdp.mjs";
const cdp = await connect();
const url = "http://8.138.7.223/tv/jsws4k.php";
const r = await cdp.invoke("resolve_play", { request: { siteKey: "live", url } });
const proxyUrl = r.proxyUrl;
console.log("[resolve]", JSON.stringify({ kind: r.kind, proxyUrl: String(proxyUrl).slice(0, 120) }));

// A) 反代 Range 实拉（前 256KB）
const a = await cdp.eval(`(async () => {
  const res = await fetch(${JSON.stringify(proxyUrl)}, { headers: { Range: 'bytes=0-262143' }, cache: 'no-store' });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type'),
           range: res.headers.get('content-range'), bytes: buf.length,
           head: [...buf.slice(0,12)].map(b=>b.toString(16).padStart(2,'0')).join(' ') };
})()`);
console.log("[proxy range 256KB]", JSON.stringify(a));

// B) 全量首 1MB（测反代是否持续出流）
const b = await cdp.eval(`(async () => {
  const res = await fetch(${JSON.stringify(proxyUrl)}, { headers: { Range: 'bytes=0-1048575' }, cache: 'no-store' });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, bytes: buf.length };
})()`);
console.log("[proxy range 1MB]", JSON.stringify(b));

// C) 真实 <video> 解码（native HLS/MP4；Chromium 对 mp4 原生可放）
const c = await cdp.eval(`(async () => {
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto';
  document.body.appendChild(v);
  const errs = [];
  v.addEventListener('error', () => errs.push('video-error:' + (v.error && v.error.code)));
  v.src = ${JSON.stringify(proxyUrl)};
  const t = Date.now();
  while (Date.now() - t < 15000) {
    if (v.readyState >= 2 && v.videoWidth > 0) { const o = { w: v.videoWidth, h: v.videoHeight, dur: v.duration, errs }; v.remove(); return o; }
    if (v.error) { const o = { failed: true, code: v.error.code, errs }; v.remove(); return o; }
    await new Promise(r => setTimeout(r, 300));
  }
  const o = { timeout: true, ready: v.readyState, w: v.videoWidth, errs };
  v.remove(); return o;
})()`);
console.log("[native video decode]", JSON.stringify(c));

cdp.close();
