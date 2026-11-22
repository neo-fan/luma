import { useEffect, useRef, useState } from "react";
import { SHORT_UI_TICK_MS } from "../../lib/constants";
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
   * 播放期错误（hls fatal / 解码失败 / 看门狗判死）：只写在播放器里，不占页面
   * 顶部红条；错误卡片给出的出口仍是「换下一条线路」。
   */
  playbackError?: string;
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
  playbackError = "",
  pending = false,
  retryable = false,
  containerRef,
  poster,
  onNextLine,
  nextLineBusy = false,
  switching = false,
}: PlayerStageProps) {
  // 统一的「忙」（仅无实例的解析类状态走自绘卡片）：解析 / 重新获取 / 无结果但已请求。
  const pendingBusy = pending && !resolveError && !playbackError;
  const busy = !playbackError && (resolving || reloading || recovering || pendingBusy);
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
    }, SHORT_UI_TICK_MS);
    return () => clearInterval(timer);
  }, [busy]);

  /**
   * 自绘覆盖层只服务「还没有播放实例」的解析态（拿直链 / 建连 / 重新获取 / 无结果
   * pending）——这时 ArtPlayer 还没有 loading 可画。实例已存在的换集/换源/换线缓冲，
   * 一律交给 ArtPlayer 原生 loading（上层用 `engine.setLoading` 驱动），这里不再画
   * 第二套转圈。拿不到可播地址才出暗色错误卡片。
   */
  let overlay:
    | { kind: "busy"; title: string; hint?: string }
    | { kind: "error"; title: string; desc: string }
    | null = null;

  if (playbackError) {
    // 已经拿到过可播地址、播放中/播放后才失败：错误压在画面上，不再转圈。
    overlay = { kind: "error", title: "播放失败", desc: playbackError };
  } else if (resolving) {
    // 解析分两阶段：问源拿直链 vs 交给反代建连，避免「一直转」被误判卡死。
    overlay = {
      kind: "busy",
      title: stage === "connecting" ? "正在连接播放地址…" : "正在解析播放源…",
    };
  } else if (reloading) {
    overlay = { kind: "busy", title: "正在重新获取播放地址…" };
  } else if (!playable) {
    overlay = pendingBusy
      ? { kind: "busy", title: "正在解析播放源…" }
      : {
          kind: "error",
          title: resolveError
            ? retryable
              ? "源响应较慢，暂未拿到播放地址"
              : "无法解析播放地址"
            : EXTERNAL_PLAY_FALLBACK.title,
          desc: resolveError || EXTERNAL_PLAY_FALLBACK.desc,
        };
  }

  const waiting = overlay?.kind === "busy" && (resolving || reloading || pendingBusy);
  const slowHint =
    waiting && waited >= 4
      ? waited >= 12
        ? `已等待 ${waited}s，源侧较慢，仍在重试…`
        : `已等待 ${waited}s…`
      : "";

  // 切换在途（实例还在）：只打 is-switching 钉住控制栏，画面转圈交给 ArtPlayer。
  const stageClass = ["player-stage", overlay ? (overlay.kind === "busy" ? "is-busy" : "is-error") : "", switching ? "is-switching" : ""]
    .filter(Boolean)
    .join(" ");

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

      {overlay ? (
        <div className="player-overlay" aria-live="polite">
          {/* busy：居中「呼吸光环 + 旋转弧」承载即时反馈，文字压下方（纯转圈在
              小窗口里太轻会被读成没动）；error：暗色卡片承载长文案 + 「换下一条
              线路」出口。切换期画面由 `.is-switching` 统一压暗一档（见 CSS），
              覆盖层本身不挡点击、控制栏钉住可点。 */}
          {overlay.kind === "busy" ? (
            <div className="player-status is-busy">
              <p className="player-status__title">{overlay.title}</p>
              {slowHint ? <p className="player-status__desc">{slowHint}</p> : null}
              {/* 等待也要有出口：直播换线按钮长在播放器控制栏里，而这一层正是
                  「还没有播放实例」的状态——控制栏根本不存在。等到 4s 仍没结果
                  就把「换下一条线路」摆出来，用户不必干等 50s 的解析上限。 */}
              {onNextLine && waited >= 4 ? (
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
          ) : (
            <div className="player-status is-error">
              <p className="player-status__title">{overlay.title}</p>
              <p className="player-status__desc">{overlay.desc}</p>
              {onNextLine ? (
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
          )}
        </div>
      ) : null}
    </div>
  );
}
