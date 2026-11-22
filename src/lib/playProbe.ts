/**
 * 播放线路探活：在切换前确认「这条地址真的能出流」。
 *
 * 只看 `response.ok` 不够。真实配置里有两类「清单合法但根本放不出来」的死线路：
 *
 * 1. 网盘解析接口：`http://host/m3u8/pan1.php?token=…m3u8` 解析失败时仍返回
 *    **200** + `application/json`（`{"code":201,"msg":"解析失败了","url":""}`），
 *    `classify` 又因 query 里带 `m3u8` 把它判成 hls，hls.js 拿到 JSON 才报
 *    `manifestParsingError`——错误信息完全指错了方向。
 * 2. **占位图假流**（2026-11-14 实测 py_bubuzhuiju）：清单本身是合法
 *    `#EXTM3U`，但每条的「分片」实际是 1×1 透明 PNG（`image/png`，PAN1/NBY
 *    线路），解码必然失败。只校验清单头会把这种线路判为可用，用户看到的是
 *    黑屏/一直转圈，然后才被 stall 看门狗判死，白等十几秒。
 *
 * 因此 hls 探活分两步：先认清单，再认**首个分片的 Content-Type**——
 * 占位图（`image/*`）与 HTML 错误页一律判死；TS（`video/mp2t`）、fMP4、
 * `application/octet-stream` 以及无法判定（超时/无 header）都视为正常，避免误杀。
 *
 * ⚠️ 「能播 / 不能播」是二元的，但**时间不是证据**：慢源冷启首字节要到
 * 12–20 秒，超时只说明「此刻还没回」，不能据此把线路判死。所以本模块对外
 * 提供三态判定（`LineVerdict`）：
 *
 * - `dead`    明确失败：HTTP 4xx/5xx、清单不是 m3u8、分片是占位图/HTML；
 * - `ok`      明确成功：状态与内容都对得上；
 * - `unknown` 证据不足：请求超时、连接被中断、反代自身还没就绪。
 *
 * 播放页的「线路卡住要不要换」只认 `dead`；`unknown` 一律继续等，把决定权
 * 留给用户（实测「走马上任」某些 4K 线路冷启 18 秒，被 12 秒定时器误杀）。
 */

import { PROBE_DEFAULT_TIMEOUT_MS } from "./constants";
export type LineVerdict = "ok" | "dead" | "unknown";

const BAD_SEGMENT_TYPE = /^(?:image\/|text\/html)/i;

/**
 * 取清单里第一条分片，只看响应头判真伪。
 *
 * 不下载分片本体：拿到响应头（Content-Type）立刻 cancel body，成本约一个
 * 往返。刻意不带 `Range`：反代要读到分片头部才能剥离「PNG 头 + TS」伪装，
 * 带 Range 会让它把剥离后的长度算错（实测 PAN1 线路）。
 */
async function firstSegmentVerdict(
  manifest: string,
  baseUrl: string,
  signal: AbortSignal,
): Promise<LineVerdict> {
  const first = manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!first) {
    // 没有分片的清单交给 hls.js 自己报错，别在这里判死。
    return "ok";
  }
  let segmentUrl: string;
  try {
    segmentUrl = new URL(first, baseUrl).toString();
  } catch {
    return "ok";
  }
  try {
    const response = await fetch(segmentUrl, { signal });
    void response.body?.cancel?.().catch(() => {});
    if (!(response.ok || response.status === 405 || response.status === 416)) {
      // 分片 403/404 = 防盗链或已过期，这条线路同样不可用。
      return "dead";
    }
    const type = response.headers?.get?.("content-type") ?? "";
    return BAD_SEGMENT_TYPE.test(type) ? "dead" : "ok";
  } catch {
    // 被总超时中断 / 取头失败：证据不足，不误杀，交给播放器与看门狗。
    return "unknown";
  }
}

/**
 * 探一条线路的「明确状态」。
 *
 * `timeoutMs` 默认 5s：这个函数还兼任换线候选的筛选器（要快），所以默认值
 * 保持紧凑；播放页里「只是慢」的复查会显式传更长的超时（12s）。
 */
export async function probeLineVerdict(
  proxyUrl: string,
  kind: string,
  timeoutMs = PROBE_DEFAULT_TIMEOUT_MS,
): Promise<LineVerdict> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(proxyUrl, {
      // hls 的 manifest 很小，直接整读（还要看内容）；直链用 Range 避免整片下载。
      headers: kind === "hls" ? undefined : { Range: "bytes=0-0" },
      signal: controller.signal,
    });
    if (!(response.ok || response.status === 405 || response.status === 416)) {
      return "dead";
    }
    if (kind !== "hls") {
      return "ok";
    }
    const text = await response.text();
    // HLS 规范要求首行是 #EXTM3U；JSON / HTML 错误页一律判死。
    if (!/^\s*#EXTM3U/.test(text)) {
      return "dead";
    }
    return await firstSegmentVerdict(text, proxyUrl, controller.signal);
  } catch {
    // 超时 / 连接中断 / 反代未就绪：全都只是「还没回话」，不构成线路失效的证据。
    return "unknown";
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * 布尔版：只回答「能不能确定可播」。
 *
 * 换线候选的筛选口径，`unknown` 一律按不可用处理——切线路要求「确定能出流」，
 * 赌一条没回话的地址没有意义。注意这与播放页的「卡住要不要换走」是**两个
 * 相反方向**的判断：那边只认 `dead`，绝不用超时当证据。
 */
export async function probePlayable(
  proxyUrl: string,
  kind: string,
  timeoutMs = PROBE_DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
  return (await probeLineVerdict(proxyUrl, kind, timeoutMs)) === "ok";
}
