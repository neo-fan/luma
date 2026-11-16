import { setup, assign, type ActorRefFrom } from "xstate";
import type { LineVerdict } from "./playProbe";

/**
 * 直播会话状态机（与点播 `vodSessionMachine` 分开建模）。
 *
 * 直播与点播生命周期不同，不能共用一台机器（2026-11-16 用户纠正）：
 * - 无剧集、无「下一集」、无续播意图（直播就是放当前直播流）；
 * - 换台 = 一次全新 LOAD（`playUrl` 变 → 内核重建）；换线路 = 用新地址重连；
 * - 卡顿看门狗判死后是「换线路」（同频道下一条流），不是点播的「换源」；
 * - 超时/缓冲参数也不同（在解释器侧，不在这台机器里）。
 *
 * 与点播机器共享 `sessionId` / `hasPlayed` 两个上下文字段，好让 `usePlayerEngine`
 * 用同一组读接口（`sessionGen` / `sessionHasPlayed`）按模式取真源。
 */

/** 与点播同一套探活词汇，直接用 `playProbe.LineVerdict`（不再自造 `alive`）。 */
export type LiveVerdict = LineVerdict;

export type LiveSessionEvent =
  | { type: "LOAD"; url: string; lineIndex?: number }
  | { type: "RESOLVED"; url: string }
  | { type: "ATTACHED" }
  | { type: "MEDIA_ALIVE" }
  /** 反代字节在涨（极慢但活着）：复位 unknown 累计。 */
  | { type: "FRAG_GROWTH" }
  | { type: "STALL" }
  | { type: "PROBE"; verdict: LiveVerdict }
  | { type: "LINE_SWITCH"; url: string; lineIndex: number }
  | { type: "FAILED"; reason: string };

export interface LiveSessionContext {
  sessionId: number;
  targetUrl: string;
  /** 当前线路序号（换线路时更新），供控制栏「线路 i/N」用。 */
  lineIndex: number;
  hasPlayed: boolean;
  unresponsiveProbes: number;
}

/** 与点播同一条判决：**这里唯一真源**，解释器不再自带阈值。 */
export const LIVE_UNRESPONSIVE_LIMIT = 3;

const initialContext: LiveSessionContext = {
  sessionId: 0,
  targetUrl: "",
  lineIndex: 0,
  hasPlayed: false,
  unresponsiveProbes: 0,
};

export const liveSessionMachine = setup({
  types: { context: {} as LiveSessionContext, events: {} as LiveSessionEvent },
  guards: {
    /** 出过画就再也不自动换线（与点播机器同一条红线，写进转换表而非解释器的 if）。 */
    notPlayed: ({ context }) => !context.hasPlayed,
    isDead: ({ event }) => event.type === "PROBE" && event.verdict === "dead",
    isUnknownExhausted: ({ context, event }) =>
      event.type === "PROBE" &&
      event.verdict === "unknown" &&
      context.unresponsiveProbes + 1 >= LIVE_UNRESPONSIVE_LIMIT,
    isUnknown: ({ event }) => event.type === "PROBE" && event.verdict === "unknown",
    isOk: ({ event }) => event.type === "PROBE" && event.verdict === "ok",
  },
  actions: {
    bumpSession: assign({
      sessionId: ({ context }) => context.sessionId + 1,
      hasPlayed: () => false,
      unresponsiveProbes: () => 0,
    }),
    setTarget: assign({
      targetUrl: ({ event }) => (event as { url: string }).url,
      lineIndex: ({ event, context }) =>
        (event as { lineIndex?: number }).lineIndex ?? context.lineIndex,
    }),
    markPlayed: assign({ hasPlayed: () => true, unresponsiveProbes: () => 0 }),
    incrementProbe: assign({
      unresponsiveProbes: ({ context }) => context.unresponsiveProbes + 1,
    }),
    resetProbe: assign({ unresponsiveProbes: () => 0 }),
    // 副作用动作名：由解释器执行。
    acquireDecoder: () => undefined,
    releaseDecoders: () => undefined,
    showSpinner: () => undefined,
    hideSpinner: () => undefined,
    requestLineSwitch: () => undefined,
  },
}).createMachine({
  id: "liveSession",
  initial: "idle",
  context: initialContext,
  states: {
    idle: {
      on: { LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] } },
    },
    tuning: {
      on: {
        RESOLVED: { target: "connecting", actions: "setTarget" },
        // 换台/换线在解析途中又来一次：直接换目标。
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        FAILED: "failed",
      },
    },
    connecting: {
      entry: "acquireDecoder",
      on: {
        ATTACHED: { target: "buffering", actions: "showSpinner" },
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        FAILED: "recovering",
      },
    },
    buffering: {
      on: {
        MEDIA_ALIVE: { target: "playing", actions: ["markPlayed", "hideSpinner"] },
        FRAG_GROWTH: { actions: "resetProbe" },
        STALL: { target: "probing", guard: "notPlayed" },
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        FAILED: "recovering",
      },
    },
    playing: {
      on: {
        STALL: { target: "probing", guard: "notPlayed" },
        FRAG_GROWTH: { actions: "resetProbe" },
        // 换台 = 全新一次播放尝试。
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        // 手动换线路。
        LINE_SWITCH: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        FAILED: "recovering",
      },
    },
    probing: {
      on: {
        PROBE: [
          { guard: "isDead", target: "recovering", actions: "incrementProbe" },
          { guard: "isUnknownExhausted", target: "recovering", actions: "incrementProbe" },
          { guard: "isUnknown", target: "playing", actions: "incrementProbe" },
          { guard: "isOk", target: "playing", actions: "resetProbe" },
        ],
        MEDIA_ALIVE: { target: "playing", actions: "resetProbe" },
        FRAG_GROWTH: { target: "playing", actions: "resetProbe" },
        FAILED: { target: "recovering", actions: "incrementProbe" },
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        // 复核在途时用户手动换线：本轮结论作废。
        LINE_SWITCH: { target: "tuning", actions: ["setTarget", "bumpSession"] },
      },
    },
    recovering: {
      // 直播的「恢复」= 换下一条线路重连；LivePage 换线时发 LINE_SWITCH/LOAD 驱动。
      entry: "requestLineSwitch",
      on: {
        LINE_SWITCH: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        FAILED: "failed",
      },
    },
    failed: {
      entry: "releaseDecoders",
      on: {
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
      },
    },
  },
});

export type LiveSessionActor = ActorRefFrom<typeof liveSessionMachine>;
