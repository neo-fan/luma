import { createPortal } from "react-dom";
import { formatBufferedSeconds, formatBytesPerSec } from "../../lib/bytes";

interface PlayerSpeedProps {
  /** ArtPlayer 的 `.art-video-player` 根节点；全屏时只有它跟着进全屏。 */
  host: HTMLDivElement | null;
  bytesPerSec: number;
  bufferedSec: number;
}

/**
 * 画面左下角的「缓存速度」小条：`↓ 2.4 MB/s · 缓冲 8s`。
 *
 * 只做展示，不接管加载态——缓冲仍是 ArtPlayer 自带的 loading。数据来自
 * `useCacheSpeed`（反代 `/meter` + `<video>.buffered`）；两项都取不到时整个
 * 条目不渲染，不在画面上留一个「--」。
 */
export default function PlayerSpeed({ host, bytesPerSec, bufferedSec }: PlayerSpeedProps) {
  const rate = formatBytesPerSec(bytesPerSec);
  const buffer = formatBufferedSeconds(bufferedSec);
  if (!host || (!rate && !buffer)) {
    return null;
  }
  return createPortal(
    <span className="player-speed" aria-hidden="true">
      {rate ? (
        <span className="player-speed__rate">
          <span className="player-speed__arrow">↓</span>
          {rate}
        </span>
      ) : null}
      {buffer ? <span className="player-speed__buffer">缓冲 {buffer}</span> : null}
    </span>,
    host,
  );
}
