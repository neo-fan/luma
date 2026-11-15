import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { api } from "../lib/invoke";

export interface CacheSpeed {
  /** 反代从源站拉取的实时速率（字节/秒）；0 = 还没有读数。 */
  bytesPerSec: number;
  /** 当前播放位置之后已缓冲的秒数；0 = 缓冲不足或取不到。 */
  bufferedSec: number;
}

/** 轮询频率：1s 与用户对「速度」的刷新直觉一致，也远低于反代的日志噪声阈值。 */
const POLL_MS = 1000;
/** `proxy_status` 还没回来时先按默认端口探一次；端口被占会回退，下一轮就纠正。 */
const FALLBACK_BASE = "http://127.0.0.1:9978";

function bufferedAhead(video: HTMLVideoElement): number {
  const time = video.currentTime;
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (time >= video.buffered.start(index) && time <= video.buffered.end(index)) {
      return Math.max(0, Math.round(video.buffered.end(index) - time));
    }
  }
  return 0;
}

/**
 * 播放器的「缓存速度」读数。
 *
 * 速率来自反代的 `/meter`（唯一知道真实下载量的地方，见
 * `domain/proxy/speed.rs`），缓冲时长来自 `<video>` 自身的 buffered 区间。
 * 两者都不进 React 状态树之外的地方：HUD 只是展示，不该影响播放内核。
 */
export function useCacheSpeed(
  videoRef: RefObject<HTMLVideoElement | null>,
  active: boolean,
): CacheSpeed {
  const [bytesPerSec, setBytesPerSec] = useState(0);
  const [bufferedSec, setBufferedSec] = useState(0);

  useEffect(() => {
    if (!active) {
      setBytesPerSec(0);
      setBufferedSec(0);
      return;
    }

    let disposed = false;
    let base = FALLBACK_BASE;
    // 端口可能在播放中途才确定（反代异步启动），拿到就改，下一轮用新地址。
    void api
      .proxyStatus()
      .then((status) => {
        if (!disposed && status.baseUrl) {
          base = status.baseUrl;
        }
      })
      .catch(() => {
        /* 读不到就继续用默认端口；HUD 不该因为诊断信息缺失而消失 */
      });

    const tick = () => {
      void fetch(`${base}/meter`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { bytesPerSec?: unknown } | null) => {
          if (disposed) {
            return;
          }
          const rate = data?.bytesPerSec;
          setBytesPerSec(typeof rate === "number" && rate > 0 ? rate : 0);
        })
        .catch(() => {
          if (!disposed) {
            setBytesPerSec(0);
          }
        });
      const video = videoRef.current;
      setBufferedSec(video ? bufferedAhead(video) : 0);
    };

    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [active, videoRef]);

  return { bytesPerSec, bufferedSec };
}
