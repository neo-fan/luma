import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { EXTERNAL_PLAY_FALLBACK } from "../../lib/features";

interface PlayerStageProps {
  resolving: boolean;
  /** 解析进度阶段，用于更精确的文案，避免「解析中」被误判成卡死。 */
  stage?: "parsing" | "connecting" | null;
  /** 点「刷新」重新获取地址中：播放器实例与控件保持不动，只显示中间提示。 */
  reloading?: boolean;
  /** 自动换线路进行中（有希望自愈，不铺满错误面板）。 */
  recovering?: boolean;
  /**
   * 内核报告的「慢但在动」文案（已含等待秒数，空串 = 没有）。
   *
   * 只用来顶一块中性加载态：慢源不该出现红色错误条，也不该被自动换走。
   */
  slowText?: string;
  playable: boolean;
  resolveError: string;
  /** 解析失败的成因是「源还没答完」（可重试），标题别提成「无法解析」。 */
  retryable?: boolean;
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
  slowText = "",
  playable,
  resolveError,
  retryable = false,
  containerRef,
}: PlayerStageProps) {
  // 慢源冷启动实测能到 18s：光转圈会被当成卡死，超过 4s 就把已等待秒数报出来，
  // 让用户知道「在动，只是慢」，而不是「点坏了」。解析结束自动归零。
  const busy = resolving || reloading || recovering;
  const [waited, setWaited] = useState(0);
  const startedAt = useRef(0);
  useEffect(() => {
    if (!busy) {
      startedAt.current = 0;
      setWaited(0);
      return;
    }
    if (!startedAt.current) startedAt.current = Date.now();
    const timer = setInterval(() => {
      setWaited(Math.floor((Date.now() - startedAt.current) / 1000));
    }, 500);
    return () => clearInterval(timer);
  }, [busy]);

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
              title: resolveError
                ? retryable
                  ? "源响应较慢，暂未拿到播放地址"
                  : "无法解析播放地址"
                : EXTERNAL_PLAY_FALLBACK.title,
              desc: resolveError || EXTERNAL_PLAY_FALLBACK.desc,
            }
          : null;

  /**
   * 播放实例已建立、但迟迟没有出画时的兜底态：解析/换源都有自己的忙态文案，
   * 这里补的是「地址没问题、源就是慢」这一档。不带红色、不换线。
   */
  const active =
    status ?? (slowText ? { busy: true, title: "正在加载画面…", desc: slowText } : null);

  // 等待提示只挂在「正在等源」的三种忙态上，错误面板不显示。
  const slowHint =
    status?.busy && waited >= 4
      ? waited >= 12
        ? `已等待 ${waited}s，源侧较慢，仍在重试…`
        : `已等待 ${waited}s…`
      : "";

  /**
   * 提示层在场时给舞台打状态标：ArtPlayer 自带的 loading（`.art-loading`）里是
   * 50×50 的方点阵 svg，同样居中，会和我们 72×72 的光环叠成一坨（11-14 用户
   * 反馈「加载提示和播放器加载 icon 重合」）。用类名而不是 CSS `:has()`，与项目
   * 其他状态修饰保持一致，也避免依赖选择器支持度。
   */
  const stageClass = active
    ? `player-stage ${active.busy ? "is-busy" : "is-error"}`
    : "player-stage";

  return (
    <div className={stageClass}>
      <div ref={containerRef} className="player-art" />

      {active ? (
        <div className="player-overlay" aria-live="polite">
          {/* 等待态用「呼吸光环 + 旋转弧」占据画面正中，文字压在下方：纯转圈
              在小窗口里太轻，用户会以为没在动；错误态才用卡片承载长文案。 */}
          <div className={active.busy ? "player-status is-busy" : "player-status is-error"}>
            {active.busy ? (
              <span className="player-status__pulse" aria-hidden="true">
                <span className="player-status__ring" />
                <span className="player-status__dot" />
              </span>
            ) : null}
            <p className="player-status__title">{active.title}</p>
            {active.desc ? <p className="player-status__desc">{active.desc}</p> : null}
            {slowHint ? <p className="player-status__desc">{slowHint}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
