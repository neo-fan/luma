import { setup, assign, type ActorRefFrom } from "xstate";
import type { LineVerdict } from "./playProbe";

/**
 * 直播会话状态机。
 *
 * 与点播分开建模：没有剧集与「下一集」，换台是一次全新 LOAD，换线路是用新地址
 * 重连，判死之后是换线路而不是换源。共享 `sessionId` / `hasPlayed` /
 * `failover*` 字段，`usePlayerEngine` 用同一组读接口按模式取真源。
 */

/** 探活结论词汇直接用 `playProbe.LineVerdict`。 */
export type LiveVerdict = LineVerdict;

/** 判死原因（与点播机器同一分层：机器说为什么，文案归 `lib/sessionFailover.ts`）。 */
export type { FailoverCause } from "./sessionFailover";
import type { FailoverCause } from "./sessionFailover";

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
  | { type: "FAILED"; cause: FailoverCause; detail?: string };

export interface LiveSessionContext {
  sessionId: number;
  targetUrl: string;
  /** 当前线路序号（换线路时更新），供控制栏「线路 i/N」用。 */
  lineIndex: number;
  hasPlayed: boolean;
  unresponsiveProbes: number;
  /** 进入 `recovering` 时携带的判死原因，解释器在 `requestLineSwitch` 里读。 */
  failoverCause: FailoverCause | null;
  failoverDetail: string;
}

/** unknown 累计到几次算确认失效。 */
export const LIVE_UNRESPONSIVE_LIMIT = 3;

const initialContext: LiveSessionContext = {
  sessionId: 0,
  targetUrl: "",
  lineIndex: 0,
  hasPlayed: false,
  unresponsiveProbes: 0,
  failoverCause: null,
  failoverDetail: "",
};

export const liveSessionMachine = setup({
  types: { context: {} as LiveSessionContext, events: {} as LiveSessionEvent },
  guards: {
    /** 出过画之后不再自动换线路。 */
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
      failoverCause: () => null,
      failoverDetail: () => "",
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
    failoverProbeDead: assign({
      failoverCause: () => "probeDead" as const,
      failoverDetail: () => "",
    }),
    failoverUnresponsive: assign({
      failoverCause: () => "probeUnresponsive" as const,
      failoverDetail: () => "",
    }),
    failoverFromEvent: assign({
      failoverCause: ({ event }) => (event.type === "FAILED" ? event.cause : null),
      failoverDetail: ({ event }) => (event.type === "FAILED" ? (event.detail ?? "") : ""),
    }),
    // 副作用发起点：实现由解释器用 `machine.provide({ actions })` 注入。
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
      on: {
        ATTACHED: "buffering",
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        FAILED: { target: "recovering", actions: "failoverFromEvent" },
      },
    },
    buffering: {
      on: {
        MEDIA_ALIVE: { target: "playing", actions: "markPlayed" },
        FRAG_GROWTH: { actions: "resetProbe" },
        STALL: { target: "probing", guard: "notPlayed" },
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        FAILED: { target: "recovering", actions: "failoverFromEvent" },
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
        FAILED: { target: "recovering", actions: "failoverFromEvent" },
      },
    },
    probing: {
      on: {
        PROBE: [
          {
            guard: "isDead",
            target: "recovering",
            actions: ["incrementProbe", "failoverProbeDead"],
          },
          {
            guard: "isUnknownExhausted",
            target: "recovering",
            actions: ["incrementProbe", "failoverUnresponsive"],
          },
          {
            guard: "isUnknown",
            target: "playing",
            actions: "incrementProbe",
          },
          {
            guard: "isOk",
            target: "playing",
            actions: "resetProbe",
          },
        ],
        MEDIA_ALIVE: { target: "playing", actions: "resetProbe" },
        FRAG_GROWTH: { target: "playing", actions: "resetProbe" },
        FAILED: { target: "recovering", actions: ["incrementProbe", "failoverFromEvent"] },
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
        // 复核在途时手动换线：本轮结论作废。
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
      on: {
        LOAD: { target: "tuning", actions: ["setTarget", "bumpSession"] },
      },
    },
  },
});

export type LiveSessionActor = ActorRefFrom<typeof liveSessionMachine>;
