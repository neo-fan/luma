import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const hook = readFileSync(resolve(root, "src/hooks/usePlayerRevive.ts"), "utf8");
const registry = readFileSync(resolve(root, "src/lib/playerRegistry.ts"), "utf8");

/**
 * 这个契约只做源码级检查： HOOK 是 React 内部状态机，行为测试需要 renderHook
 * 基建；这里锁死「通知 + active 记账 + 不轮询 DOM」三条结构性不变量，足以防止
 * 回退到轮询或丢掉后台场景。
 */
describe("player revive is event-driven, not DOM polling", () => {
  it("guard notifies the displaced player explicitly", () => {
    expect(registry).toContain("previous.onDisplaced?.()");
    expect(registry).toContain("registerPlayer(");
  });

  it("revives immediately when displaced in foreground", () => {
    expect(hook).toContain("if (activeRef.current)");
    expect(hook).toContain("reviveRef.current()");
  });

  it("records displacement in background and revives on re-activation", () => {
    expect(hook).toContain("pendingRef.current = true");
    expect(hook).toMatch(/if \(active && pendingRef\.current\)/);
    expect(hook).toContain("}, [active])");
  });

  it("never polls the DOM to guess player state", () => {
    expect(hook).not.toContain("querySelector");
    expect(hook).not.toContain("setTimeout");
    expect(hook).not.toContain("currentSrc");
  });

  it("ignores notifications after unmount", () => {
    expect(hook).toContain("aliveRef.current = false");
    expect(hook).toContain("if (!aliveRef.current)");
  });
});
