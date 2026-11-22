/**
 * 封面取图链路的源码契约：缓存首帧、直连兜底、骨架静止。
 *
 * 2026-11-15 用户反复报「封面一直在闪烁」，根因有三层，都被这里钉住：
 *  1. 代理端口只存在于异步 Promise 里 → 每张新卡首帧只能渲染占位符，等
 *     `proxy_status` 回来再换成 `<img>`，那一帧就是一次闪。现在把端口缓存到
 *     `cachedProxyBase`，渲染期同步拼地址。
 *  2. 已解码过的图重挂载时会重新进 loading → 骨架再闪一次。现在用
 *     `LOADED_SRC` 跳过。
 *  3. 骨架用扫光动画表达「在取图」，聚合搜索一屏十几张同时扫光 → 观感就是
 *     一直在闪。现在骨架是静态底色。
 *
 * 合并自原来的 imageCache.test.ts / posterFallback.test.ts：同一份 hook 的两组
 * 断言放在一处，缓存上限只守「有界」，不锁具体数值。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { blockAfter } from "./readSource";
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

  it("bounds both caches instead of growing without limit", () => {
    expect(hook).toContain("MAX_RESOLVED_SRC");
    expect(hook).toContain("MAX_LOADED_SRC");
  });

  it("keeps the loading skeleton still", () => {
    const css = readCss();
    const block = blockAfter(css, ".vod-card__skeleton {", "}", "skeleton rule");
    expect(block).toContain("background: var(--panel-sunken)");
    expect(block).not.toContain("animation");
    expect(css).not.toContain("@keyframes vod-skeleton");
  });
});

describe("封面加载的兜底策略", () => {
  it("代理失败后直连重试一次，再失败才落入首字占位", () => {
    // 上游走 Rust /image；网关/TLS 问题时本地代理 502，<img> 直连往往能拿到。
    expect(hook).toContain("directRetried");
    expect(hook).toMatch(/src !== value/);
    expect(hook).toContain("setSrc(value)");
    expect(hook).toContain("setBroken(true)");
  });

  it("每个 pic 只重试一次，避免 502 与直连来回抖动", () => {
    expect(hook).toMatch(/directRetried\.current = false/);
    expect(hook).toMatch(/if \(!directRetried\.current/);
    expect(hook).toContain("directRetried.current = true");
  });
});
