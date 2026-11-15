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

/**
 * Normalize the raw picture string before it reaches `<img>` or the proxy.
 *
 * Sources are not consistent about the shape of `vod_pic`; all of these show up
 * in real configs and each one breaks a plain `src=`:
 *   * surrounding quotes / angle brackets / whitespace (`" https://x/p.jpg "`),
 *   * protocol-relative URLs (`//cdn.example.com/p.jpg`) — under Tauri the page
 *     origin is `tauri://localhost`, so `//host` resolves to `tauri://host`,
 *   * HTML entities from scraped markup (`p.jpg?w=1&amp;h=2`).
 *
 * Only the URL part is normalized; an inline header suffix (`@Referer=…`)
 * is preserved verbatim because the Rust side owns parsing it.
 */
export function normalizePic(pic: string | undefined): string {
  let value = pic?.trim() ?? "";
  if (!value) return "";
  // Some scrapers keep the surrounding HTML attribute quotes/brackets.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("<") && value.endsWith(">"))
  ) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return "";
  value = value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&");
  // `//cdn/...` is scheme-relative: pick https, which every CDN in these
  // configs supports and which keeps the WebView from resolving it against
  // the app origin.
  if (value.startsWith("//")) {
    value = `https:${value}`;
  }
  return value;
}

/** True when a pic must bypass the proxy: empty, data URI, or non-http scheme. */
export function needsProxy(pic: string | undefined): boolean {
  const value = normalizePic(pic);
  if (!value || value.startsWith("data:")) return false;
  return /^https?:\/\//i.test(value);
}

/**
 * Build the proxied cover URL. Falls back to the original `pic` when the
 * proxy base URL is unavailable or the pic should not be proxied, so a proxy
 * outage degrades to "direct image" instead of breaking every card.
 */
export function buildImageUrl(pic: string | undefined, baseUrl: string | null | undefined): string {
  const value = normalizePic(pic);
  const base = baseUrl?.trim().replace(/\/+$/, "") ?? "";
  if (!needsProxy(value) || !base) return value;
  return `${base}/image?url=${encodeURIComponent(value)}`;
}
