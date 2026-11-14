#!/usr/bin/env node
/**
 * 直播源诊断：给定一个 m3u 地址，走产品自己的抓取与解析链路，再抽样直连频道地址。
 *
 * 用来回答「为什么某个直播源一个都放不了」：把链路拆成三段分别取证——
 *   1. 抓取：后端 `http_fetch` 拿 m3u 原文（状态、字节数、耗时）；
 *   2. 解析：`live_parse` 出分组/频道数（含 `#EXTINF` 里的名字与 URL）；
 *   3. 出流：抽样 N 个频道经 `http_fetch` 取前 2KB，看 HTTP 状态 / Content-Type /
 *      首字节（m3u8 应是 `#EXTM3U`，MPEG-TS 应是 `0x47`）。
 *
 * 这是诊断脚本，不做断言：只打印证据，退出码只反映「m3u 本身取不到」。
 *
 *   node tools/diag/diag_live_source.mjs --url=https://example.com/list.m3u --sample=8
 *   node tools/diag/diag_live_source.mjs --url=... --ua="okhttp/3.15"
 */
import { connect } from "../probes/lib/cdp.mjs";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : "";
};

const url = valueOf("--url");
const ua = valueOf("--ua") || null;
const sampleSize = Number(valueOf("--sample") || "8");
if (!url) {
  console.error("用法：node tools/diag/diag_live_source.mjs --url=<m3u 地址> [--ua=...] [--sample=8]");
  process.exit(2);
}

const cdp = await connect();
const invoke = (command, payload) => cdp.invoke(command, payload).catch((error) => ({ __error: String(error) }));

const startedAt = Date.now();
const fetched = await invoke("http_fetch", { request: { url, method: "GET" } });
const fetchMs = Date.now() - startedAt;
if (fetched?.__error || !fetched) {
  console.log("抓取失败:", JSON.stringify(fetched));
  cdp.close();
  process.exit(1);
}
const body = String(fetched.body ?? "");
console.log(
  `抓取: status=${fetched.status} bytes=${body.length} elapsed=${fetchMs}ms`,
  `| 前 120 字符: ${JSON.stringify(body.slice(0, 120))}`,
);

const parsed = await invoke("live_parse", { url, ua });
if (parsed?.__error) {
  console.log("解析失败:", JSON.stringify(parsed));
  cdp.close();
  process.exit(1);
}
const groups = parsed?.groups ?? [];
const channels = groups.flatMap((group) => group.channels ?? []);
console.log(`解析: groups=${groups.length} channels=${channels.length} source=${JSON.stringify(parsed?.source ?? "")}`);
for (const group of groups.slice(0, 15)) {
  console.log(`  [${group.channels?.length ?? 0}] ${group.name}`);
}

const hosts = new Map();
for (const channel of channels) {
  let host = "(invalid)";
  try {
    host = new URL(String(channel.url)).host;
  } catch {
    /* 保留 invalid */
  }
  hosts.set(host, (hosts.get(host) ?? 0) + 1);
}
console.log(`频道 host 分布（前 10）:`, [...hosts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10));

/** 取前 2KB 判断「出流」：m3u8 文本 vs MPEG-TS 二进制 vs 其它。 */
async function probeChannel(channel) {
  const raw = String(channel.url ?? "");
  const startedProbe = Date.now();
  const result = await invoke("http_fetch", {
    request: { url: raw, method: "GET", headers: { range: "bytes=0-2047" } },
  });
  const cost = Date.now() - startedProbe;
  if (result?.__error || !result) return { raw, verdict: "fetch-error", detail: JSON.stringify(result).slice(0, 160), cost };
  const text = String(result.body ?? "");
  const head = text.slice(0, 40);
  let verdict = "unknown";
  if (text.startsWith("#EXTM3U")) verdict = "m3u8";
  else if (text.includes("#EXTINF")) verdict = "m3u8-fragment";
  else if (text.length > 0 && text.charCodeAt(0) === 0x47) verdict = "mpeg-ts";
  else if (text.startsWith("<")) verdict = "html/xml";
  const contentType = Object.entries(result.headers ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  return {
    raw,
    verdict,
    detail: `status=${result.status} bytes=${text.length} contentType=${JSON.stringify(contentType)} head=${JSON.stringify(head)}`,
    cost,
  };
}

console.log(`\n抽样频道（最多 ${sampleSize} 个）:`);
for (const channel of channels.slice(0, sampleSize)) {
  const row = await probeChannel(channel);
  console.log(`  ${String(channel.name).slice(0, 14).padEnd(14)} ${row.verdict.padEnd(14)} ${row.cost}ms  ${row.raw.slice(0, 80)}`);
  console.log(`    ${row.detail}`);
}

cdp.close();
