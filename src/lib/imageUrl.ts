/**
 * Cover-image proxy URL builder.
 *
 * TVBox sources embed request headers in `vod_pic` itself, e.g.
 * `https://img3.doubanio.com/p.jpg@Referer=https://api.douban.com/@User-Agent=...`.
 * A WebView2 `<img>` cannot set custom headers, and sending that whole string
 * as `src` yields HTTP 418 (douban hotlink protection). The native client
 * solves this in its image-loading interceptor (`ImgUtil.getUrl` / `VodImages`);
 * ours does it in the Rust local proxy `/image` route, which parses the inline
 * headers and injects them upstream.
 *
 * This module is deliberately pure and has NO Tauri/IPC dependency so it can
 * be unit-tested in plain node. The caller supplies `baseUrl` (from
 * `api.proxyStatus().baseUrl`) and we build `{baseUrl}/image?url={encoded pic}`.
 * The backend owns header parsing; we forward the ORIGINAL string untouched.
 */

/** True when a pic must bypass the proxy: empty, data URI, or non-http scheme. */
export function needsProxy(pic: string | undefined): boolean {
  const value = pic?.trim() ?? "";
  if (!value || value.startsWith("data:")) return false;
  return /^https?:\/\//i.test(value);
}

/**
 * Build the proxied cover URL. Falls back to the original `pic` when the
 * proxy base URL is unavailable or the pic should not be proxied, so a proxy
 * outage degrades to "direct image" instead of breaking every card.
 */
export function buildImageUrl(pic: string | undefined, baseUrl: string | null | undefined): string {
  const value = pic?.trim() ?? "";
  const base = baseUrl?.trim().replace(/\/+$/, "") ?? "";
  if (!needsProxy(value) || !base) return value;
  return `${base}/image?url=${encodeURIComponent(value)}`;
}
