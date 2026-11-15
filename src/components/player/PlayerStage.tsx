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
  playable: boolean;
  resolveError: string;
  /**
   * 还没有任何解析结果（resolved === null）。选台/换地址后的第一帧 effect
   * 尚未把 resolving 翻 true，此时 !playable 只是「还没开始解析」，不是
   * 「解析出了不能播的地址」——不能闪一帧「无法播放」结论卡。
   */
  pending?: boolean;
  /** 解析失败的成因是「源还没答完」（可重试），标题别提成「无法解析」。 */
  retryable?: boolean;
  /** ArtPlayer 挂载点：必须绑到 .player-art 这个空 div 本身，不能换成组件根。 */
  containerRef: RefObject<HTMLDivElement>;
  /**
   * 解析期背景海报（影片封面，调用方已过 /image 代理）。换集/换线/换源
   * remount 后的 3~50s 解析期实例还没建，画面不该是纯黑。可选：没有海报
   * （直播 / 封面缺失）维持原样。
   */
  poster?: string;
  /** 换下一条线路：播放失败、或等待超过 5s 时给用户一个「别干等」的出口。 */
  onNextLine?: () => void;
  /** 正在切换线路：按钮置灰并换成进行中文案，防连点。 */
  nextLineBusy?: boolean;
  /**
   * 原地换集进行中：控制栏钉住不自动收起（等待期唯一常驻的「还在动」证据）。
   * 与 busy 区分——换集时播放实例还活着，不该盖状态卡、也不该铺海报。
   */
  switching?: boolean;
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
  pending = false,
  retryable = false,
  containerRef,
  poster,
  onNextLine,
  nextLineBusy = false,
  switching = false,
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

  // 只有「还没有播放实例」时才有自定义提示：拿地址、重建实例。
  // 视频本身的加载与缓冲一律交给 ArtPlayer 内建的 loading 样式，这里不再画
  // 第二套转圈（11-14 用户反馈过两坨加载动画叠在画面中心）。
  const status = resolving
    ? // 解析分两个阶段给不同文案：问源拿直链 vs 交给反代建连，避免「一直转」被误判卡死。
      stage === "connecting"
      ? { busy: true, title: "正在连接播放地址…", desc: "" }
      : { busy: true, title: "正在解析播放源…", desc: "" }
    : reloading
      ? { busy: true, title: "正在重新获取播放地址…", desc: "" }
      : !playable
        ? pending && !resolveError
          ? { busy: true, title: "正在解析播放源…", desc: "" }
          : {
              busy: false,
              title: resolveError
                ? retryable
                  ? "源响应较慢，暂未拿到播放地址"
                  : "无法解析播放地址"
                : EXTERNAL_PLAY_FALLBACK.title,
              desc: resolveError || EXTERNAL_PLAY_FALLBACK.desc,
            }
        : null;

  const active = status;

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
    : switching
      ? "player-stage is-switching"
      : "player-stage";

  return (
    <div className={stageClass}>
      <div ref={containerRef} className="player-art" />

      {/* 解析期（实例还没建）铺封面当背景：模糊 + 暗化，参考首页 Hero 的氛围
          做法但保持简单。只在 busy 且 !playable 时出现——软刷新 / 自愈期间
          实例还在播，不能用海报盖住活画面。backgroundImage 是按数据拼的
          地址（同 ArtPlayer 自己的 poster），属于内联样式的例外情形。 */}
      {busy && poster && !playable ? (
        <div
          className="player-stage-poster"
          style={{ backgroundImage: `url("${poster}")` }}
          aria-hidden="true"
        />
      ) : null}

      {active ? (
        <div className="player-overlay" aria-live="polite">
          {/* 等待态用「呼吸光环 + 旋转弧」占据画面正中，文字压在下方：纯转圈
              在小窗口里太轻，用户会以为没在动；错误态才用卡片承载长文案。 */}
          <div className={active.busy ? "player-status is-busy" : "player-status is-error"}>
            <p className="player-status__title">{active.title}</p>
            {active.desc ? <p className="player-status__desc">{active.desc}</p> : null}
            {slowHint ? <p className="player-status__desc">{slowHint}</p> : null}
            {onNextLine && (!active.busy || waited >= 5) ? (
              <button
                type="button"
                className="player-status__action"
                onClick={onNextLine}
                disabled={nextLineBusy}
              >
                {nextLineBusy ? "正在切换线路…" : "换下一条线路"}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
