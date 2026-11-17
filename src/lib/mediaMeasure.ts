/**
 * 两个从媒体事件里算出来的量，纯函数，便于在 node 下钉住口径。
 */

/** 小于这个差值视为同一次读数，不触发重渲染。 */
const REPORT_EPSILON_RATIO = 0.1;

export interface BitrateSample {
  kbps: number;
  /** 是否值得重渲染角标。 */
  changed: boolean;
}

/**
 * 实测码率：分片真实字节 / 该分片覆盖的媒体时长。声明值常缺失或偏小，
 * 只有这个数反映「当前这一集到底多大码率」。
 *
 * 按 0.7/0.3 指数平滑：单个小分片（片头）会把读数带飞。抖动小于 10% 不重渲染，
 * 换档时那一跳仍能立刻反映。
 */
export function smoothBitrate(previousKbps: number, sampleKbps: number): BitrateSample {
  const kbps = previousKbps > 0 ? previousKbps * 0.7 + sampleKbps * 0.3 : sampleKbps;
  const previous = Math.round(kbps);
  const changed = Math.abs(sampleKbps - previous) / Math.max(previous, 1) > REPORT_EPSILON_RATIO;
  return { kbps, changed };
}

/**
 * 「EOF 之后画面到底停没停」。
 *
 * 直播 FLV 断流几乎总是「先 EOF 再重连」：mpegts 抛 `UnrecoverableEarlyEof` 那一刻，
 * 缓冲里往往还有几秒画面在正常解码。此时直接挂「播放失败」与用户看到的事实相反，
 * 所以给一个观察窗：还在走就交给看门狗按证据判死，真停住了才报错换线。
 */
export function hasMediaStopped(input: {
  paused: boolean;
  readyState: number;
  currentTime: number;
  startedAt: number;
}): boolean {
  if (input.paused) {
    return input.readyState < 2;
  }
  // 0.2s 的容差：时钟推进小于这个值等于没动（浮点与分片边界抖动）。
  return input.currentTime <= input.startedAt + 0.2;
}