/**
 * 看门狗判决的纯函数契约（从 usePlayerEngine 抽出，2026-11-16）。
 *
 * 这些规则都是「慢 ≠ 死」的产品判断，改动会直接决定用户会不会看到
 * 「正播着被自动切走」或「坏源永远不跳」——所以逐条钉死，而不是只测语法。
 */
import { describe, expect, it } from "vitest";
import { decideWatchdogVerdict } from "./watchdogVerdict";

const LIMIT = 3;
const base = { limit: LIMIT, hasPlayed: false, isLive: false };

describe("watchdog verdict", () => {
  it("never hands over the line once the video has actually played", () => {
    // 出画后所有卡顿按网络抖动处理：换线交给用户手动决定。
    const r = decideWatchdogVerdict({ ...base, verdict: "dead", hasPlayed: true, unresponsiveProbes: 9 });
    expect(r.action).toBe("notice");
    expect(r.unresponsiveProbes).toBe(9);
  });

  it("treats a probe that got playlist + segment as merely slow", () => {
    const r = decideWatchdogVerdict({ ...base, verdict: "ok", unresponsiveProbes: 2 });
    expect(r.action).toBe("stay");
    expect(r.unresponsiveProbes).toBe(0);
  });

  it("fails over immediately on an explicit dead verdict", () => {
    // 4xx / 非 m3u8 / 占位图：一次就是证据，不等累计。
    const r = decideWatchdogVerdict({ ...base, verdict: "dead", unresponsiveProbes: 0 });
    expect(r.action).toBe("dead");
  });

  it("keeps waiting on inconclusive probes until the threshold", () => {
    // 慢源冷启动必然超时：单次 unknown 永远不是证据。
    let probes = 0;
    for (let round = 1; round <= LIMIT - 1; round += 1) {
      const r = decideWatchdogVerdict({ ...base, verdict: "unknown", unresponsiveProbes: probes });
      probes = r.unresponsiveProbes;
      expect(r.action).toBe("notice");
      expect(probes).toBe(round);
    }
    const last = decideWatchdogVerdict({ ...base, verdict: "unknown", unresponsiveProbes: probes });
    expect(last.action).toBe("dead");
    expect(last.unresponsiveProbes).toBe(LIMIT);
  });

  it("still returns dead when the counter is already at the threshold", () => {
    // 调用方若在阈值处没清零（异常路径），判决不能反过来变回 notice。
    const r = decideWatchdogVerdict({ ...base, verdict: "unknown", unresponsiveProbes: LIMIT });
    expect(r.action).toBe("dead");
    expect(r.unresponsiveProbes).toBe(LIMIT + 1);
  });

  it("applies the same three-state rules to live streams", () => {
    // 直播与点播共用判决（2026-11 基线）；isLive 只是输入留痕。
    expect(decideWatchdogVerdict({ ...base, verdict: "ok", isLive: true, unresponsiveProbes: 2 }).action).toBe("stay");
    expect(decideWatchdogVerdict({ ...base, verdict: "dead", isLive: true, unresponsiveProbes: 0 }).action).toBe("dead");
    expect(
      decideWatchdogVerdict({ ...base, verdict: "unknown", isLive: true, unresponsiveProbes: LIMIT - 1 }).action,
    ).toBe("dead");
  });
});
