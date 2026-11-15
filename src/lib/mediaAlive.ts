/**
 * 「媒体到底活没活」的通用判据。
 *
 * 为什么需要单独一层：`videoWidth > 0` 只代表**有画面**，而 WebView2 + mpegts
 * 直播（以及部分 HLS 源）常见「音轨先出、视频轨还在解码」—— 此时元素已经在
 * 放声音、`currentTime` 在走、没有任何 `error`，但 `videoWidth` 还是 0，
 * `readyState` 也可能只到 `HAVE_METADATA`。只看画面/缓冲等级就会把一条明明
 * 能播的线路判死，用户听到声音、界面却挂「不可用」。
 *
 * 所以判据按「证据强弱」分层，**任何一个成立都算活**：
 * 1. `readyState >= 2`：当前播放位置已有数据（哪怕用户暂停着）；
 * 2. `currentTime > 0` 且未暂停、未结束、没有 `error`：媒体时钟在走 —— 音频
 *    也算，这正是要覆盖的场景；
 * 3. 外部记录的「上次存活时间 + 时钟快照」有前进：判定窗口内确实在播放。
 *
 * 反过来说，**时间不是证据**：静默等待不判死（见 `usePlayerEngine` 的看门狗
 * 注释），这里只回答「此刻能不能确认它活着」，不回答「还要不要等」。
 */

/** 判据只需要这几个字段，测试可以传最小对象。 */
export interface MediaLike {
  readyState: number;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  error: unknown;
  videoWidth: number;
}

/** 只有 2（HAVE_CURRENT_DATA）以上的缓冲才算「有当前帧可放」。 */
const HAVE_CURRENT_DATA = 2;

/** 媒体时钟在走：不暂停、没结束、没报错、确实走过一段。 */
export function mediaIsAdvancing(video: MediaLike | null | undefined): boolean {
  if (!video) {
    return false;
  }
  if (video.error || video.paused || video.ended) {
    return false;
  }
  return video.currentTime > 0;
}

/**
 * 通用「活着」判据：能出当前帧 / 时钟在走 / 有画面，任一成立即可。
 *
 * 注意 `videoWidth > 0` 单独成立也算（有些内核 `readyState` 更新滞后，但画面
 * 已经出来了）。`error` 存在时一律不算活：报错就是报错，不能因为时钟还在走
 * 就吞掉换线机会。
 */
export function mediaLooksAlive(video: MediaLike | null | undefined): boolean {
  if (!video) {
    return false;
  }
  if (video.error) {
    return false;
  }
  if (video.readyState >= HAVE_CURRENT_DATA) {
    return true;
  }
  if (video.videoWidth > 0) {
    return true;
  }
  return mediaIsAdvancing(video);
}

/**
 * 判定窗口内媒体是否真的前进了 `minAdvance` 秒。
 *
 * 用途：单线路「等 4s 再判死」这类延迟结论 —— 判死前拿窗口起点的快照再问一次，
 * 只要时钟前进过就不判。暂停中的播放（`paused`）不算前进，避免把「用户暂停」
 * 当成证据。
 */
export function mediaAdvanced(
  video: MediaLike | null | undefined,
  sinceTime: number,
  minAdvance = 0.3,
): boolean {
  if (!video || video.error || video.paused || video.ended) {
    return false;
  }
  return video.currentTime - sinceTime >= minAdvance;
}
