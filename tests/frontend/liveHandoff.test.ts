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
  it("shares one revive implementation across both pages", () => {
    const live = read("src/pages/LivePage.tsx");
    const vod = read("src/pages/PlayerPage.tsx");
    const hook = read("src/hooks/usePlayerRevive.ts");

    // 判定只留一份：两页不再各自复制轮询，避免一边改了另一边忘了。
    expect(hook).toContain('video.getAttribute("src") || video.currentSrc');
    expect(hook).toContain("const killed = Boolean(video) || tries >= MAX_PROBE_TRIES;");
    expect(hook).toContain("REVIVE_COOLDOWN_MS");
    for (const source of [live, vod]) {
      expect(source).toContain('import { usePlayerRevive } from "../hooks/usePlayerRevive"');
      expect(source).toContain("usePlayerRevive({");
      expect(source).not.toContain("const lastReviveAt = useRef(0);");
    }
    // 直播用 liveActive / reloadRef，点播用 active / reload，入口条件与恢复动作
    // 必须与各自页面的活跃信号一致，不能照抄错变量。
    expect(live).toContain("active: liveActive");
    expect(live).toContain("revive: () => reloadRef.current?.()");
    expect(vod).toContain("active,");
    expect(vod).toContain("lastMediaRef.current.positionMs");
  });

  it("wires both active flags into the persistent live host", () => {
    const shell = read("src/AppShell.tsx");
    expect(shell).toContain("vodActive={isPlayerRoute}");
    expect(shell).toContain("liveActive={isLiveRoute}");
    expect(shell).toContain('className={isLiveRoute ? "live-host" : "live-host is-idle"}');
  });
});
