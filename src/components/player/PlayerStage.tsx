import type { RefObject } from "react";
import Spinner from "../Spinner";
import { EXTERNAL_PLAY_FALLBACK } from "../../lib/features";

interface PlayerStageProps {
  resolving: boolean;
  /** 解析进度阶段，用于更精确的文案，避免「解析中」被误判成卡死。 */
  stage?: "parsing" | "connecting" | null;
  /** 点「刷新」重新获取地址中：播放器实例与控件保持不动，只显示中间提示。 */
  reloading?: boolean;
  /** 自动换线路进行中（有希望自愈，不铺满错误面板）。 */
  recovering?: boolean;
  playable: boolean;
  resolveError: string;
  /** ArtPlayer 挂载点：必须绑到 .player-art 这个空 div 本身，不能换成组件根。 */
  containerRef: RefObject<HTMLDivElement>;
}

/**
 * 播放舞台：ArtPlayer 组件常驻，视频加载 / 异常状态只在画面中间以小卡片提示。
 *
 * ⚠️ `.player-art` 必须**始终存在且可见**（不能按 resolving 隐藏）：早期实现
 * 条件卸载容器会让正在播的实例失去挂载点（只有声音没画面），destroy 链漏掉
 * hls.js / mpegts.js。现在更进一步——加载中、解析失败都不盖黑色全屏遮罩，
 * 播放器控制栏（暂停/下一集/刷新/全屏）始终可见可点；「视频有问题」不该
 * 让用户连控件都点不到。
 *
 * 状态卡片用 `pointer-events: none` + 透明底，只在中间占一小块，鼠标事件
 * 直接穿透到下面的播放器控件。
 */
export default function PlayerStage({
  resolving,
  stage = null,
  reloading = false,
  recovering = false,
  playable,
  resolveError,
  containerRef,
}: PlayerStageProps) {
  // 有可播地址时即便在重新解析，也照常显示画面与控件，不给容器加 hidden。
  const status = resolving
    ? // 解析分两个阶段给不同文案：问源拿直链 vs 交给反代建连，避免「一直转」被误判卡死。
      stage === "connecting"
      ? { busy: true, title: "正在连接播放地址…", desc: "" }
      : { busy: true, title: "正在解析播放源…", desc: "" }
    : reloading
      ? { busy: true, title: "正在重新获取播放地址…", desc: "" }
      : recovering
        ? { busy: true, title: "当前线路不可用，正在尝试其它线路…", desc: "" }
        : !playable
          ? {
              busy: false,
              title: resolveError ? "无法解析播放地址" : EXTERNAL_PLAY_FALLBACK.title,
              desc: resolveError || EXTERNAL_PLAY_FALLBACK.desc,
            }
          : null;

  return (
    <div className="player-stage">
      <div ref={containerRef} className="player-art" />

      {status ? (
        <div className="player-overlay" aria-live="polite">
          <div className="player-status">
            {status.busy ? <Spinner label="" /> : null}
            <p className="player-status__title">{status.title}</p>
            {status.desc ? <p className="player-status__desc">{status.desc}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
