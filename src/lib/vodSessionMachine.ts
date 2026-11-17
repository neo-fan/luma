import { setup, assign, type ActorRefFrom } from "xstate";
import type { LineVerdict } from "./playProbe";

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

/**
 * 探活结论直接用 `playProbe.LineVerdict`，机器不自造词汇——解释器不必再翻译
 * 一层 `ok`↔`alive`（那种翻译正是「同一套契约两份实现」的产地）。
 */
export type ProbeVerdict = LineVerdict;

/**
 * 「这条线判死了」的离散原因。机器只说**为什么**，具体文案 / 日志 stage /
 * 撤不撤海报由解释器决定（见 `lib/sessionFailover.ts`）——产品文案不进模型。
 */
export type { FailoverCause } from "./sessionFailover";
import type { FailoverCause } from "./sessionFailover";

export type VodSessionEvent =
  | { type: "LOAD"; url: string }
  | { type: "RESOLVED"; url: string }
  | { type: "ATTACHED" }
  | { type: "MEDIA_ALIVE" }
  /** 反代字节在涨（极慢源也是硬证据）：把 unknown 累计清零。 */
  | { type: "FRAG_GROWTH" }
  | { type: "STALL" }
  | { type: "PROBE"; verdict: ProbeVerdict }
  | { type: "USER_SWITCH"; url: string; resumeIntent: boolean }
  | { type: "AUTOPLAY_BLOCKED" }
  | { type: "FADE_DONE" }
  | { type: "FAILED"; cause: FailoverCause; detail?: string };

export interface VodSessionContext {
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
  /**
   * 进入 `recovering` 时携带的判死原因（离开 recovering 开新会话即清空）。
   * 解释器在 `navigateFailover` 实现里读它来决定文案与日志口径。
   */
  failoverCause: FailoverCause | null;
  /** 与 `failoverCause` 同行的原始细节（hls 错误名等），只用于日志与提示。 */
  failoverDetail: string;
}

/**
 * 连续多少次「复核也拿不到任何响应」才算确认失效。**这里是唯一真源**：
 * 解释器不再自带常量，也不另有判决模块——单次超时永远不是证据（慢源冷启必然
 * 超时），但同一地址连续三次、跨 60s 连一个字节都不回，就不是「慢」了；
 * 明确失败（4xx / 非 m3u8 / 占位图）一次就够。
 */
export const UNRESPONSIVE_LIMIT = 3;

const initialContext: VodSessionContext = {
  sessionId: 0,
  targetUrl: "",
  hasPlayed: false,
  resumeIntent: false,
  unresponsiveProbes: 0,
  fadeDone: false,
  resumeAborted: false,
  failoverCause: null,
  failoverDetail: "",
};

