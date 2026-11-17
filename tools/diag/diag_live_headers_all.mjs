#!/usr/bin/env node
/**
 * 遍历活跃配置所有直播源列表：按源统计每频道请求头写法（#EXTVLCOPT 独立行 vs
 * #EXTINF 行内 http-user-agent），并定位加密/403 高危频道（jstv/litchi/encrypted/
 * 咪咕 migu/4klive）到底由哪个源提供、用了哪种写法。
 *   node tools/diag/diag_live_headers_all.mjs
 */
import { connect } from "../probes/lib/cdp.mjs";
const cdp = await connect();
const invoke = (cmd, payload) => cdp.invoke(cmd, payload).catch((e) => ({ __error: String(e) }));
const active = await invoke("config_active");
const snap = active?.snapshot || active;
const lives = (snap?.lives || []).filter((l) => /^https?:/.test(String(l.url || "")));
console.log("可抓取直播源数=", lives.length);

const risky = /jstv|litchi|encrypted|4klive|migu|咪咕|8\.138\.7\.223|jsdmirror/i;
for (const src of lives) {
  const f = await invoke("http_fetch", {
    request: { url: src.url, method: "GET", headers: src.ua ? { "user-agent": src.ua } : {} },
  });
  if (f?.__error || !f) { console.log(`\n[${src.name}] 抓取失败 ${JSON.stringify(f).slice(0,80)}`); continue; }
  const body = String(f.body ?? "");
  const lines = body.split(/\r?\n/);
  const vlcUa = (body.match(/#EXTVLCOPT:http-user-agent=/gi) || []).length;
  const vlcRef = (body.match(/#EXTVLCOPT:http-referr/gi) || []).length;
  const inlineUa = (body.match(/#EXTINF[^\n]*\bhttp-user-agent=/gi) || []).length;
  const extgrp = (body.match(/#EXTGRP/gi) || []).length;
  const riskyLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => risky.test(l));
  console.log(
    `\n[${src.name}] status=${f.status} bytes=${body.length} lines=${lines.length}` +
    ` | EXTVLCOPT-ua=${vlcUa} EXTVLCOPT-ref=${vlcRef} EXTINF-inline-ua=${inlineUa} EXTGRP=${extgrp}` +
    ` | 高危频道行=${riskyLines.length}`,
  );
  for (const { l, i } of riskyLines.slice(0, 3)) console.log(`    L${i}: ${l.slice(0, 120)}`);
  // 高危频道的上一条 EXTINF（看它声明了啥头）
  for (const { i } of riskyLines.slice(0, 2)) {
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (/#EXTINF|EXTVLCOPT/i.test(lines[j])) { console.log(`    ↑头 L${j}: ${lines[j].slice(0, 140)}`); break; }
    }
  }
}
cdp.close();
