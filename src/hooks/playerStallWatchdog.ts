/**
 * 卡顿看门狗（2.0.0 从 `usePlayerEngine` 抽出）。
 *
 * 它只干一件事：**取证据**，然后把结论交给会话状态机判决。判决规则（unknown 累计
 * 到几次算死、dead 一次即死、出过画不判死）在 `lib/vodSessionMachine.ts` /
 * `lib/liveSessionMachine.ts` 的转换表里，这里一份都不复制。
 *
 * 为什么不能拿「等了多久」当判决依据（历史，别改回去）：
 * - 死 CDN 会让 hls.js 无限重试却不触发 fatal，画面永远停在 00:00；
 * - 但「慢」不等于「死」：单分片 9MB+ 的 AES-128 源冷启拉首个分片实测 11.8s
 *   （多多影院 ZJ4K），一刀切的固定超时会把能播的线判死跳走 —— 用户看到
 *   「后台在下载、有声音没画面」却被换线；
 * - 2026-11-14 起改成：静默只用来触发一次**独立复核**（直接探清单 + 首个分片），
 *   只有复核给出明确失败（HTTP 错误 / 内容不是 m3u8 / 分片是占位图）才算证据；
 *   超时或说不出所以然（unknown）一律继续等，把决定权留给用户。
 *
 * 三条不参与判决的早退（每条都是真实回归的产物）：
 * 1. 用户主动暂停（不是播完）：没有任何「线路坏了」的证据，且要把静默计时推回当下，
 *    恢复播放后不会因为「暂停了十分钟」立刻判死；
 * 2. 已出过画：卡顿多半是网络抖动，只撤慢提示，绝不自动换线；
 * 3. 媒体自己在走（`readyState>=2` 或时钟前进）：看门狗就此退役，不再打扰。
 */
import type { LineVerdict } from "../lib/playProbe";

/** 看门狗需要读的元素状态（真实 `<video>` 结构上满足）。 */
export interface WatchdogVideo {
  readonly readyState: number;
  readonly paused: boolean;
  readonly ended: boolean;
}

/** 喂给机器的最小事件面（不 import 机器类型，保持本模块可独立测）。 */
export type WatchdogSessionEvent =
  | { type: "STALL" }
  | { type: "PROBE"; verdict: LineVerdict };

export interface StallWatchdogOptions {
  video: WatchdogVideo;
  /** 媒体时钟在走（声音已出、画面还在解码）也算活着。 */
  isAdvancing: () => boolean;
  /** 距最近一次「确认源还在动」的毫秒数。 */
  quietMs: () => number;
  /** 把静默计时推回当下（暂停态用）。 */
  markAlive: () => void;
  clearSlowNotice: () => void;
  /** 会话身份：在途复核的结论要按它判断是否还属于当前这一集。 */
  generation: () => number;
  hasPlayed: () => boolean;
  unresponsiveProbes: () => number;
  send: (event: WatchdogSessionEvent) => void;
  /** 探「当前真实地址」：原地换集后 `resolved` 不变，照旧地址探会误杀新一集。 */
  probeTarget: () => { url: string; kind: string };
  probe: (url: string, kind: string, timeoutMs: number) => Promise<LineVerdict>;
  /** 换线 / 换源已经由上层接管时，看门狗不再插手。 */
  isYielded: () => boolean;
  log: (level: "warn" | "info", stage: string, context: Record<string, unknown>) => void;
  setInterval?: (cb: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
}

export interface StallWatchdog {
  /** 启动轮询，返回停止函数（幂等）。 */
  start: () => () => void;
  /** 按集重置：新一轮切换要从「未知」重新开始。 */
  reset: () => void;
  /** 已交棒：本轮不再探活。 */
  stop: () => void;
  /** 是否已停看（交棒或已确认存活）。 */
  readonly stopped: boolean;
  /** 供日志与探针读取的闸门状态。 */
  tick: () => void;
}

/** 静默多久触发一次独立复核。**时间不是证据**，它只是「该去看一眼」的触发器。 */
export const STALL_QUIET_MS = 20_000;
/** 两次复核的间隔：慢源上别把源站打成 DDOS，也别重复刷提示。 */
export const STALL_RECHECK_MS = 20_000;
/** 轮询粒度。 */
export const STALL_TICK_MS = 4_000;
/** 单次复核的超时。 */
export const STALL_PROBE_TIMEOUT_MS = 12_000;

export function createStallWatchdog(options: StallWatchdogOptions): StallWatchdog {
  const {
    video,
    isAdvancing,
    quietMs,
    markAlive,
    clearSlowNotice,
    generation,
    hasPlayed,
    unresponsiveProbes,
    send,
    probeTarget,
    probe,
    isYielded,
    log,
  } = options;
  const setInterval = options.setInterval ?? ((cb, ms) => window.setInterval(cb, ms));
  const clearInterval = options.clearInterval ?? ((handle) => window.clearInterval(handle));

  let stopped = false;
  let probeBusy = false;
  let lastProbeAt = 0;

  const tick = () => {
    if (stopped) {
      return;
    }
    if (isYielded()) {
      return;
    }
    // 用户主动暂停（不是播完）：没有任何「线路坏了」的证据，绝不能探活换源；
    // 同时把静默计时推到当下，恢复播放后不会因为「暂停了十分钟」立刻判死。
    if (video.paused && !video.ended) {
      markAlive();
      return;
    }
    if (hasPlayed()) {
      // 播过就再也不自动换线：卡住多半是网络抖动，只撤掉慢提示。
      clearSlowNotice();
      return;
    }
    // 通用存活判据：缓冲到位之外，媒体时钟在走（声音已出、画面还在解码）也算活着
    // —— 这种线路不能判死，也不该继续挂着「加载中」。
    if (video.readyState >= 2 || isAdvancing()) {
      stopped = true;
      clearSlowNotice();
      return;
    }
    if (quietMs() < STALL_QUIET_MS) {
      return;
    }
    if (probeBusy || Date.now() - lastProbeAt < STALL_RECHECK_MS) {
      return;
    }
    // 只有真正开始探活才报 STALL（上面每条早退都不报）。
    send({ type: "STALL" });
    probeBusy = true;
    lastProbeAt = Date.now();
    const target = probeTarget();
    const gen = generation();
    void probe(target.url, target.kind, STALL_PROBE_TIMEOUT_MS)
      .then((verdict) => {
        probeBusy = false;
        if (
          // 迟到的结论属于已被新一轮切换取代的旧集：丢弃。
          gen !== generation() ||
          stopped ||
          video.readyState >= 2 ||
          isAdvancing() ||
          isYielded()
        ) {
          return;
        }
        // 判决交给机器：这里只交证据，不决定「继续等 / 累计 / 交棒」。
        send({ type: "PROBE", verdict });
        if (verdict === "ok") {
          // 清单与分片都拿得到：只是慢。静默计时推回当下，下一轮复核重新起算
          // （这是取证方的记账，不是判决，所以归这里而不是状态机）。
          markAlive();
          log("info", "stall probe alive but slow", { quietMs: quietMs() });
        } else if (verdict === "unknown") {
          log("info", "stall probe inconclusive", {
            quietMs: quietMs(),
            unresponsiveProbes: unresponsiveProbes(),
          });
        }
      })
      .catch(() => {
        probeBusy = false;
      });
  };

  return {
    get stopped() {
      return stopped;
    },
    tick,
    start: () => {
      const handle = setInterval(tick, STALL_TICK_MS);
      return () => clearInterval(handle);
    },
    reset: () => {
      stopped = false;
      lastProbeAt = 0;
    },
    stop: () => {
      stopped = true;
    },
  };
}
