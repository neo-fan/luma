/**
 * 首帧前的海报 / 冻结帧保持。
 *
 * ArtPlayer 在 `video:play` 就把 poster 设成 display:none，而 play 早于首帧解码，
 * 画面会掉进黑屏加转圈；这里接管退场时机：盖到 `playing` 或 `readyState>=3` 的
 * timeupdate，再渐隐。失败路径用 `finish(false)` 硬撤，静帧不允许盖住后续画面。
 *
 * `onPlay` 由调用方把 ArtPlayer 的 on/off("video:play") 包成「注册即返回撤销」，
 * 因此本模块不依赖 ArtPlayer，可在 node 下测。
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


        // 但必须排除暂停态：缓冲期间 timeupdate 也会来，那时首帧还没出画，
        // 渐隐会露出黑屏。
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
