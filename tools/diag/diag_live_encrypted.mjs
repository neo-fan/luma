#!/usr/bin/env node
/**
 * 直播「加密 HLS」取证：给定一个页面式直播地址（嗅探后落到 litchi-play-encrypted
 * 这类加密 m3u8），走产品自己的 resolve_play（内部触发 level-4 隐藏 WebView2 嗅探）
 * → 本地反代，逐环取证，专门回答两件事：
 *   ① 「sniffer found media url」之后，播放器拿到的 encrypted m3u8 到底能不能取到
 *      真分片 / 能不能经反代拿到 AES key（决定「找到≠能播」是否成立）；
 *   ② level-4 嗅探的 15s 硬超时到底有多不稳（同一地址连跑几次，统计 found/exceeded）。
 *
 * 这是诊断脚本，不做硬断言：打印证据 + 一句 verdict。最后尽力用真实直播 UI 观察解码。
 *
 *   node tools/diag/diag_live_encrypted.mjs
 *   node tools/diag/diag_live_encrypted.mjs --url=http://host/page.php --ua="..." --tries=5 --channel=江苏卫视
 *
 * 前置：dev 窗口（9222）在跑。
 */
import { connect } from "../probes/lib/cdp.mjs";

const args = process.argv.slice(2);
const valueOf = (name, d = "") => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : d;
};

const URL_PAGE = valueOf(
  "--url",
  "http://8.138.7.223/tv/jsws4k.php",
);
const UA = valueOf("--ua", "") || null;
const TRIES = Number(valueOf("--tries", "4"));
const CHANNEL = valueOf("--channel", "");

const cdp = await connect();
const invoke = (command, payload) =>
  cdp.invoke(command, payload).catch((error) => ({ __error: String(error) }));

// 0) 原始页面：确认它是「页面式」（返回 HTML 而非 #EXTM3U），所以必须走嗅探。
const raw = await invoke("http_fetch", {
  request: { url: URL_PAGE, method: "GET", headers: UA ? { "user-agent": UA } : {} },
});
if (raw?.__error) {
  console.log("[page] 原始地址抓取失败:", JSON.stringify(raw).slice(0, 200));
} else {
  const body = String(raw.body ?? "");
  console.log(
    `[page] status=${raw.status} bytes=${body.length} head=${JSON.stringify(body.slice(0, 60))}`,
  );
}

// ① + ② resolve_play（内部 level-4 嗅探）连跑 TRIES 次。
let lastProxy = "";
let found = 0;
let exceeded = 0;
for (let i = 0; i < TRIES; i += 1) {
  const t0 = Date.now();
  const r = await invoke("resolve_play", {
    request: { siteKey: "live", url: URL_PAGE, ua: UA || "" },
  });
  const cost = Date.now() - t0;
  if (r?.__error) {
    const msg = r.__error;
    if (/exceeded|15000|sniff/i.test(msg)) exceeded += 1;
    console.log(`[resolve #${i + 1} ${cost}ms] ERROR: ${msg.slice(0, 140)}`);
  } else {
    found += 1;
    lastProxy = r.proxyUrl || "";
    console.log(
      `[resolve #${i + 1} ${cost}ms] kind=${r.kind} proxyUrl=${(r.proxyUrl || "").slice(0, 110)}`,
    );
  }
}
console.log(`\n[sniff 统计] found=${found} failed=${TRIES - found}（其中 exceeded≈${exceeded}）/ 共 ${TRIES} 次`);

// 拿到 proxyUrl 就对反代产物逐字节取证。
if (!lastProxy) {
  console.log("\n[verdict] 本次没有拿到 proxyUrl —— 直播地址在 level-4 嗅探里全失败（② 成立，① 无从验证）。");
  cdp.close();
  process.exit(0);
}

const manifest = await cdp.eval(`(async () => {
  const res = await fetch(${JSON.stringify(lastProxy)}, { cache: 'no-store' });
  const text = await res.text();
  const lines = text.split('\\n').map((l) => l.trim()).filter(Boolean);
  const key = lines.find((l) => l.startsWith('#EXT-X-KEY')) || '';
  const segs = lines.filter((l) => !l.startsWith('#'));
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    head: text.slice(0, 40),
    isM3U: text.startsWith('#EXTM3U'),
    lineCount: lines.length,
    segCount: segs.length,
    proxiedSegs: segs.filter((s) => /127\\.0\\.0\\.1|localhost/.test(s)).length,
    key,
    keyUri: (key.match(/URI="([^"]+)"/) || [])[1] || '',
    keyMethod: (key.match(/METHOD=([^,\\s]+)/) || [])[1] || '',
    firstSeg: segs[0] || '',
  };
})()`);
console.log("\n[manifest] ", JSON.stringify(manifest));

