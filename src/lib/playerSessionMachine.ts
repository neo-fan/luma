import { setup, assign, type ActorRefFrom } from "xstate";

/**
 * 播放会话状态机（2.0.0 内核重构的地基）。
 *
 * 把原先散落在 `usePlayerEngine` 一个 1300 行 effect 里的 ~28 个可变闭包变量，
 * 收敛成一个**显式、可脱离 DOM 单测**的模型。动机：换集 / 续播 / 音量倍速偏好
 * 这一簇本周出过 4 个 bug，根因都是「状态没被枚举、只被散落」——`switchGeneration`
 * / `fadeDone` / `volumeFadeUntil` / `rateReadyAt` / `resumeCancelled` 各自表达
 * 同一批状态，关系靠注释维持。这里给它们一个真源。
 *
 * 纯度高：只做 `(state, event) -> (nextState, context)` + 命名动作描述符，**不碰
 * DOM、不 import ArtPlayer**。副作用（建解码器、淡音量、落盘偏好、换线）由
 * `usePlayerEngine` 作为解释器执行动作名。于是转换表能在 node 下逐条断言——这正是
 * 内核此前缺的行为测试网。
 *
 * 时间窗（音量 ramp / 初始化静默）本质是墙钟问题，留在解释器；机器只跟踪离散量
 * （`fadeDone`、`sessionId`、`resumeIntent`、`unresponsiveProbes`）。
 */

export type ProbeVerdict = "dead" | "unknown" | "alive";

export type PlayerSessionEvent =
  | { type: "LOAD"; url: string }
  | { type: "RESOLVED"; url: string }
  | { type: "ATTACHED" }
  | { type: "MEDIA_ALIVE" }
  | { type: "FRAG_GROWTH" }
  | { type: "STALL" }
  | { type: "PROBE"; verdict: ProbeVerdict }
  | { type: "USER_SWITCH"; url: string; resumeIntent: boolean }
  | { type: "AUTOPLAY_BLOCKED" }
  | { type: "FADE_DONE" }
  | { type: "FAILED"; reason: string }
  | { type: "RECOVERED" };

export interface PlayerSessionContext {
  /** 会话身份：每次换集/重载自增，取代散落的 `switchGeneration` 代数比较。 */
  sessionId: number;
  targetUrl: string;
  /** 本会话是否已出过画（首帧）。 */
  hasPlayed: boolean;
  /** 换集前是否在播——决定新集要不要自动续播。 */
  resumeIntent: boolean;
  /** 「未知」探测累计次数，达阈值判死换线。 */
  unresponsiveProbes: number;
  /** 音量淡入是否完成（取代 `fadeDone`）。 */
  fadeDone: boolean;
  /** 本轮切换是否被用户暂停打断过续播（取代 `resumeCancelled`）。 */
  resumeAborted: boolean;
}

/** 「未知」探测累计到几次判死换线（对齐内核 STALL_UNRESPONSIVE_LIMIT）。 */
export const UNRESPONSIVE_LIMIT = 3;

const initialContext: PlayerSessionContext = {
  sessionId: 0,
  targetUrl: "",
  hasPlayed: false,
  resumeIntent: false,
  unresponsiveProbes: 0,
  fadeDone: false,
  resumeAborted: false,
};

