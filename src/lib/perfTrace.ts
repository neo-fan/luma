/**
 * IPC 耗时环形缓冲：给性能链路分析用的轻量采样，不写日志、不落盘。
 *
 * 为什么单独做：`switchTrace` 只覆盖解析/切台两个业务点，`logger` 只记失败 IPC；
 * 「每个 command 花了多久」这件事此前完全没有可观测面，性能问题只能靠猜。
 * 这里在 `invoke.ts` 的 `call()` 单点挂一个计时器，把结果放进固定容量缓冲，
 * CDP 探针用 `readIpcSamples()` 一次取走。
 *
 * 约束：
 * - 只在 dev（`import.meta.env.DEV`）采集；生产构建里 `record` 是 no-op，
 *   连 Date.now() 都不调，避免给每条 IPC 增加开销。
 * - 固定容量、覆盖最旧：长时间运行也不能无限增长。
 * - 不记录 args / 返回的业务数据，只留 cmd、耗时、结果类别——播放直链与配置
 *   地址绝不能进可导出缓冲。
 */
export interface IpcSample {
  /** 相对页面加载的毫秒（performance.now()），与前端 trace / CDP 时间线对齐。 */
  at: number;
  cmd: string;
  ms: number;
  outcome: "ok" | "err";
  /** 失败码（成功时省略），用于区分业务失败与 IPC_TIMEOUT。 */
  code?: string;
}

const CAPACITY = 500;
const ENABLED = import.meta.env.DEV;

const samples: IpcSample[] = [];

/** 在 `call()` 的成功/失败出口调用；非 dev 下立即返回。 */
export function recordIpcSample(
  cmd: string,
  startedAt: number,
  outcome: "ok" | "err",
  code?: string,
): void {
  if (!ENABLED) {
    return;
  }
  const sample: IpcSample = {
    at: Math.round(startedAt),
    cmd,
    ms: Math.round(performance.now() - startedAt),
    outcome,
    ...(code ? { code } : {}),
  };
  if (samples.length >= CAPACITY) {
    samples.shift();
  }
  samples.push(sample);
}

/**
 * 读取并清空缓冲。 analyse 工具每次采样后取走，避免重复统计；
 * 分页/多次采样由调用方自行拼接。
 */
export function drainIpcSamples(): IpcSample[] {
  return samples.splice(0, samples.length);
}

/**
 * 单站耗时分解采样（聚合搜索每站一行）。
 *
 * 为什么在 perfTrace 里而不是页面里：搜索页只关心「结果和失败原因」，
 * 耗时分解属于诊断面，且必须在 dev 才采集。挂在这里让 `invoke.ts` 的
 * `onSearchChunk` 单点接入，任何消费方（首页 / 搜索页 / 未来的聚合面板）
 * 都不用重复埋点。
 */
export interface SiteTimingSample {
  /** 相对页面加载的毫秒，便于和 IPC 采样放在同一条时间线上。 */
  at: number;
  siteKey: string;
  queueMs: number;
  runMs: number;
  doneMs: number;
  status: "ok" | "failed" | "timeout";
}

const TIMING_CAPACITY = 400;
const timings: SiteTimingSample[] = [];

/** 在 `onSearchChunk` 收到行时调用；无 `timing`（旧后端）则跳过。 */
export function recordSiteTiming(row: {
  siteKey: string;
  timing?: {
    queueMs: number;
    runMs: number;
    doneMs: number;
    status: "ok" | "failed" | "timeout";
  };
}): void {
  if (!ENABLED || !row.timing) {
    return;
  }
  if (timings.length >= TIMING_CAPACITY) {
    timings.shift();
  }
  timings.push({
    at: Math.round(performance.now()),
    siteKey: row.siteKey,
    ...row.timing,
  });
}

/** 读取并清空站点耗时缓冲；与 `drainIpcSamples` 同一次采样窗口消费。 */
export function drainSiteTimings(): SiteTimingSample[] {
  return timings.splice(0, timings.length);
}
