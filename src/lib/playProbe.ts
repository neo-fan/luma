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
 */
const BAD_SEGMENT_TYPE = /^(?:image\/|text\/html)/i;

/**
 * 取清单里第一条分片，只看响应头判真伪。
 *
 * 不下载分片本体：拿到响应头（Content-Type）立刻 cancel body，成本约一个
 * 往返。刻意不带 `Range`：反代要读到分片头部才能剥离「PNG 头 + TS」伪装，
 * 带 Range 会让它把剥离后的长度算错（实测 PAN1 线路）。
 */
async function firstSegmentLooksReal(
  manifest: string,
  baseUrl: string,
  signal: AbortSignal,
): Promise<boolean> {
  const first = manifest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));
  if (!first) {
    // 没有分片的清单交给 hls.js 自己报错，别在这里判死。
    return true;
  }
  let segmentUrl: string;
  try {
    segmentUrl = new URL(first, baseUrl).toString();
  } catch {
    return true;
  }
  try {
    const response = await fetch(segmentUrl, { signal });
    void response.body?.cancel?.().catch(() => {});
    if (!(response.ok || response.status === 405 || response.status === 416)) {
      // 分片 403/404 = 防盗链或已过期，这条线路同样不可用。
      return false;
    }
    const type = response.headers?.get?.("content-type") ?? "";
    return !BAD_SEGMENT_TYPE.test(type);
  } catch {
    // 被总超时中断 / 取头失败：证据不足，不误杀，交给播放器与看门狗。
    return true;
  }
}

export async function probePlayable(
  proxyUrl: string,
  kind: string,
  timeoutMs = 5000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(proxyUrl, {
      // hls 的 manifest 很小，直接整读（还要看内容）；直链用 Range 避免整片下载。
      headers: kind === "hls" ? undefined : { Range: "bytes=0-0" },
      signal: controller.signal,
    });
    if (!(response.ok || response.status === 405 || response.status === 416)) {
      return false;
    }
    if (kind !== "hls") {
      return true;
    }
    const text = await response.text();
    // HLS 规范要求首行是 #EXTM3U；JSON / HTML 错误页一律判死。
    if (!/^\s*#EXTM3U/.test(text)) {
      return false;
    }
    return await firstSegmentLooksReal(text, proxyUrl, controller.signal);
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}
