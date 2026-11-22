/**
 * 常量单一真源契约。
 *
 * 业务数值散落在各模块各写一遍时，改一处漏一处会直接造成判定不一致（例如
 * 续播最小位置在 history 与 engine 里各写 3000）。本测试锁死「消费者必须
 * 引用 constants，而不是写裸数字」，同时确认几个同值不同义的常量没有被误合并。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HISTORY_WRITE_THROTTLE_MS,
  PROBE_DEFAULT_TIMEOUT_MS,
  RESUME_MIN_POSITION_MS,
  SHORT_UI_TICK_MS,
  SWITCH_SOURCE_CAP_MS,
} from "../../src/lib/constants";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("playback constants are the single source of truth", () => {
  it("keeps distinct values for same-numbered but different meanings", () => {
    // 5000ms 在历史节流与线路探活里是两件事，不能因为数值相同就合并。
    expect(HISTORY_WRITE_THROTTLE_MS).toBe(5_000);
    expect(PROBE_DEFAULT_TIMEOUT_MS).toBe(5_000);
    expect(RESUME_MIN_POSITION_MS).toBe(3_000);
    expect(SWITCH_SOURCE_CAP_MS).toBe(15_000);
    expect(SHORT_UI_TICK_MS).toBe(500);
  });

  it("makes both resume guard consumers import the shared constant", () => {
    const engine = read("src/hooks/usePlayerEngine.ts");
    const history = read("src/hooks/usePlaybackHistory.ts");
    expect(engine).toContain("RESUME_MIN_POSITION_MS");
    expect(history).toContain("RESUME_MIN_POSITION_MS");
    expect(engine).not.toMatch(/resumeMs <= 3000/);
    expect(history).not.toMatch(/positionMs <= 3000/);
  });

  it("makes switch cap consumers agree on one value", () => {
    const engine = read("src/hooks/usePlayerEngine.ts");
    const machine = read("src/lib/vodSessionMachine.ts");
    expect(engine).toContain("SWITCH_SOURCE_CAP_MS");
    expect(machine).toContain("SWITCH_SOURCE_CAP_MS");
    expect(machine).not.toContain("after: { 15000:");
  });

  it("routes the 500ms UI tick through the constant", () => {
    for (const file of [
      "src/pages/SearchPage.tsx",
      "src/components/player/PlayerStage.tsx",
      "src/hooks/playerPrefsWriter.ts",
      // 播放器两页的轮询已收口到公共 hook，不再各自引用。
      "src/hooks/usePlayerRevive.ts",
    ]) {
      expect(read(file)).toContain("SHORT_UI_TICK_MS");
    }
    for (const file of ["src/pages/PlayerPage.tsx", "src/pages/LivePage.tsx"]) {
      expect(read(file)).toContain("usePlayerRevive");
      expect(read(file)).not.toMatch(/setTimeout\(check, 500\)/);
    }
  });
});
