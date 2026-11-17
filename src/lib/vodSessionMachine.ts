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
 * 时间窗（音量 ramp / 初始化静默 / 倍速静默）本质是墙钟问题，**留在解释器**；
 * 机器只跟踪离散量（`sessionId`、`hasPlayed`、`resumeIntent`、`resumeAborted`、
 * `unresponsiveProbes`、`failoverCause`）。曾经这里还带一个 `fadeDone` 布尔与
 * `FADE_DONE` 事件，但引擎从不发它（音量淡入归时间窗），是纯装饰 —— 已删。
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
  /**
   * 原地换集：新地址已经通过 `art.switchUrl` 挂上（音量淡入与倍速复位已在解释器
   * 侧先行处理完）。这是**续播的唯一发起点**——机器据此在 `switching` 里跑
   * `resumePlayback`（受 `wantsResume` 守卫）。
   */
  | { type: "SWITCH_ATTACHED" }
  | { type: "AUTOPLAY_BLOCKED" }
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
 resumeAborted: false,
  failoverCause: null,
  failoverDetail: "",
};

export const vodSessionMachine = setup({
  types: { context: {} as VodSessionContext, events: {} as VodSessionEvent },
  guards: {
    wantsResume: ({ context }) => context.resumeIntent,
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
    // ---- 副作用发起点：解释器用 `machine.provide({ actions })` 给出实现 ----
    // 只留**真正需要机器决定时机**的动作。原先这里还挂着 acquireDecoder /
    // releaseDecoders / showSpinner / hideSpinner / pinControls / unpinControls
    // 六个空描述符：解码器的创建与销毁属于 ArtPlayer 实例生命周期（在 `customType`
    // 里挂 hls.js / mpegts.js，机器既碰不到也不该碰），转环与钉控制栏由
    // `matches("switching")` 这个**状态本身**驱动。留着它们等于让模型假装owns
    // 一些其实不归它的事——2026-11-17 删除。
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
      on: {
        ATTACHED: "buffering",
        FAILED: { target: "recovering", actions: "failoverFromEvent" },
      },
    },
    buffering: {
      on: {
        MEDIA_ALIVE: { target: "playing", actions: "markPlayed" },
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
       USER_SWITCH: {
          target: "switching",
          actions: ["setTarget", "setResumeIntent", "bumpSession"],
        },
        // 兜底超时（或复核）之后才挂上新地址：续播照样要发起，否则换集停在暂停态。
        SWITCH_ATTACHED: [{ guard: "wantsResume", actions: "resumePlayback" }],
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
        // 探活期间解码器直接报错 = 比任何复核都硬的证据。
        FAILED: { target: "recovering", actions: ["incrementProbe", "failoverFromEvent"] },
        // 复核在途时用户换集 / 换源：本轮结论作废，跟着新会话走。
        USER_SWITCH: {
          target: "switching",
          actions: ["setTarget", "setResumeIntent", "bumpSession"],
        },
        LOAD: { target: "resolving", actions: ["setTarget", "bumpSession"] },
        // 复核在途时新地址已经挂上：续播不等复核结论。
        SWITCH_ATTACHED: [{ guard: "wantsResume", actions: "resumePlayback" }],
      },
    },
    switching: {
      // 兜底超时：即便漏喂退出事件，15s 后也自动离开 switching（撤 spinner/钉住），
      // 绝不让按钮转环或控制栏钉住永久卡住（对齐引擎 switchSource 的 15s 封顶）。
      after: { 15000: "playing" },
      on: {
        MEDIA_ALIVE: { target: "playing", actions: "markPlayed" },
        AUTOPLAY_BLOCKED: {
          target: "playing",
          actions: ["markResumeAborted", "cancelResume"],
        },
        // **续播的发起点在这里，不在 MEDIA_ALIVE**：现实是「新地址挂上后立刻试播 +
        // canplay 兜底」，而 `MEDIA_ALIVE` 意味着首帧已经出来了——那时再 play() 就
        // 成了「等到有画面才播」，正是 2026-11-15 那个「换集后黑屏不动」的反面。
        // 所以解释器在 `art.switchUrl` 之后、音量淡入与倍速复位之后发这个事件，
        // 顺序与原先的内联写法逐字等价。
        SWITCH_ATTACHED: [{ guard: "wantsResume", actions: "resumePlayback" }],
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
          actions: ["setTarget", "setResumeIntent", "bumpSession"],
        },
        FAILED: "failed",
      },
    },
    failed: {
      on: {
        LOAD: { target: "resolving", actions: ["setTarget", "bumpSession"] },
      },
    },
  },
});

export type VodSessionActor = ActorRefFrom<typeof vodSessionMachine>;