export const vodSessionMachine = setup({
  types: { context: {} as VodSessionContext, events: {} as VodSessionEvent },
  guards: {
    wantsResume: ({ context }) => context.resumeIntent,
    canPersistVolume: ({ context }) => context.fadeDone,
    /**
     * 「出过画就再也不自动换线」是产品红线（用户明确要求）。此前它只写在解释器
     * `stallCheck` 的一个 `if` 里——机器收到 dead 照样进 recovering。现在把它写进
     * 转换表：机器层面就不可能判死，删掉那个 `if` 也不会破。
     */
    notPlayed: ({ context }) => !context.hasPlayed,
    isDead: ({ event }) => event.type === "PROBE" && event.verdict === "dead",
    isUnknownExhausted: ({ context, event }) =>
      event.type === "PROBE" &&
      event.verdict === "unknown" &&
      context.unresponsiveProbes + 1 >= UNRESPONSIVE_LIMIT,
    isUnknown: ({ event }) => event.type === "PROBE" && event.verdict === "unknown",
    isOk: ({ event }) => event.type === "PROBE" && event.verdict === "ok",
  },
  actions: {
    bumpSession: assign({
      sessionId: ({ context }) => context.sessionId + 1,
      hasPlayed: () => false,
      unresponsiveProbes: () => 0,
      fadeDone: () => false,
      resumeAborted: () => false,
      // 开新一轮会话就把上一轮的判死原因清空：`recovering` 只在进入时带因由，
      // 离开后不能让解释器读到陈旧的 cause。
      failoverCause: () => null,
      failoverDetail: () => "",
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
    /** 判死原因：由具体转移写入，解释器在 `navigateFailover` 实现里读。 */
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
    // ---- 副作用发起点：解释器在 createActor 时用 `actions` 覆盖实现 ----
    // 机器自己留 no-op，保证能在 node 下纯粹地跑转换表；一旦接线，「什么时候
    // 撤海报 / 报错 / 交棒换线」只在这张表里决定一次，调用方不再各写一份。
    acquireDecoder: () => undefined,
    releaseDecoders: () => undefined,
    showSpinner: () => undefined,
    hideSpinner: () => undefined,
    pinControls: () => undefined,
    unpinControls: () => undefined,
    resumePlayback: () => undefined,
    cancelResume: () => undefined,
    navigateFailover: () => undefined,
    /** 复核拿到明确「还活着」：把静默计时推回当下（墙钟归解释器管）。 */
    restartQuietClock: () => undefined,
    /** unknown 未达阈值：只记证据，不判死。 */
    reportProbeInconclusive: () => undefined,
    /** 慢但活着：清单与分片都拿得到。 */
    reportProbeSlow: () => undefined,
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
        FAILED: { target: "recovering", actions: "failoverFromEvent" },
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
        // 反代字节在涨 = 极慢但活着：清零 unknown 累计，别把它熬成死线。
        FRAG_GROWTH: { actions: "resetProbe" },
        STALL: { target: "probing", guard: "notPlayed" },
        FAILED: { target: "recovering", actions: "failoverFromEvent" },
      },
    },
    playing: {
      on: {
        // 出过画之后看门狗不再介入（红线见 notPlayed guard）：卡顿按网络抖动处理。
        STALL: { target: "probing", guard: "notPlayed" },
        FRAG_GROWTH: { actions: "resetProbe" },
        FADE_DONE: { actions: "completeFade" },
        USER_SWITCH: {
          target: "switching",
          actions: ["setTarget", "setResumeIntent", "bumpSession", "showSpinner", "pinControls"],
        },
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
            actions: ["incrementProbe", "reportProbeInconclusive"],
          },
          {
            guard: "isOk",
            target: "playing",
            actions: ["resetProbe", "restartQuietClock", "reportProbeSlow"],
          },
        ],
        MEDIA_ALIVE: { target: "playing", actions: "resetProbe" },
        FRAG_GROWTH: { target: "playing", actions: "resetProbe" },
        // 探活期间解码器直接报错 = 比任何复核都硬的证据。
        FAILED: { target: "recovering", actions: ["incrementProbe", "failoverFromEvent"] },
        // 复核在途时用户换集 / 换源：本轮结论作废，跟着新会话走。
        USER_SWITCH: {
          target: "switching",
          actions: ["setTarget", "setResumeIntent", "bumpSession", "showSpinner", "pinControls"],
        },
        LOAD: { target: "resolving", actions: ["setTarget", "bumpSession"] },
      },
    },
    switching: {
      // 兜底超时：即便漏喂退出事件，15s 后也自动离开 switching（撤 spinner/钉住），
      // 绝不让按钮转环或控制栏钉住永久卡住（对齐引擎 switchSource 的 15s 封顶）。
      after: { 15000: { target: "playing", actions: ["hideSpinner", "unpinControls"] } },
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
        STALL: { target: "probing", guard: "notPlayed" },
        FRAG_GROWTH: { actions: "resetProbe" },
        FAILED: { target: "recovering", actions: "failoverFromEvent" },
      },
    },
    recovering: {
      // 进入即「这条线已判死、交棒换线」。真实的恢复路径不是某个 RECOVERED 信号，
      // 而是上层换源后重建实例（LOAD）或用户手动换集（USER_SWITCH）——出边按现实写。
      entry: "navigateFailover",
      on: {
        LOAD: { target: "resolving", actions: ["setTarget", "bumpSession"] },
        USER_SWITCH: {
          target: "switching",
          actions: ["setTarget", "setResumeIntent", "bumpSession", "showSpinner", "pinControls"],
        },
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

export type VodSessionActor = ActorRefFrom<typeof vodSessionMachine>;
