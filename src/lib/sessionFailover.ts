/**
 * 「这条线路判死了」的离散原因，以及它对用户怎么说。
 *
 * 分层的理由：会话状态机（`vodSessionMachine` / `liveSessionMachine`）只该说
 * **为什么**判死（离散量，可在 node 下断言）；产品文案与日志 stage 是解释器的
 * 事，但这两样原先散在 `usePlayerEngine` 的 5 个交棒点里各写一遍——撤海报、
 * 挂红条、调 `switchOrFailoverRef` 的顺序还全靠人记得住。这里收成一份。
 */
import { PLAY_FAILURE_HINT } from "./features";

/** 新增原因必须同时在 `failoverCopy` 里给出文案，否则不满足返回类型。 */
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

/** `detail` 是解码器的原始错误名，原样带进文案。 */
export function failoverCopy(cause: FailoverCause, detail = ""): FailoverCopy {
  switch (cause) {
    case "probeDead":
      return { message: "当前线路无法加载，请换线路或换源。", stage: "stall probe dead" };
    case "probeUnresponsive":
      return { message: "当前线路多次无响应，请换线路或换源。", stage: "stall probe unresponsive" };
    case "mediaDecode":
      return { message: `播放器加载失败，${PLAY_FAILURE_HINT}。`, stage: "media decode failed" };
    case "hlsFatal":
      return {
        message: `HLS 播放失败：${detail || "当前线路不可用"}，可换线路或换源`,
        stage: "hls fatal",
      };
    case "flvFatal":
      return {
        message: `FLV 播放失败：${detail || "当前线路不可用"}，可换线路或换源`,
        stage: "flv fatal",
      };
    case "flvInterrupted":
      return { message: `FLV 播放中断：${detail}`, stage: "flv interrupted" };
    case "linesExhausted":
      return { message: "当前线路不可用，请换线路或换源。", stage: "lines exhausted" };
  }
}
