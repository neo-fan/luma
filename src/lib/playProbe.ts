/**
 * 播放线路探活：在切换前确认「这条地址真的能出流」。
 *
 * 只看 `response.ok` 不够。真实配置里网盘类线路的播放地址是解析接口，例如
 * `http://host/m3u8/pan1.php?token=…m3u8`：服务端解析失败时仍返回 **200**
 * 和 `application/json`（`{"code":201,"msg":"解析失败了","url":""}`），
 * `classify` 又因 query 里带 `m3u8` 把它判成 hls，于是 hls.js 拿到一段 JSON
 * 才报 `manifestParsingError`——错误信息完全指错了方向（实测 py_bubuzhuiju
 * 的 PAN1 线路）。探测阶段先把内容认出来，这条线路就不会被选中。
 */
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
    return /^\s*#EXTM3U/.test(text);
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}