export const playerSessionMachine = setup({
  types: { context: {} as PlayerSessionContext, events: {} as PlayerSessionEvent },
  guards: {
    wantsResume: ({ context }) => context.resumeIntent,
    canPersistVolume: ({ context }) => context.fadeDone,
    isDead: ({ event }) => event.type === "PROBE" && event.verdict === "dead",
    isUnknownExhausted: ({ context, event }) =>
      event.type === "PROBE" &&
      event.verdict === "unknown" &&
      context.unresponsiveProbes + 1 >= UNRESPONSIVE_LIMIT,
    isUnknown: ({ event }) => event.type === "PROBE" && event.verdict === "unknown",
    isAlive: ({ event }) => event.type === "PROBE" && event.verdict === "alive",
  },
  actions: {
    bumpSession: assign({
      sessionId: ({ context }) => context.sessionId + 1,
      hasPlayed: () => false,
      unresponsiveProbes: () => 0,
      fadeDone: () => false,
      resumeAborted: () => false,
    }),
    setTarget: assign({ targetUrl: ({ event }) => (event as { url: string }).url }),
    setResumeIntent: assign({
      resumeIntent: ({ event }) => (event as { resumeIntent: boolean }).resumeIntent,
    }),
    markPlayed: assign({ hasPlayed: () => true, unresponsiveProbes: () => 0 }),
    completeFade: assign({ fadeDone: () => true }),
    incrementProbe: assign({
      unresponsiveProbes: ({ context }) => context.unresponsiveProbes + 1,
    }),
    resetProbe: assign({ unresponsiveProbes: () => 0 }),
    markResumeAborted: assign({ resumeAborted: () => true }),
    // 副作用动作名：由解释器执行，机器不实现（保持可单测、无 DOM 依赖）。
    acquireDecoder: () => undefined,
    releaseDecoders: () => undefined,
    showSpinner: () => undefined,
    hideSpinner: () => undefined,
    pinControls: () => undefined,
    unpinControls: () => undefined,
    resumePlayback: () => undefined,
    cancelResume: () => undefined,
    navigateFailover: () => undefined,
  },
}).createMachine({
  id: "playerSession",
  initial: "idle",
  context: initialContext,
  states: {
    idle: {
      on: { LOAD: { target: "resolving", actions: ["setTarget", "bumpSession"] } },
    },
    resolving: {
      on: {
        RESOLVED: { target: "attaching", actions: "setTarget" },
        FAILED: "failed",
      },
    },
    attaching: {
      entry: "acquireDecoder",
      on: {
        ATTACHED: { target: "buffering", actions: "showSpinner" },
        FAILED: "recovering",
      },
    },
    buffering: {
      on: {
        MEDIA_ALIVE: {
          target: "playing",
          actions: [
            "markPlayed",
            "hideSpinner",
            "unpinControls",
            { type: "resumePlayback", guard: "wantsResume" },
          ],
        },
        STALL: "probing",
        FAILED: "recovering",
      },
    },
    playing: {
      on: {
        STALL: "probing",
        FRAG_GROWTH: { actions: "resetProbe" },
        FADE_DONE: { actions: "completeFade" },
        USER_SWITCH: {
          target: "switching",
          actions: ["setTarget", "setResumeIntent", "bumpSession", "showSpinner", "pinControls"],
        },
        FAILED: "recovering",
      },
    },
    probing: {
      on: {
        PROBE: [
          { guard: "isDead", target: "recovering", actions: "incrementProbe" },
          { guard: "isUnknownExhausted", target: "recovering", actions: "incrementProbe" },
          { guard: "isUnknown", target: "playing", actions: "incrementProbe" },
          { guard: "isAlive", target: "playing", actions: "resetProbe" },
        ],
        MEDIA_ALIVE: { target: "playing", actions: "resetProbe" },
        FRAG_GROWTH: { target: "playing", actions: "resetProbe" },
      },
    },
    switching: {
      on: {
        MEDIA_ALIVE: {
          target: "playing",
          actions: [
            "markPlayed",
            "hideSpinner",
            "unpinControls",
            { type: "resumePlayback", guard: "wantsResume" },
          ],
        },
        AUTOPLAY_BLOCKED: {
          target: "playing",
          actions: ["hideSpinner", "markResumeAborted", "cancelResume"],
        },
        STALL: "probing",
        FAILED: "recovering",
      },
    },
    recovering: {
      entry: "navigateFailover",
      on: {
        RECOVERED: { target: "resolving", actions: "bumpSession" },
        FAILED: "failed",
      },
    },
    failed: {
      entry: "releaseDecoders",
      on: {
        LOAD: { target: "resolving", actions: ["setTarget", "bumpSession"] },
      },
    },
  },
});

export type PlayerSessionActor = ActorRefFrom<typeof playerSessionMachine>;
