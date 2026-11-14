import { useCallback, useEffect, useRef, useState } from "react";

export interface NoticeCountdown {
  /** 剩余秒数（向上取整后的整数，直接用于展示）。 */
  left: number;
  /** 总时长秒数；0 表示不自动消失。 */
  total: number;
  /** 剩余比例 0~1，给进度线用。 */
  progress: number;
  /** 到点后为 true：调用方据此隐藏（或让 ErrorBar 返回 null）。 */
  expired: boolean;
  /** 鼠标进入提示区：冻结倒计时（正在读/复制时不该被抽走）。 */
  hold: () => void;
  release: () => void;
}

/**
 * 提示倒计时原语：一个时钟同时驱动「剩余秒数」「进度线」「到点隐藏」。
 *
 * 为什么不用 setTimeout + CSS 动画两套：两者一旦漂移，用户会看到「秒数还是 2s，
 * 进度条已经空了」或者「进度条还在走，提示先没了」。这里只有一个 interval，
 * 进度由 `left / total` 直接算出来，永远同源。
 *
 * 为什么 hover 是「跳过一次扣减」而不是 clearInterval：重新建 interval 会让
 * 秒数出现 ±1s 的漂移；跳过扣减则只是把这一秒顺延，视觉上进度线停住、秒数不
 * 变，松手继续走，符合用户对「暂停」的直觉。
 */
export function useNoticeCountdown(ttlMs?: number): NoticeCountdown {
  const total = ttlMs && ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0;
  const [left, setLeft] = useState(total);
  const [expired, setExpired] = useState(false);
  const heldRef = useRef(false);

  useEffect(() => {
    setExpired(false);
    if (total === 0) {
      setLeft(0);
      return;
    }
    setLeft(total);
    let remain = total;
    const timer = window.setInterval(() => {
      if (heldRef.current) {
        return;
      }
      remain -= 1;
      setLeft(Math.max(remain, 0));
      if (remain <= 0) {
        window.clearInterval(timer);
        setExpired(true);
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [total]);

  const hold = useCallback(() => {
    heldRef.current = true;
  }, []);
  const release = useCallback(() => {
    heldRef.current = false;
  }, []);

  return {
    left,
    total,
    progress: total > 0 ? Math.max(left, 0) / total : 0,
    expired,
    hold,
    release,
  };
}
