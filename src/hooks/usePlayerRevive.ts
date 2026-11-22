import { useCallback, useEffect, useRef } from "react";

/**
 * 播放器「被另一个实例夺用后原地复活」。
 *
 * `lib/playerRegistry` 的全局唯一守卫在建新实例前会硬停「非本容器」的 `<video>`
 * （根治双声）。常驻层（直播）与后台点播页都不卸载，被夺用时 video 被摘掉 src、
 * 引擎 effect 不会重跑 → 切回前台只剩空壳画面。
 *
 * 状态来自守卫的明确通知，不轮询 DOM 猜 src。两个场景都要覆盖：
 *  1. 前台被夺用（用户点了另一个播放器）→ 立即 revive；
 *  2. 后台被夺用（常驻层让位）→ 记下事实，等 active 变 true 再 revive。
 *
 * `pendingRef` 存的是「被夺用」这个**状态事实**，不是防抖 flag：它由守卫的
 * 通知置位、由 revive 消费，没有时间窗，也不靠猜。
 */
interface Options {
  /** 本页是否为当前激活的播放视图。 */
  active: boolean;
  /** 恢复动作（两页各自 reparse/reload）。 */
  revive: () => void;
}

export interface PlayerReviveChannel {
  /** 传给 usePlayerEngine 的 onDisplaced。 */
  onDisplaced: () => void;
}

export function usePlayerRevive({ active, revive }: Options): PlayerReviveChannel {
  const reviveRef = useRef(revive);
  reviveRef.current = revive;
  const pendingRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => () => {
    aliveRef.current = false;
  }, []);

  const onDisplaced = useCallback(() => {
    if (!aliveRef.current) {
      return;
    }
    // 活跃页立即恢复；后台页记账，等切回前台的 effect 处理。
    // 注意这里读的是调用时的 active 快照，由 ref 提供避免重建回调。
    if (activeRef.current) {
      reviveRef.current();
    } else {
      pendingRef.current = true;
    }
  }, []);

  const activeRef = useRef(active);
  activeRef.current = active;

  // 切回前台：消费后台期间积累的被夺用事实。
  useEffect(() => {
    if (active && pendingRef.current) {
      pendingRef.current = false;
      reviveRef.current();
    }
  }, [active]);

  return { onDisplaced };
}
