import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { SHORT_UI_TICK_MS } from "../lib/constants";

/**
 * 播放器「被别的实例硬停后原地复活」。
 *
 * `lib/playerRegistry` 的全局唯一守卫在建新实例前会硬停「非本容器」的 `<video>`
 * （根治双声）。从直播页回点播、或从点播回直播时，常驻层里的旧播放器可能已被
 * 摘掉 src / 销毁，但路由侧 `resolved` 没变 → 引擎 effect 不会重跑，画面黑屏。
 *
 * 点播页和直播页此前各写了一遍同样的轮询（500ms×3 判死 + 4s 节流），这里收口。
 * 注意这是**守卫机制的配套观察**，不是播放器生命周期本身：只有 cross-page 夺用
 * 才会触发，正常换集/换源不经过这里。
 */
interface Options {
  /** 页面是否处于激活态（点播 active / 直播 liveActive）。 */
  active: boolean;
  /** 已有解析结果才需要观察；null 时由正常解析流程接管。 */
  hasResolved: boolean;
  containerRef: RefObject<HTMLElement | null>;
  /** 判定被杀后要执行的恢复动作（两页各自 reparse/reload）。 */
  revive: () => void;
}

/** 最多探几轮：前几轮没有 video 只是实例还没建，多给几轮别误判冷启动。 */
const MAX_PROBE_TRIES = 3;
/** 成功复活后的冷却时间，避免来回切页时反复重解析。 */
const REVIVE_COOLDOWN_MS = 4_000;

export function usePlayerRevive({
  active,
  hasResolved,
  containerRef,
  revive,
}: Options): void {
  const lastReviveAt = useRef(0);

  useEffect(() => {
    if (!active || !hasResolved) {
      return;
    }
    if (Date.now() - lastReviveAt.current < REVIVE_COOLDOWN_MS) {
      return;
    }
    let stopped = false;
    let tries = 0;
    let timer = 0;
    const check = () => {
      if (stopped) {
        return;
      }
      const video = containerRef.current?.querySelector("video") ?? null;
      if (video && (video.getAttribute("src") || video.currentSrc)) {
        stopped = true;
        return;
      }
      const killed = Boolean(video) || tries >= MAX_PROBE_TRIES;
      if (killed) {
        stopped = true;
        lastReviveAt.current = Date.now();
        revive();
        return;
      }
      tries += 1;
      timer = window.setTimeout(check, SHORT_UI_TICK_MS);
    };
    timer = window.setTimeout(check, SHORT_UI_TICK_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    // revive 两页都是内联闭包，进依赖会每次渲染重挂；用 ref 承接最新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, hasResolved, containerRef]);
}
