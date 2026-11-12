/**
 * 「暂时屏蔽外部播放」的源码契约。
 *
 * 这类开关最容易退化成「只把按钮藏了」：入口没了，但解码失败仍会弹 mpv，
 * 或者错误提示还让用户去点一个不存在的图标。这里锁住四条路径都走同一个
 * `EXTERNAL_PLAY_ENABLED`，并确认后端 command 仍在（改一个布尔值即可恢复）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("external play is temporarily disabled", () => {
  it("has one central switch, currently off", () => {
    const flags = read("src/lib/features.ts");
    expect(flags).toContain("export const EXTERNAL_PLAY_ENABLED = false");
    expect(flags).toContain("PLAY_FAILURE_HINT");
    expect(flags).toContain("EXTERNAL_PLAY_FALLBACK");
  });

  it("does not render the button in the player about card", () => {
    const about = read("src/components/player/PlayerAbout.tsx");
    expect(about).toContain("onPlayExternal?: () => void");
    expect(about).toContain("{onPlayExternal ? (");
    const page = read("src/pages/PlayerPage.tsx");
    expect(page).toContain("EXTERNAL_PLAY_ENABLED ? () => void playExternal() : undefined");
  });

  it("guards both IPC paths: open_external and mpv_play", () => {
    const page = read("src/pages/PlayerPage.tsx");
    expect(page).toContain("if (!EXTERNAL_PLAY_ENABLED)");
    // 早退必须写在 openExternal 调用之前。
    expect(page.indexOf("if (!EXTERNAL_PLAY_ENABLED)")).toBeLessThan(page.indexOf("await api.openExternal"));

    const engine = read("src/hooks/usePlayerEngine.ts");
    expect(engine).toContain("EXTERNAL_PLAY_ENABLED &&");
    expect(engine.indexOf("EXTERNAL_PLAY_ENABLED &&")).toBeLessThan(engine.indexOf(".mpvPlay("));
  });

  it("keeps failure hints consistent with the switch", () => {
    const page = read("src/pages/PlayerPage.tsx");
    const engine = read("src/hooks/usePlayerEngine.ts");
    const stage = read("src/components/player/PlayerStage.tsx");
    expect(page).toContain("PLAY_FAILURE_HINT");
    expect(engine).toContain("PLAY_FAILURE_HINT");
    expect(stage).toContain("EXTERNAL_PLAY_FALLBACK");
    // 关闭期间不能再出现无条件引导用户去用外部播放的硬编码文案。
    expect(page).not.toContain("可尝试外部播放。");
    expect(engine).not.toContain("请使用外部播放。");
  });

  it("keeps the backend commands so restoring is a one-line change", () => {
    const invoke = read("src/lib/invoke.ts");
    expect(invoke).toContain('call("open_external"');
    expect(invoke).toContain('call("mpv_play"');
  });
});
