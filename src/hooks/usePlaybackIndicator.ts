import { useEffect } from "react";
import type { RefObject } from "react";
import { useAppStore } from "../stores/appStore";

/**
 * 把播放器实例的播放/暂停同步到全局状态。
 *
 * 播放页与直播页都是常驻层（切页只隐藏不卸载），所以「还在放」这件事必须记在
 * store 里：侧栏图标据此亮一个小圆点，用户才知道切走的页面还在出声、能切回来。
 *
 * `resolved` 作为依赖是刻意的：换集/换源/换台都会重建 ArtPlayer，新的 <video>
 * 必须重新挂监听；`videoRef` 本身是稳定引用，进 deps 不会重跑。
 */
export function usePlaybackIndicator(
  videoRef: RefObject<HTMLVideoElement | null>,
  kind: "vod" | "live",
  resolved: unknown,
): void {
  const setMediaPlaying = useAppStore((state) => state.setMediaPlaying);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      setMediaPlaying(kind, false);
      return;
    }
    const sync = () => {
      // 播完（ended）算停止：进度条已经到底，图标不该继续亮着。
      setMediaPlaying(kind, !video.paused && !video.ended);
    };
    sync();
    video.addEventListener("play", sync);
    video.addEventListener("playing", sync);
    video.addEventListener("pause", sync);
    video.addEventListener("ended", sync);
    return () => {
      video.removeEventListener("play", sync);
      video.removeEventListener("playing", sync);
      video.removeEventListener("pause", sync);
      video.removeEventListener("ended", sync);
      setMediaPlaying(kind, false);
    };
  }, [videoRef, kind, resolved, setMediaPlaying]);
}