const segInfo = manifest.firstSeg
  ? await cdp.eval(`(async () => {
      const res = await fetch(${JSON.stringify(manifest.firstSeg)}, { cache: 'no-store' });
      const buf = new Uint8Array(await res.arrayBuffer());
      const hex = [...buf.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      return { status: res.status, bytes: buf.length, hex, looksTs: buf[0] === 0x47 };
    })()`).catch((e) => ({ fetchError: String(e).slice(0, 120) }))
  : null;
console.log("[首分片] ", JSON.stringify(segInfo));

let keyInfo = null;
if (manifest.keyUri) {
  keyInfo = await cdp
    .eval(`(async () => {
      const res = await fetch(${JSON.stringify(manifest.keyUri)}, { cache: 'no-store' });
      const buf = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bytes: buf.length, proxied: /127\\.0\\.0\\.1|localhost/.test(location.href) && ${JSON.stringify(manifest.keyUri)}.includes('127.0.0.1') };
    })()`)
    .catch((e) => ({ fetchError: String(e).slice(0, 120) }));
  console.log("[AES key] ", JSON.stringify(keyInfo), "method=", manifest.keyMethod);
}

console.log("\n[① verdict] " + verdict(manifest, segInfo, keyInfo));

// 尽力：用真实直播 UI 观察解码（需 --channel 命中当前 active 配置的频道名）。
if (CHANNEL) {
  console.log(`\n[UI] 进 #/live 找频道「${CHANNEL}」观察真实解码 …`);
  const pick = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(300); } return null; };
    location.hash = '#/live';
    const items = await waitFor(() => { const l = [...document.querySelectorAll('.live-rail__item')]; return l.length ? l : null; }, 60000);
    if (!items) return { ok: false, reason: 'NO_RAIL_ITEM' };
    const it = items.find((i) => (i.textContent || '').includes(${JSON.stringify(CHANNEL)}));
    if (!it) return { ok: false, reason: 'NO_MATCH', sample: items.slice(0, 8).map((i) => i.textContent.trim()) };
    it.click();
    return { ok: true, name: (it.querySelector('.live-rail__name')?.textContent || it.textContent).trim() };
  })()`);
  console.log("[UI pick]", JSON.stringify(pick));
  if (pick?.ok) {
    for (let i = 0; i < 10; i += 1) {
      await cdp.sleep(2000);
      const v = await cdp.eval(`(() => {
        const video = document.querySelector('.player-art video');
        return { w: video?.videoWidth || 0, h: video?.videoHeight || 0, t: +(video?.currentTime || 0).toFixed(1),
                 ready: video?.readyState || 0, err: video?.error?.code || 0,
                 bar: document.querySelector('.player-status__title')?.textContent || '',
                 errorBar: document.querySelector('.error-bar')?.innerText || '' };
      })()`);
      console.log(`[UI t+${(i + 1) * 2}s]`, JSON.stringify(v));
      if (v.w > 0 && v.t > 0.5) break;
    }
    await cdp.screenshot("tools/.out/diag-live-encrypted-ui.png").catch(() => {});
    console.log("[shot] tools/.out/diag-live-encrypted-ui.png");
  }
}

cdp.close();

function verdict(m, s, k) {
  if (!m?.isM3U) return "反代拿到的不是 #EXTM3U 列表（源站/嗅探产物可疑）→ 大概率放不了。";
  if (m.keyMethod && m.keyMethod !== "NONE" && !m.keyUri)
    return `声明了加密 KEY(method=${m.keyMethod}) 但没解析出 URI → 无法解密。`;
  if (m.keyMethod && m.keyMethod !== "NONE") {
    if (!k || k.fetchError) return `加密源：AES key 取不到（${JSON.stringify(k)}）→ hls.js 解不开 → 黑屏。`;
    if (k.status !== 200 || k.bytes < 16)
      return `加密源：AES key 异常 status=${k.status} bytes=${k.bytes} → 解密失败风险。`;
    if (s && (s.fetchError || s.status !== 200 || !s.looksTs))
      return `AES key 能取(16B)，但首分片异常(${JSON.stringify(s)}) → 密文/坏流，播放器解不开。`;
    return `加密源基础设施 OK：manifest=#EXTM3U, ${m.keyMethod} key 经反代取到 ${k?.bytes}B, 首分片 status=${s?.status}${s?.looksTs ? " 且是 MPEG-TS(0x47)" : ""}。理论上可解，最终看播放器。`;
  }
  if (s && (s.fetchError || s.status !== 200))
    return `非加密，但首分片取失败(${JSON.stringify(s)}) → 放不了。`;
  if (s && !s.looksTs && s.bytes < 800)
    return `非加密，首分片字节头不像 TS(${JSON.stringify(s.hex)}) → 可能是 HTML/坏数据。`;
  return `非加密 m3u8，manifest+首分片正常(status=${s?.status}) → 应可播。`;
}
