/**
 * 首帧前的海报 / 冻结帧保持（2.0.0 从 `usePlayerEngine` 抽出）。
 *
 * ArtPlayer 默认在 `video:play` 就把 poster 设成 `display:none`——而 play 事件在
 * HLS 清单解析完调 `play()` 的那一刻就触发，首帧根本还没解码出来，画面随即掉进
 * 「黑屏 + 转圈」。这里接管 poster 的退场时机：一直盖到新源真正出画（`playing`，
 * 或 `readyState>=3` 的 `timeupdate`），再 250ms 渐隐。
 *
 * 失败路径（`<video>` error / hls fatal / 看门狗判死）必须能**立刻**撤掉它：
 * 冻结帧只是过渡，绝不允许永久盖住画面 —— 那是 `finish(false)`。
 *
 * 只做样式与监听，不认 ArtPlayer：`onPlay` 由调用方把 `art.on/off("video:play")`
 * 包成一个「注册即返回撤销」的函数，因此这台可以在 node 下用假元素测。
 */

/** 只用得到 style 的四个属性 + 媒体状态；真实 `<video>` / `<div>` 结构上满足。 */
export interface PosterElement {
  style: {
    transition: string;
    opacity: string;
    backgroundImage: string;
    display: string;
  };
}

export interface PosterVideo {
  readonly paused: boolean;
  readonly readyState: number;
  addEventListener: HTMLVideoElement["addEventListener"];
  removeEventListener: HTMLVideoElement["removeEventListener"];
}

export interface PosterHoldOptions {
  poster: PosterElement;
  video: PosterVideo;
  /** 订阅 ArtPlayer 的 `video:play`，返回撤销函数。 */
  onPlay: (callback: () => void) => () => void;
  timer?: (callback: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
  /** 渐隐的 CSS 时长与清图定时器时长（默认 250 / 300ms，定时器多留 50ms 保险）。 */
  fadeMs?: number;
}

export interface PosterHold {
  /** 开始保持：显示 poster，并接管 ArtPlayer 的退场时机。可重复调用（先收再挂）。 */
  hold: () => void;
  /** 结束保持。`fade=true` 渐隐后再清图；`false` 立即硬撤（失败路径）。 */
  finish: (fade: boolean) => void;
  /** 是否正在保持中。 */
  readonly active: boolean;
  /** 卸载：摘监听与定时器（幂等）。 */
  dispose: () => void;
}

const CSS_FADE = "opacity 250ms ease";
/** 清图定时器相对 CSS 时长的余量：提前清会闪一帧黑底。 */
const FADE_TAIL_MS = 50;

export function createPosterHold(options: PosterHoldOptions): PosterHold {
  const { poster, video } = options;
  const timer = options.timer ?? ((cb, ms) => window.setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle));
  const fadeMs = options.fadeMs ?? 250;

  let active = false;
  let undoArtPlay: (() => void) | null = null;
  let onPlaying: (() => void) | null = null;
  let onTimeUpdate: (() => void) | null = null;
  let fadeTimer: number | null = null;

  const clearVisual = () => {
    poster.style.transition = "";
    poster.style.opacity = "";
    // 不能用 `art.poster = ""`：ArtPlayer 会拼成 `url()`，空值是非法 CSS，
    // 浏览器直接忽略这次赋值，旧图就永远留在层上。直接清 style。
    poster.style.backgroundImage = "";
    poster.style.display = "none";
  };

  const release = () => {
    active = false;
    undoArtPlay?.();
    undoArtPlay = null;
    if (onPlaying) {
      video.removeEventListener("playing", onPlaying);
      onPlaying = null;
    }
    if (onTimeUpdate) {
      video.removeEventListener("timeupdate", onTimeUpdate);
      onTimeUpdate = null;
    }
    if (fadeTimer !== null) {
      clearTimer(fadeTimer);
      fadeTimer = null;
    }
  };

  const finish = (fade: boolean) => {
    release();
    if (!fade) {
      clearVisual();
      return;
    }
    poster.style.transition = CSS_FADE;
    poster.style.opacity = "0";
    fadeTimer = timer(() => {
      fadeTimer = null;
      clearVisual();
    }, fadeMs + FADE_TAIL_MS);
  };

  return {
    get active() {
      return active;
    },
    hold: () => {
      // 连续快速换集：先收掉上一轮的监听，再按当前帧重新保持。
      release();
      active = true;
      poster.style.transition = "";
      poster.style.opacity = "";
      poster.style.display = "";
      // ArtPlayer 内部的 video:play 监听先于我们注册，会把 display 设成 none；
      // 同一事件里我们的回调后执行，把它抬回来，poster 才能盖到首帧。
      undoArtPlay = options.onPlay(() => {
        if (active) {
          poster.style.display = "";
        }
      });
      onPlaying = () => {
        if (active) {
          finish(true);
        }
      };
      onTimeUpdate = () => {
        // `playing` 在个别源上会丢（缓冲态翻来覆去），timeupdate + 足够缓冲兜底。
        // 但必须排除暂停态：缓冲期间 timeupdate 也会来，那时首帧还没出画，
        // 渐隐会露出黑屏（2026-11-15 实测）。
        if (active && !video.paused && video.readyState >= 3) {
          finish(true);
        }
      };
      video.addEventListener("playing", onPlaying);
      video.addEventListener("timeupdate", onTimeUpdate);
    },
    finish,
    dispose: release,
  };
}
