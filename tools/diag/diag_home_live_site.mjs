#!/usr/bin/env node
// 用 App 真实签名 playerContent(from, url, []) 复现「直播[py]」一条频道的播放解析。
import { connect } from "../probes/lib/cdp.mjs";
const cdp = await connect();
const invoke = (cmd, p) => cdp.invoke(cmd, p).catch((e) => ({ __error: String(e) }));
const KEY = "py_yangshipin";

const cat = await invoke("spider_invoke", { request: { siteKey: KEY, method: "categoryContent", args: ["cctv", false, 1, ""], timeoutMs: 20000 } });
const list = cat?.list || [];
console.log("[cctv list]", list.length, JSON.stringify(list.slice(0,3).map(v=>({id:v.vod_id,n:v.vod_name}))));
const vod = list[1] || list[0]; // cctv2 财经（截图那台）
const det = await invoke("spider_invoke", { request: { siteKey: KEY, method: "detailContent", args: [String(vod.vod_id)], timeoutMs: 25000 } });
const dv = Array.isArray(det) ? det[0] : det;
const from = String(dv?.vod_play_from||"").split("$$$")[0] || "";
const firstEp = String(dv?.vod_play_url||"").split("$$$")[0].split("#")[0] || "";
const url = firstEp.includes("$") ? firstEp.slice(firstEp.indexOf("$")+1) : firstEp;
console.log(`[detail] ${vod.vod_name} from="${from}" ep="${firstEp}" url="${url}"`);

// App 的确切签名：play(from, url, vipFlags=[])
const pc = await invoke("spider_invoke", { request: { siteKey: KEY, method: "playerContent", args: [from, url, []], timeoutMs: 20000 } });
console.log("[playerContent(from,url,[])]", JSON.stringify(pc).slice(0, 400));

const cand = String(pc?.playUrl || pc?.url || "");
if (/^https?:/.test(cand)) {
  const rp = await invoke("resolve_play", { request: { siteKey: KEY, url: cand, ua: (pc?.header||{})["User-Agent"]||"", referer: (pc?.header||{})["Referer"]||"" } });
  console.log("[resolve_play]", JSON.stringify(rp).slice(0, 260));
  const pu = rp?.proxyUrl || "";
  if (pu) {
    const m = await cdp.eval(`(async()=>{const r=await fetch(${JSON.stringify(pu)},{cache:'no-store'});const b=await r.text();return {status:r.status,isM3U:b.startsWith('#EXTM3U'),head:JSON.stringify(b.slice(0,50))};})()`);
    console.log("[proxy 首拉]", JSON.stringify(m));
  }
} else {
  console.log("[结论] playerContent 没给出 http 地址，candidate=", JSON.stringify(cand), "→ 这才是真实失败点");
}
cdp.close();
