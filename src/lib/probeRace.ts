/**
 * 线路探活竞速：并发探几条候选线路，取第一条真能播的。
 *
 * 之前的实现是**串行**：一条一条 `resolvePlayerContent → resolvePlay → 探活`，
 * 每条失败线路要花 2–5 秒（网盘 token 的 playerContent 本身就要 4–10 秒才回）。
 * 实测「布布追剧 → 走马上任」从点第 3 集到出画要 16 秒，用户以为坏了。
 *
 * 这里把它改成小并发竞速：第一个成功立刻中止其余请求并返回，用户等待时间
 * 从「各条之和」降到「最快那条」。
 *
 * 纯逻辑、无 React 依赖，便于单测（`src/lib/probeRace.test.ts`）。
 */

export interface RaceCandidate {
  /** 线路名（`vod_play_from` 的一段），切换时要带回播放页。 */
  line: string;
  /** 集名，用于提示文案。 */
  name: string;
  /** 原始剧集地址（可能是私有 token，交给 probe 去解）。 */
  url: string;
}

export interface RaceOptions {
  /** 同时在跑的探活数量。3–4 条足够：再多会把源站打限流。 */
  concurrency?: number;
  /** 外部中止（组件卸载 / 已经开始新一次切换）。 */
  signal?: AbortSignal;
}

/**
 * 依次/并发探测候选，返回第一个可播的；全失败返回 `null`。
 *
 * `probe` 返回 `true` 表示这条线路能播；抛异常按失败处理（源站超时、解析池
 * 全灭都走这条）。一旦有结果，其余进行中的 probe 会通过同一个
 * `AbortSignal` 收到中止信号——它们内部若尊重 signal 就能提前退出，
 * 不尊重也不会影响结果（结果只取第一个）。
 */
export async function firstPlayable(
  candidates: RaceCandidate[],
  probe: (candidate: RaceCandidate, signal: AbortSignal) => Promise<boolean>,
  options: RaceOptions = {},
): Promise<RaceCandidate | null> {
  if (candidates.length === 0) {
    return null;
  }
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, candidates.length));
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    controller.abort();
  }

  let next = 0;
  let settled = false;

  const runOne = async (): Promise<RaceCandidate | null> => {
    while (!settled && !controller.signal.aborted) {
      const index = next;
      next += 1;
      if (index >= candidates.length) {
        return null;
      }
      const candidate = candidates[index];
      let ok = false;
      try {
        ok = await probe(candidate, controller.signal);
      } catch {
        ok = false;
      }
      if (settled) {
        return null;
      }
      if (ok) {
        settled = true;
        controller.abort();
        return candidate;
      }
    }
    return null;
  };

  try {
    const workers = Array.from({ length: concurrency }, () => runOne());
    const results = await Promise.all(workers);
    return results.find((hit): hit is RaceCandidate => hit !== null) ?? null;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    // 全部失败也要收尾，避免还有 worker 挂在 source 请求上。
    controller.abort();
  }
}
