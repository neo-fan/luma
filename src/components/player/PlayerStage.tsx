import type { RefObject } from "react";
import Spinner from "../Spinner";

interface PlayerStageProps {
  resolving: boolean;
  playable: boolean;
  resolveError: string;
  /** ArtPlayer 挂载点：必须绑到 .player-art 这个空 div 本身，不能换成组件根。 */
  containerRef: RefObject<HTMLDivElement>;
}

/**
 * 播放舞台：解析中 Spinner / 可播放时交给 ArtPlayer 的空容器 / 否则兜底说明。
 * `.player-art` 必须保持为空 div —— ArtPlayer 会往它内部注入模板与 <video>。
 */
export default function PlayerStage({
  resolving,
  playable,
  resolveError,
  containerRef,
}: PlayerStageProps) {
  return (
    <div className="player-stage">
      {resolving ? <Spinner label="正在解析播放地址…" /> : null}

      {!resolving && playable ? <div ref={containerRef} className="player-art" /> : null}

      {!resolving && !playable ? (
        <div className="player-fallback">
          <p className="player-fallback__title">
            {resolveError ? "无法解析播放地址" : "该地址需要在外部播放器中打开"}
          </p>
          <p className="player-fallback__desc">
            内置播放器只支持 HLS / FLV / 直链媒体，其余格式请交给系统播放器。
          </p>
        </div>
      ) : null}
    </div>
  );
}
