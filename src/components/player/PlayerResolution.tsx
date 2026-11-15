import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { bitrateLabel } from "../../lib/resolution";

interface PlayerResolutionProps {
  /**
   * ArtPlayer 的 `.art-video-player` 根节点。
   *
   * 必须挂在它内部：ArtPlayer 全屏时把 **这个节点本身**（不是外层
   * `.player-stage`）送进 `requestFullscreen()`，挂在外层的角标一进全屏就
   * 从可视区域里消失了。它同时也被当作 ArtPlayer 模板的一部分，随
   * `art.destroy()` 一起销毁。
   */
  host: HTMLDivElement | null;
  /** `1080P` / `4K` / `1440P`；空串表示没有可信数值，角标整个不渲染。 */
  label: string;
  /** tooltip：精确像素尺寸或清单声明值。 */
  detail?: string;
  /**
   * 当前集数（如「第 5 集」）。排在分辨率**前面**：全屏时用户更需要知道
   * 「在播哪一集」，而控制栏那枚「下一集」按钮只说明还有下一集。
   */
  episode?: string;
  /**
   * 实测视频码率（kbps）。有值才展示：直链 mp4 / flv 拿不到，TVBox 的多数
   * 单码率 HLS 也只有分片下载量能算出来（见引擎的 FRAG_LOADED）。
   */
  bitrate?: number;
  /**
   * 直播态传入频道名：频道名与分辨率合并成画面左上角一块。
   *
   * 直播没有海报 / 简介，「频道叫什么」是画面旁唯一必须常驻的信息，而左下
   * 信息条（原 `LiveChannelBar`）会占掉一整行高度、把节目单往下推。并进
   * 角标后右列依次只有：画面 → 节目单，滚动距离更短（2026-11-15 用户要求）。
   */
  channel?: string;
}

/** 全屏时鼠标静止多久后收起角标。与 ArtPlayer 的控件渐隐节奏对齐。 */
const IDLE_MS = 3200;

/**
 * 判断当前是否处于「全屏」。
 *
 * 两套全屏都要算：`fullscreenElement` 是浏览器原生全屏（F11 式的整屏），
 * `art-fullscreen-web` 是 ArtPlayer 的网页全屏（铺满窗口、不退出全屏 API）。
 * 只覆盖前者会让「网页全屏」下角标常驻，正好压在字幕上。
 */
function isFullscreen(host: HTMLElement): boolean {
  return (
    document.fullscreenElement === host ||
    host.classList.contains("art-fullscreen") ||
    host.classList.contains("art-fullscreen-web")
  );
}

/**
 * 画面左上角的分辨率角标（直播态把频道名并进来）。
 *
 * 数据来自解码后的真实画面尺寸（见 `lib/resolution`），挂载与状态由播放内核
 * 通过 `host` 注入；**视口内的 React 树拿不到全屏节点**，所以用 portal 渲染到
 * ArtPlayer 模板里，而不是跟着 `.player-stage` 排版。
 *
 * 隐藏策略：窗口模式常驻（不抢画面，字号 12px、半透明）；全屏下鼠标静止
 * 3.2 秒后淡出，有任何指针动作立刻回来——这样长时间观影时它不会一直糊在画面
 * 上，但想知道频道 / 清晰度时晃一下鼠标就能看到。
 */
export default function PlayerResolution({
  host,
  label,
  detail,
  episode,
  bitrate,
  channel,
}: PlayerResolutionProps) {
  const [idle, setIdle] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!host) {
      setIdle(false);
      return;
    }
    const clear = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
    // 只有全屏才计时；窗口模式没有「自动隐藏」这回事，常驻即可。
    const arm = () => {
      clear();
      if (!isFullscreen(host)) {
        setIdle(false);
        return;
      }
      timer.current = window.setTimeout(() => setIdle(true), IDLE_MS);
    };
    const wake = () => {
      setIdle(false);
      arm();
    };
    // 进出全屏 / 网页全屏都重置一次：刚进全屏时先亮一会儿再淡出。
    const onFullscreen = () => wake();
    /**
     * 只认「全屏状态变化」，不能对每次 class 变更都 wake()。
     *
     * ArtPlayer 在播放过程中会不停改自己的 class（`art-mini-progress-bar`
     * 实测 5 秒内变更 37 次），若照单重新计时，全屏下的空闲计时永远到不了，
     * 角标就再也不会淡出。
     */
    let wasFullscreen = isFullscreen(host);
    const observer = new MutationObserver(() => {
      const now = isFullscreen(host);
      if (now === wasFullscreen) {
        return;
      }
      wasFullscreen = now;
      wake();
    });

    host.addEventListener("pointermove", wake);
    host.addEventListener("pointerdown", wake);
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("webkitfullscreenchange", onFullscreen);
    observer.observe(host, { attributes: true, attributeFilter: ["class"] });
    arm();

    return () => {
      clear();
      observer.disconnect();
      host.removeEventListener("pointermove", wake);
      host.removeEventListener("pointerdown", wake);
      document.removeEventListener("fullscreenchange", onFullscreen);
      document.removeEventListener("webkitfullscreenchange", onFullscreen);
    };
  }, [host]);

  if (!host) {
    return null;
  }
  if (channel) {
    // 直播：频道名常驻、分辨率贴在名字右侧；分不清清晰度时不占位置。
    return createPortal(
      <span
        className={`player-chan${idle ? " is-idle" : ""}`}
        title={channel}
        aria-hidden="true"
      >
        <span className="player-chan__name">{channel}</span>
        {label ? (
          <span className="player-chan__res" title={detail || label}>
            {label}
          </span>
        ) : null}
      </span>,
      host,
    );
  }
  const rate = bitrateLabel(bitrate);
  if (!label && !episode && !rate) {
    return null;
  }
  return createPortal(
    <span
      className={`player-res${idle ? " is-idle" : ""}`}
      title={[detail, episode, label, rate].filter(Boolean).join(" · ")}
      aria-hidden="true"
    >
      {episode ? <em className="player-res__ep">{episode}</em> : null}
      {episode && label ? <span className="player-res__sep">·</span> : null}
      {label}
      {rate ? <span className="player-res__sep">·</span> : null}
      {rate ? <span className="player-res__rate">{rate}</span> : null}
    </span>,
    host,
  );
}
