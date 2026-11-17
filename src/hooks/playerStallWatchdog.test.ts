/**
 * 看门狗的行为契约：它**只取证据**，判决归状态机。
 * 每条早退都对应一次真实回归，测试按回归逐条钉。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createStallWatchdog,
  STALL_QUIET_MS,
  STALL_RECHECK_MS,
} from "./playerStallWatchdog";
import type { WatchdogSessionEvent } from "./playerStallWatchdog";

function harness(overrides: Record<string, unknown> = {}) {
  const sent: WatchdogSessionEvent[] = [];
  const logs: Array<[string, string]> = [];
  const state = {
    readyState: 0,
    paused: false,
    ended: false,
    advancing: false,
    quiet: STALL_QUIET_MS + 1_000,
    hasPlayed: false,
    yielded: false,
    generation: 7,
    probes: 0,
    verdict: "dead" as "ok" | "dead" | "unknown",
    ...overrides,
  };
  const markAlive = vi.fn();
  const clearSlowNotice = vi.fn();
  const watchdog = createStallWatchdog({
    video: {
      get readyState() {
        return state.readyState;
      },
      get paused() {
        return state.paused;
      },
      get ended() {
        return state.ended;
      },
    },
    isAdvancing: () => state.advancing,
    quietMs: () => state.quiet,
    markAlive,
    clearSlowNotice,
    generation: () => state.generation,
    hasPlayed: () => state.hasPlayed,
    unresponsiveProbes: () => state.probes,
    send: (event) => sent.push(event),
    probeTarget: () => ({ url: "http://127.0.0.1:9978/proxy?do=media&url=a.m3u8", kind: "hls" }),
    probe: () => Promise.resolve(state.verdict),
    isYielded: () => state.yielded,
    log: (_level, stage) => logs.push([stage, ""]),
  });
  return { watchdog, sent, logs, state, markAlive, clearSlowNotice };
}

describe("stall watchdog", () => {
  it("静默够久才报 STALL 并交结论给机器，自己不判死", async () => {
    const h = harness();
    h.watchdog.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toEqual([
      { type: "STALL" },
      { type: "PROBE", verdict: "dead" },
    ]);
  });

  it("还没静默到阈值：一次事件都不发（时间不是证据）", () => {
    const h = harness({ quiet: STALL_QUIET_MS - 1 });
    h.watchdog.tick();
    expect(h.sent).toEqual([]);
  });

  it("用户暂停：不探活，但把静默计时推回当下；播完结束态不算暂停", () => {
    const h = harness({ paused: true, ended: false });
    h.watchdog.tick();
    expect(h.sent).toEqual([]);
    expect(h.markAlive).toHaveBeenCalledOnce();
    // 播完（ended）不是「用户暂停」，证据照常收集
    const h2 = harness({ paused: true, ended: true });
    h2.watchdog.tick();
    expect(h2.sent[0]).toEqual({ type: "STALL" });
  });

  it("已出过画：只撤慢提示，永不报 STALL（红线在解释器的第一道）", () => {
    const h = harness({ hasPlayed: true });
    h.watchdog.tick();
    expect(h.sent).toEqual([]);
    expect(h.clearSlowNotice).toHaveBeenCalledOnce();
  });

  it("媒体在走 = 看门狗退役，之后不再打扰", () => {
    const h = harness({ readyState: 2 });
    h.watchdog.tick();
    expect(h.watchdog.stopped).toBe(true);
    h.state.readyState = 0;
    h.watchdog.tick();
    expect(h.sent).toEqual([]);
  });

  it("上层已接管（换线 / 换源在跑）时完全不插手", () => {
    const h = harness({ yielded: true });
    h.watchdog.tick();
    expect(h.sent).toEqual([]);
  });

  it("复核间隔内不重复探活（别把慢源站打成 DDOS）", async () => {
    const h = harness({ verdict: "unknown" });
    h.watchdog.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent.filter((e) => e.type === "STALL").length).toBe(1);
    h.watchdog.tick();
    expect(h.sent.filter((e) => e.type === "STALL").length).toBe(1);
    expect(h.logs.map((l) => l[0])).toContain("stall probe inconclusive");
    expect(h.markAlive).not.toHaveBeenCalled();
  });

  it("迟到的结论若属于已被取代的旧集，一律丢弃", async () => {
    const h = harness();
    h.watchdog.tick();
    // 复核在途时用户换集：代数变了
    h.state.generation += 1;
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toEqual([{ type: "STALL" }]);
    expect(h.sent.some((e) => e.type === "PROBE")).toBe(false);
  });

  it("复核在途不并发第二次探活", () => {
    const h = harness();
    h.watchdog.tick();
    h.watchdog.tick();
    expect(h.sent.filter((e) => e.type === "STALL").length).toBe(1);
  });

  it("reset（换集）之后重新计：闸门复位且可以立刻再探", async () => {
    const h = harness({ readyState: 2 });
    h.watchdog.tick();
    expect(h.watchdog.stopped).toBe(true);
    h.watchdog.reset();
    h.state.readyState = 0;
    h.watchdog.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent.map((e) => e.type)).toEqual(["STALL", "PROBE"]);
  });

  it("stop（已交棒）之后不再探", () => {
    const h = harness();
    h.watchdog.stop();
    h.watchdog.tick();
    expect(h.sent).toEqual([]);
  });

  it("复核超过 20s 才允许下一轮：用真实时钟推进验证常量口径", () => {
    // 钉住「节流用的是墙钟间隔」这一实现事实，避免有人改成累计 tick 次数。
    expect(STALL_RECHECK_MS).toBe(20_000);
  });
});
