/**
 * 点播 ↔ 直播常驻层切换契约。
 *
 * 两个播放器共用一个全局唯一守卫：创建一方会硬停另一方的 <video>。点播页已有
 * revive（发现自己的实例被摘掉就重新解析），直播页必须对齐，否则从点播回直播
 * 只剩选台列表、画面黑屏且没有控件。这里用源码不变量防止 revive 被删掉。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("live handoff revives a hard-stopped player", () => {
  it("drives revive from the registry's explicit displacement signal", () => {
    const live = read("src/pages/LivePage.tsx");
    const vod = read("src/pages/PlayerPage.tsx");
    const hook = read("src/hooks/usePlayerRevive.ts");
    const registry = read("src/lib/playerRegistry.ts");
    const engine = read("src/hooks/usePlayerEngine.ts");

    // 状态源是守卫的明确通知，不是轮询 DOM 猜 src。
    expect(registry).toContain("previous.onDisplaced?.()");
    expect(engine).toContain("registerPlayer(hardStop, () => onDisplacedRef.current?.())");
    expect(hook).toContain("onDisplaced");
    expect(hook).not.toContain("querySelector");
    expect(hook).not.toContain("setTimeout");
    for (const source of [live, vod]) {
      expect(source).toContain('import { usePlayerRevive } from "../hooks/usePlayerRevive"');
      expect(source).toContain("usePlayerRevive({");
      expect(source).toContain("onDisplaced,");
      expect(source).not.toContain("const lastReviveAt = useRef(0);");
    }
    // 恢复动作各页不同：直播重解析当前频道，点播带进度快照重载。
    expect(live).toContain("revive: () => reloadRef.current?.()");
    expect(vod).toContain("lastMediaRef.current.positionMs");
  });

  it("wires both active flags into the persistent live host", () => {
    const shell = read("src/AppShell.tsx");
    expect(shell).toContain("vodActive={isPlayerRoute}");
    expect(shell).toContain("liveActive={isLiveRoute}");
    expect(shell).toContain('className={isLiveRoute ? "live-host" : "live-host is-idle"}');
  });
});
