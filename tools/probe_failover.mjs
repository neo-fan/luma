#!/usr/bin/env node
/**
 * 自动换源验收：stub 提供「死源 + 活源」两个同名站点，播放死源时必须自动切到活源
 * 并真实解码。需要 stub(8787) + dev 窗口(9222)。
 * Exit 0 只在「提示已切换 + 视频在播」时成立。
 */
import { writeFileSync } from "node:fs";
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
let id = 0;
const send = (m, p) => new Promise((res) => { const my = ++id; const h = (e) => { const x = JSON.parse(e.data); if (x.id !== my) return; ws.removeEventListener("message", h); res(x.result); }; ws.addEventListener("message", h); ws.send(JSON.stringify({ id: my, method: m, params: p })); });
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = (l) => ev(`[...document.querySelectorAll('.nav__item')].find(n=>n.textContent.trim()==='${l}')?.click(), 'ok'`);

await nav("设置");
await sleep(700);
await ev(`(() => { const i=document.querySelector('input.input'); const st=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; st.call(i,'http://127.0.0.1:8787/config-failover.json'); i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='导入')?.click()`);
await sleep(6000);
console.log("import:", await ev(`document.querySelector('.tip')?.innerText || document.querySelector('.error-bar')?.innerText || 'none'`));

await nav("搜索");
await sleep(800);
await ev(`(() => { const sel=document.querySelector('select'); sel.value=sel.options[0].value; sel.dispatchEvent(new Event('change',{bubbles:true})); return 'ok'; })()`);
await ev(`(() => { const i=document.querySelector('.search-bar input'); const st=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; st.call(i,'Stub'); i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`);
await sleep(300);
await ev(`[...document.querySelectorAll('.search-bar button')].find(b=>/搜索/.test(b.textContent))?.click()`);
await sleep(6000);
console.log("results:", (await ev(`document.querySelector('.content').innerText`)).replace(/\n+/g,' | ').slice(0,160));

console.log("open dead card:", await ev(`(() => { const cards=[...document.querySelectorAll('.vod-card')]; const c=cards.find(x=>/DEAD/.test(x.textContent)) || cards[0]; if(!c) return 'NO_CARD'; c.click(); return c.innerText.replace(/\\n/g,' '); })()`));
await sleep(4000);
console.log("detail site:", await ev(`document.querySelector('.page-meta')?.innerText || ''`));
console.log("ep:", await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/第\\s*0?1\\s*集/.test(x.textContent)); if(!b) return 'MISSING'; b.click(); return b.textContent.trim(); })()`));
await sleep(9000);
console.log("tip:", await ev(`document.querySelector('.tip')?.innerText || '(none)'`));
console.log("error:", await ev(`document.querySelector('.error-bar')?.innerText || '(none)'`));
console.log("video:", await ev(`(() => { const v=document.querySelector('video'); return v? JSON.stringify({paused:v.paused,t:+v.currentTime.toFixed(2),d:Number.isFinite(v.duration)?+v.duration.toFixed(1):null,rs:v.readyState,w:v.videoWidth}) : 'NO_VIDEO'; })()`));
await sleep(4000);
console.log("video2:", await ev(`(() => { const v=document.querySelector('video'); return v? JSON.stringify({paused:v.paused,t:+v.currentTime.toFixed(2),rs:v.readyState,w:v.videoWidth}) : 'NO_VIDEO'; })()`));
console.log("now site:", await ev(`document.querySelector('.page-meta')?.innerText || ''`));
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(".workbuddy/ui-failover.png", Buffer.from(shot.data, "base64"));

const state = await ev(`(() => { const v=document.querySelector('video'); return v ? JSON.stringify({t:v.currentTime,paused:v.paused,w:v.videoWidth,rs:v.readyState}) : 'NO_VIDEO'; })()`);
const finalTip = await ev(`document.querySelector('.tip')?.innerText || ''`);
let ok = true;
const check = (cond, label, detail = "") => {
  console.log(`[${cond ? "ok  " : "FAIL"}] ${label}${detail ? "  -- " + detail : ""}`);
  if (!cond) ok = false;
};
check(/已自动切换到/.test(finalTip), "failover tip shown", finalTip);
try {
  const parsed = JSON.parse(state);
  check(parsed.t > 0 || parsed.rs >= 3, "video really played after switch", state);
} catch {
  check(false, "video really played after switch", String(state));
}
ws.close();
process.exit(ok ? 0 : 1);
