import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const hook = readFileSync(new URL("../../src/hooks/useProxiedImage.ts", import.meta.url), "utf8");

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
