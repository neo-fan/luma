/**
 * 「这条线路判死了」的离散原因，以及它对用户怎么说。
 *
 * 分层的理由：会话状态机（`vodSessionMachine` / `liveSessionMachine`）只该说
 * **为什么**判死（离散量，可在 node 下断言）；产品文案与日志 stage 是解释器的
 * 事，但这两样原先散在 `usePlayerEngine` 的 5 个交棒点里各写一遍——撤海报、
 * 挂红条、调 `switchOrFailoverRef` 的顺序还全靠人记得住。这里收成一份。
 */
import { PLAY_FAILURE_HINT } from "./features";

/**
 * 判死原因。新增必须同时在两台机器的 `FAILED` / `PROBE` 转移里发生，
 * 并在下面的映射里给出文案——不允许出现「有原因没文案」的组合。
 */
export type FailoverCause =
  /** 复核给出明确失败（HTTP 错误 / 内容不是 m3u8 / 分片是占位图）。 */
  | "probeDead"
  /** 连续多次复核连一个字节都拿不到（吊死型 CDN）。 */
  | "probeUnresponsive"
  /** `<video>` 自己报 MEDIA_ERR_DECODE / SRC_NOT_SUPPORTED（HEVC 常见）。 */
  | "mediaDecode"
  /** hls.js 抛 fatal。 */
  | "hlsFatal"
  /** mpegts.js 抛 fatal。 */
  | "flvFatal"
  /** 直播 FLV 先 EOF、观察窗内画面确实停住（与「一开始就放不出来」文案不同）。 */
  | "flvInterrupted"
  /** 所有线路都试过了。 */
  | "linesExhausted";

export interface FailoverCopy {
  /** 挂在错误条上的人话。 */
  message: string;
  /** 日志 stage：排障时按它 grep，也是探针/日志断言的口径。 */
  stage: string;
}

/**
 * 文案与 stage 的唯一来源。`detail` 是解码器给的原始错误名（hls `data.details`
 * / mpegts 的 `err`），进用户文案时保持原先的写法不变。
 */
export function failoverCopy(cause: FailoverCause, detail = ""): FailoverCopy {
  switch (cause) {
    case "probeDead":
      return { message: "当前线路已确认无法加载，正在切换…", stage: "stall probe dead" };
    case "probeUnresponsive":
      return { message: "当前线路多次无响应，正在切换…", stage: "stall probe unresponsive" };
    case "mediaDecode":
      return { message: `播放器加载失败，${PLAY_FAILURE_HINT}。`, stage: "media decode failed" };
    case "hlsFatal":
      return { message: `HLS 播放失败：${detail}，正在切换线路`, stage: "hls fatal" };
    case "flvFatal":
      return { message: `FLV 播放失败：${detail}`, stage: "flv fatal" };
    case "flvInterrupted":
      return { message: `FLV 播放中断：${detail}`, stage: "flv interrupted" };
    case "linesExhausted":
      // 文案口径：这条是「同源所有线路都不行」，接下来才轮到换源；换线阶段的
      // 文案不得宣称已经在换源（`failoverOrder.test.ts` 钉着这条区分）。
      return { message: "所有线路都不可用，正在找其它源…", stage: "lines exhausted" };
  }
}
