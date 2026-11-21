import { describe, expect, it } from "vitest";
import { buildImageUrl, needsProxy, normalizePic } from "./imageUrl";

describe("normalizePic", () => {
  it("upgrades protocol-relative URLs so Tauri's origin cannot swallow them", () => {
    // 生产页面 origin 是 tauri://localhost，`//cdn/x.jpg` 会被解析成 tauri://cdn/x.jpg。
    expect(normalizePic("//static.ztcuc.com/upload/x.jpg")).toBe(
      "https://static.ztcuc.com/upload/x.jpg",
    );
  });

  it("trims whitespace and strips html attribute wrappers", () => {
    expect(normalizePic("  https://img/x.jpg  ")).toBe("https://img/x.jpg");
    expect(normalizePic('"https://img/x.jpg"')).toBe("https://img/x.jpg");
    expect(normalizePic("'https://img/x.jpg'")).toBe("https://img/x.jpg");
    expect(normalizePic("<https://img/x.jpg>")).toBe("https://img/x.jpg");
  });

  it("decodes html entities in scraped query strings", () => {
    expect(normalizePic("https://img/x.jpg?w=1&amp;h=2")).toBe("https://img/x.jpg?w=1&h=2");
    expect(normalizePic("https://img/x.jpg?w=1&#38;h=2")).toBe("https://img/x.jpg?w=1&h=2");
    expect(normalizePic("https://img/x.jpg?q=&quot;a&quot;")).toBe('https://img/x.jpg?q="a"');
  });

  it("keeps empty values empty", () => {
    expect(normalizePic(undefined)).toBe("");
    expect(normalizePic("   ")).toBe("");
  });
});

describe("needsProxy", () => {
  it("proxies http(s) URLs", () => {
    expect(needsProxy("https://img3.doubanio.com/p.jpg")).toBe(true);
    expect(needsProxy("  http://cdn/x.png  ")).toBe(true);
    // Inline @headers are still an http URL -> must be proxied (backend parses them).
    expect(needsProxy("https://img/x.jpg@Referer=https://api.douban.com/@User-Agent=Mozilla%2F5.0")).toBe(true);
  });

  it("bypasses empty / data / relative / non-http schemes", () => {
    expect(needsProxy("")).toBe(false);
    expect(needsProxy("   ")).toBe(false);
    expect(needsProxy(undefined)).toBe(false);
    expect(needsProxy("data:image/png;base64,AAAA")).toBe(false);
    expect(needsProxy("./poster.jpg")).toBe(false);
    expect(needsProxy("http://127.0.0.1:8787/poster.jpg")).toBe(true); // local stub still http
    expect(needsProxy("blob:http://localhost/abc")).toBe(false);
  });

  it("proxies protocol-relative pics after normalization", () => {
    // `//host/x.jpg` 要先归一化成绝对地址再判定：否则落进「非 http」分支被当 src
    // 直用，生产下就成了 tauri://。
    expect(needsProxy("//cdn/x.jpg")).toBe(true);
  });
});

describe("buildImageUrl", () => {
  const base = "http://127.0.0.1:9978";

  it("wraps a plain pic with the /image proxy route and encodes it", () => {
    expect(buildImageUrl("https://img/x.jpg", base)).toBe(
      `http://127.0.0.1:9978/image?url=${encodeURIComponent("https://img/x.jpg")}`,
    );
  });

  it("forwards the WHOLE inline-header string untouched (backend owns parsing)", () => {
    const raw = "https://img3.doubanio.com/p.jpg@Referer=https://api.douban.com/@User-Agent=Mozilla%2F5.0%20(x)";
    const out = buildImageUrl(raw, base);
    expect(out).toBe(`http://127.0.0.1:9978/image?url=${encodeURIComponent(raw)}`);
    // Decoding the query must give back the exact original string.
    expect(decodeURIComponent(out.split("?url=")[1])).toBe(raw);
  });

  it("strips trailing slashes off the base URL", () => {
    expect(buildImageUrl("https://img/x.jpg", "http://127.0.0.1:9978///")).toBe(
      `http://127.0.0.1:9978/image?url=${encodeURIComponent("https://img/x.jpg")}`,
    );
  });

  it("falls back to the original pic when base URL is unavailable", () => {
    const raw = "https://img/x.jpg@Referer=https://h/";
    expect(buildImageUrl(raw, null)).toBe(raw);
    expect(buildImageUrl(raw, "")).toBe(raw);
    expect(buildImageUrl(raw, undefined)).toBe(raw);
  });

  it("does not proxy data/empty/relative pics even when base exists", () => {
    expect(buildImageUrl("data:image/png;base64,AAAA", base)).toBe("data:image/png;base64,AAAA");
    expect(buildImageUrl("", base)).toBe("");
    expect(buildImageUrl("./poster.jpg", base)).toBe("./poster.jpg");
    expect(buildImageUrl(undefined, base)).toBe("");
  });
});
