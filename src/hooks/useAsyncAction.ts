/**
 * 单车道异步操作的 busy 状态：**一个 key 在跑时拒绝新的触发，结束必释放**。
 *
 * 历史 / 收藏 / 加速代理 / 存储清理四处都手写过 `if (busy) return; setBusy(key);
 * try { await ... } finally { setBusy("") }`。这类写法有两个反复踩过的坑：
 *  1. `busy` 取自渲染闭包，连续两次点击落在同一帧时第二次仍读到旧值 —— 用 ref 判等；
 *  2. `await` 的 promise 若悬挂（IPC 在主线程排队），`finally` 永远不来，按钮永久
 *     disabled。IPC 层已有统一超时兜底，但 busy 的生命周期仍不该依赖每个调用方写对。
 *
 * 收成此处后，调用方只管 `await run(key, async () => { ... })`：并发被挡、异常照抛、
 * 释放由 hook 保证。`run` 在被拒绝时返回 `undefined`，调用方据此区分「没执行」。
 */
import { useCallback, useRef, useState } from "react";

export interface AsyncAction<TKey> {
  /** 当前正在执行的操作 key；空闲为 null。 */
  busy: TKey | null;
  /** 该 key 是否正在执行。 */
  isBusy: (key: TKey) => boolean;
  /**
   * 在单车道里执行 fn；已有操作在跑时直接返回 undefined（不抛、不执行）。
   * fn 的异常原样上抛，由调用方决定如何展示；无论如何都会释放 busy。
   */
  run: <T>(key: TKey, fn: () => Promise<T>) => Promise<T | undefined>;
  /** 强制释放（组件卸载后的兜底，正常用不到）。 */
  reset: () => void;
}

export function useAsyncAction<TKey>(equals: (a: TKey, b: TKey) => boolean = Object.is): AsyncAction<TKey> {
  const [busy, setBusy] = useState<TKey | null>(null);
  // ref 而非 state 判等：同一帧的连续点击必须看到最新的在途 key。
  const runningRef = useRef<TKey | null>(null);

  const reset = useCallback(() => {
    runningRef.current = null;
    setBusy(null);
  }, []);

  const isBusy = useCallback(
    (key: TKey) => {
      const running = runningRef.current;
      return running !== null && equals(running, key);
    },
    [equals],
  );

  const run = useCallback(
    async <T,>(key: TKey, fn: () => Promise<T>): Promise<T | undefined> => {
      if (runningRef.current !== null) {
        return undefined;
      }
      runningRef.current = key;
      setBusy(key);
      try {
        return await fn();
      } finally {
        // 只有仍是自己时才释放：极端情况下 reset 被外部调用过，别把新操作清掉。
        if (equals(runningRef.current, key)) {
          runningRef.current = null;
          setBusy(null);
        }
      }
    },
    [equals],
  );

  return { busy, isBusy, run, reset };
}
