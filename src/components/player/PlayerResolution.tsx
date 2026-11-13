import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
 * 画面右上角的分辨率角标。
 *
 * 数据来自解码后的真实画面尺寸（见 `lib/resolution`），挂载与状态由播放内核
 * 通过 `host` 注入；**视口内的 React 树拿不到全屏节点**，所以用 portal 渲染到
 * ArtPlayer 模板里，而不是跟着 `.player-stage` 排版。
 *
 * 隐藏策略：窗口模式常驻（不抢画面，字号 12px、半透明）；全屏下鼠标静止
 * 3.2 秒后淡出，有任何指针动作立刻回来——这样长时间观影时它不会一直糊在画面
 * 右上角，但想知道清晰度时晃一下鼠标就能看到。
 */
export default function PlayerResolution({ host, label, detail }: PlayerResolutionProps) {
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

  if (!host || !label) {
    return null;
  }
  return createPortal(
    <span
      className={`player-res${idle ? " is-idle" : ""}`}
      title={detail || label}
      aria-hidden="true"
    >
      {label}
    </span>,
    host,
  );
}
