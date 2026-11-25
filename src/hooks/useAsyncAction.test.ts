/**
 * useAsyncAction 是 React hook，项目没有 renderHook 基建，沿用 usePlayerRevive.test.ts
 * 的源码钉惯例：锁住「ref 判等 + finally 释放 + 四处调用方都收口」三条结构性不变量。
 * 行为层由调用方的真实 IPC 测试（ipcTimeout.test.ts）覆盖「await 必有界」，两者合起来
 * 保证 busy 状态不会永久锁死。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const hook = readFileSync(resolve(root, "src/hooks/useAsyncAction.ts"), "utf8");
const history = readFileSync(resolve(root, "src/pages/HistoryPage.tsx"), "utf8");
const favorites = readFileSync(resolve(root, "src/pages/FavoritesPage.tsx"), "utf8");
const ghProxy = readFileSync(resolve(root, "src/components/settings/GhProxySection.tsx"), "utf8");
const storage = readFileSync(resolve(root, "src/components/settings/StorageSection.tsx"), "utf8");

describe("useAsyncAction: single-lane busy that always releases", () => {
  it("uses a ref for in-flight identity, not the render-time state", () => {
    // 同一帧的连续点击必须看到最新在途 key；用 state 判等于事无补。
    expect(hook).toContain("const runningRef = useRef<TKey | null>(null)");
    expect(hook).toContain("if (runningRef.current !== null)");
  });

  it("releases busy in finally even when fn throws", () => {
    expect(hook).toContain("try {");
    expect(hook).toContain("} finally {");
    expect(hook).toContain("runningRef.current = null;");
    expect(hook).toContain("setBusy(null);");
  });

  it("does not clear a newer action from the finally of an older one", () => {
    expect(hook).toContain("if (equals(runningRef.current, key))");
  });
});

describe("all busy call sites converge on the hook", () => {
  for (const [name, source] of [
    ["HistoryPage", history],
    ["FavoritesPage", favorites],
    ["GhProxySection", ghProxy],
    ["StorageSection", storage],
  ] as const) {
    it(`${name} no longer hand-rolls busy + try/finally`, () => {
      expect(source).toContain("useAsyncAction");
      expect(source).not.toContain("setBusyKey(");
      expect(source).not.toContain("setBusy(\"\"");
    });
  }
});
