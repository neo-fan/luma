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
 *
 * ⚠️ `.player-art` 必须**始终存在于 DOM**，且保持为空 div（ArtPlayer 会往它
 * 内部注入模板与 <video>）。早期实现按 `resolving` 条件卸载这个容器，换源时
 * React 会在播放内核 effect 之前把容器摘掉：旧 ArtPlayer 挂在已 detach 的
 * 节点上继续出声（只有声音没画面），destroy 时又因容器不在文档树上而漏掉
 * `hls.destroy()`，残留解码流与新实例叠成「两个声音」。现在只切 visibility +
 * 用绝对定位覆盖层显示 Spinner / 兜底，DOM 生命周期完全交给内核 effect 的
 * `art.destroy()` 管理。
 */
export default function PlayerStage({
  resolving,
  playable,
  resolveError,
  containerRef,
}: PlayerStageProps) {
  const hidden = resolving || !playable;
  return (
    <div className="player-stage">
      <div
        ref={containerRef}
        className={`player-art${hidden ? " player-art--hidden" : ""}`}
      />

      {resolving ? (
        <div className="player-overlay">
          <Spinner label="正在解析播放地址…" />
        </div>
      ) : null}

      {!resolving && !playable ? (
        <div className="player-overlay player-fallback">
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
