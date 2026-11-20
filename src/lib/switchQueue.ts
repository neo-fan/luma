/**
 * 串行合并队列：同一时刻只有一个在跑，跑的过程中新请求只保留最后一个。
 *
 * 用于原地换集。两个要求同时成立才不互相矛盾：
 * - 不能并发：两路 `switchUrl` 会互相覆盖，后完成者赢，画面会跳回旧集；
 * - 不能丢：用户在切换没回来时点的下一集是他的最新意图，丢掉就等于「点了没反应」。
 *
 * 所以：忙时把意图存成 pending（覆盖式合并），当前一次收口后立刻执行 pending。
 * burst 内多次点击只解析最后一次，省掉中间集的解析往返与画面闪动。
 */

export interface QueueItem<T> {
  /** 执行一次请求；抛错由调用方自己处理，队列只负责继续推进。 */
  run: (target: T) => Promise<void>;
  /** 判等：连续两次同一目标不必重复执行。默认引用相等。 */
  equals?: (a: T, b: T) => boolean;
  /** 执行器抛错时的出口（不吞异常，也不影响队列继续工作）。 */
  onError?: (error: unknown, target: T) => void;
}

export interface SwitchQueue<T> {
  /** 提出请求：空闲立即执行，忙则覆盖 pending。 */
  request: (target: T) => void;
  /** 是否有一次执行正在进行。 */
  isBusy: () => boolean;
  /** 正在执行的目标（同步可见：request 里先置 running 再起协程）。 */
  peekRunning: () => T | null;
  /** 已请求但尚未开始执行的目标（UI 用它表达「排队中」）。 */
  peekPending: () => T | null;
  /** 丢弃未执行的意图（换源、路由变化、卸载）。正在跑的那次不受影响。 */
  cancelPending: () => void;
}

export function createSwitchQueue<T>(options: QueueItem<T>): SwitchQueue<T> {
  const { run, onError } = options;
  const equals = options.equals ?? ((a: T, b: T) => a === b);
  let running: T | null = null;
  let pending: T | null = null;

  const drain = () => {
    if (running !== null || pending === null) {
      return;
    }
    const target = pending;
    running = target;
    pending = null;
    void run(target)
      .catch((error) => {
        onError?.(error, target);
      })
      .finally(() => {
        running = null;
        drain();
      });
  };

  return {
    request: (target) => {
      // 同一个目标已在执行或已在队列里：不重复排。
      if (
        (running !== null && equals(running, target)) ||
        (pending !== null && equals(pending, target))
      ) {
        return;
      }
      pending = target;
      drain();
    },
    isBusy: () => running !== null,
    peekRunning: () => running,
    peekPending: () => pending,
    cancelPending: () => {
      pending = null;
    },
  };
}
