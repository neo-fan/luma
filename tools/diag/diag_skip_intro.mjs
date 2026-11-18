#!/usr/bin/env node
// 端到端验证「片头自动跳过」：播一次建历史 → 注入 skipJson(intro) → 重载再播 → 看 currentTime 跳过片头。
import { connect } from "../probes/lib/cdp.mjs";
const cdp = await connect();
const invoke = (cmd, p) => cdp.invoke(cmd, p).catch((e) => ({ __error: String(e) }));
const INTRO_SEC = 10;

await cdp.send("Page.reload", { ignoreCache: true });
await cdp.eval(`(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<60;i++){if(document.querySelector('.nav__item'))return;await s(400);}})()`);

// 1) 搜索找一个可播点播条目，优先 cms 源（python 源本轮频繁超时/崩）
const active = await invoke("config_active");
const runtimeOf = new Map((((active?.snapshot || active)?.sites) || []).map((s) => [s.key, s.runtime]));
const agg = await invoke("spider_invoke", { request: { siteKey: "all", method: "searchContent", args: ["庆余年", false, 1], timeoutMs: 30000 } });
const rows = (agg.results || []).filter((r) => r.ok && r.data?.list?.length);
rows.sort((a, b) => ((runtimeOf.get(b.siteKey) === "cms") ? 1 : 0) - ((runtimeOf.get(a.siteKey) === "cms") ? 1 : 0));
let pick = null;
for (const row of rows) {
  const v = row.data.list[0];
  if (v?.vod_id && v?.vod_name) { pick = { siteKey: row.siteKey, runtime: runtimeOf.get(row.siteKey), vodId: String(v.vod_id), name: v.vod_name }; break; }
}
if (!pick) { console.log("没找到可播条目"); cdp.close(); process.exit(2); }
console.log("[pick]", JSON.stringify(pick));

// 2) 先播一次，让 PlayerPage 写入历史行（按剧名）
await cdp.eval(`(() => { location.hash = '#/detail/' + encodeURIComponent(${JSON.stringify(pick.siteKey)}) + '/' + encodeURIComponent(${JSON.stringify(pick.vodId)}); return 1; })()`);
const clicked = await cdp.eval(`(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<40;i++){const e=document.querySelector('.episode-grid .episode')||document.querySelector('.content .episode');if(e){e.click();return 'CLICKED';}await s(300);}return 'NO_EP';})()`);
console.log("[首次播放]", clicked);
await cdp.sleep(6000); // 等历史 upsert 落库

// 3) 读回历史行，注入 skipJson intro
const hist = await invoke("history_list");
const row = (hist || []).find((h) => (h.name || "").trim() === pick.name.trim());
if (!row) { console.log("历史里没这行（首次播放未落库？）", JSON.stringify((hist||[]).slice(0,3).map(h=>h.name))); cdp.close(); process.exit(2); }
const skipJson = JSON.stringify([{ kind: "intro", ms: INTRO_SEC * 1000 }]);
const upserted = await invoke("history_upsert", { item: { ...row, skipJson, positionMs: 0 } });
console.log("[注入 skipJson]", skipJson, "upsert:", upserted?.__error || "ok");

// 4) 重载再播同一集，看 currentTime 是否跳过片头
await cdp.send("Page.reload", { ignoreCache: true });
await cdp.eval(`(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<60;i++){if(document.querySelector('.nav__item'))return;await s(400);}})()`);
await cdp.eval(`(() => { location.hash = '#/detail/' + encodeURIComponent(${JSON.stringify(pick.siteKey)}) + '/' + encodeURIComponent(${JSON.stringify(pick.vodId)}); return 1; })()`);
await cdp.eval(`(async()=>{const s=ms=>new Promise(r=>setTimeout(r,ms));for(let i=0;i<40;i++){const e=document.querySelector('.episode-grid .episode')||document.querySelector('.content .episode');if(e){e.click();return;}await s(300);}})()`);

let jumped = false, maxT = 0;
for (let i = 0; i < 15; i++) {
  await cdp.sleep(1500);
  const v = await cdp.eval(`(() => { const x = document.querySelector('.player-art video') || document.querySelector('video'); return x ? { t: +x.currentTime.toFixed(1), w: x.videoWidth, ready: x.readyState } : null; })()`);
  if (v) { maxT = Math.max(maxT, v.t); console.log(`[t+${(i+1)*1.5}s]`, JSON.stringify(v)); if (v.t >= INTRO_SEC - 1) { jumped = true; break; } }
}
console.log("[verdict]", jumped ? `PASS 片头自动跳过（currentTime 到 ${maxT}s ≥ ${INTRO_SEC}s）` : `FAIL 未跳过（max currentTime=${maxT}s）`);
cdp.close();
