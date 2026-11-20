import { setup, assign, type ActorRefFrom } from "xstate";
import type { LineVerdict } from "./playProbe";

/**
 * 点播会话状态机。
 *
 * 播放内核的离散生命周期状态（会话身份、首帧、续播意图、探活累计、判死原因）与
 * 「何时交棒」的判决都只在这里表达一次，转换表可在 node 下逐条断言。副作用由
 * `usePlayerEngine` 作为解释器执行。
 *
 * 不含墙钟状态（音量 ramp、初始化与倍速静默窗），那些留在解释器。
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
  /** 会话身份：每次换集 / 重载自增，作为在途回调的代次比较基准。 */
  sessionId: number;
  targetUrl: string;
  /** 本会话是否已出过画（首帧）。 */
  hasPlayed: boolean;
  /** 换集前是否在播——决定新集要不要自动续播。 */
  resumeIntent: boolean;
  /** 「未知」探测累计次数，达阈值判死换线。 */
  unresponsiveProbes: number;
  /** 本轮切换是否被用户暂停打断过续播。 */
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
         * 出过画之后不再自动换线：卡顿多半是网络抖动，换线交给手动操作。
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
    // 副作用发起点：实现由解释器用 `machine.provide({ actions })` 注入。
    // 解码器生命周期归 ArtPlayer 的 `customType`，转环与钉控制栏由
    // `matches("switching")` 状态驱动，都不在这里。
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
        // 冷启动还没出画时用户就点了下一集：引擎照样会切，机器必须一起进 switching，
        // 否则这一轮切换在模型里不存在，spinner 与代次都对不上。
        USER_SWITCH: {
          target: "switching",
          actions: ["setTarget", "setResumeIntent", "bumpSession"],
        },
        FAILED: { target: "recovering", actions: "failoverFromEvent" },
      },
    },
    playing: {
      on: {
        STALL: { target: "probing", guard: "notPlayed" },
        // 已在 playing 也要接受首帧证据：进入 playing 不一定经过 markPlayed
        // （switching 的 15s 兜底、probing 的 unknown 都不带首帧回来）。缺这条，
        // hasPlayed 可能永久停在 false，把「已出画不再自动换线」无声解除。
        MEDIA_ALIVE: { actions: "markPlayed" },
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
        // 复核在途时换集 / 换源：本轮结论作废，跟着新会话走。
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
        // 续播在这里发起，不在 MEDIA_ALIVE：那时首帧已经出来，play() 就晚了。
        // 解释器在 `art.switchUrl`、倍速复位与淡入武装之后发这个事件。
        SWITCH_ATTACHED: [{ guard: "wantsResume", actions: "resumePlayback" }],
        STALL: { target: "probing", guard: "notPlayed" },
        FRAG_GROWTH: { actions: "resetProbe" },
        FAILED: { target: "recovering", actions: "failoverFromEvent" },
      },
    },
    recovering: {
      // 进入即「这条线已判死、交棒换线」。恢复路径是上层换源后重建实例（LOAD）
      // 或手动换集（USER_SWITCH）。
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
