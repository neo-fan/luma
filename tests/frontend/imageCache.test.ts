/**
 * 封面取图链路的缓存契约。
 *
 * 2026-11-15 用户反复报「封面一直在闪烁」，根因有三层，都被这里钉住：
 *  1. 代理端口只存在于异步 Promise 里 → 每张新卡首帧只能渲染占位符，等
 *     `proxy_status` 回来再换成 `<img>`，那一帧就是一次闪。现在把端口缓存到
 *     `cachedProxyBase`，渲染期同步拼地址。
 *  2. 已解码过的图重挂载时会重新进 loading → 骨架再闪一次。现在用
 *     `LOADED_SRC` 跳过。
 *  3. 骨架用扫光动画表达「在取图」，聚合搜索一屏十几张同时扫光 → 观感就是
 *     一直在闪。现在骨架是静态底色。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

const root = resolve(__dirname, "../..");
const hook = readFileSync(resolve(root, "src/hooks/useProxiedImage.ts"), "utf8");

describe("proxied image cache", () => {
  it("keeps the proxy base synchronously for the first paint", () => {
    expect(hook).toContain("let cachedProxyBase: string | null = null;");
    expect(hook).toContain("if (!cachedProxyBase) return null;");
    expect(hook).toContain("const built = buildImageUrl(value, cachedProxyBase);");
    expect(hook).toContain("cachedProxyBase = base;");
    expect(hook).toContain("useState<string | null>(() => resolveNow(");
  });

  it("does not re-flash covers that are already decoded", () => {
    expect(hook).toContain("const LOADED_SRC = new Set<string>();");
    expect(hook).toContain("setLoading(!LOADED_SRC.has(src));");
    expect(hook).toContain("if (src) rememberLoaded(src);");
  });

  it("sizes the cache for one full aggregate search", () => {
    expect(hook).toContain("const MAX_RESOLVED_SRC = 1200;");
    expect(hook).toContain("const MAX_LOADED_SRC = 1200;");
  });

  it("keeps the loading skeleton still", () => {
    const css = readCss();
    const start = css.indexOf(".vod-card__skeleton {");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toContain("background: var(--panel-sunken)");
    expect(block).not.toContain("animation");
    expect(css).not.toContain("@keyframes vod-skeleton");
  });
});
