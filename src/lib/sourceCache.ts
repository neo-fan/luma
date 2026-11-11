/**
 * 换源候选缓存（搜索 / 详情 / 播放页共享的进程内单例）。
 *
 * 旧行为：点「⇄ 换源」时面板才发一次 20s 全站聚合搜索，即使搜索页刚把
 * 同一批结果拉回来过。现在拆成三段，点开面板不再触发检索：
 *   1. 搜索页把聚合行 `publish()` 进来，按片名同步派生「每站最佳候选」；
 *   2. 详情 / 播放页挂载后 `prefetch()`：只有当搜索词不等于完整片名时才
 *      后台补一次精确片名检索，串行 + in-flight 去重，不阻塞 UI；
 *   3. `view()` 是纯同步读，面板打开即用；后台结果到达后 `subscribe()`
 *      通知面板合并，用户无需刷新。
 *
 * 缓存的是「精简聚合行」而不是派生结果：同一份搜索结果可以给所有点开的
 * 影片复用，片名打分在读取时做（几百条条目、毫秒级），也不必为每个片名
 * 预建索引。切源需要的详情由 `warmDetails()` 提前写进 pageCache，切换时
 * 详情页 / 播放页首屏即命中。
 */
import { normalizeTitle } from "./format";
import { api } from "./invoke";
import {
  collectSourceOptions,
  EMPTY_SOURCE_STATS,
  fetchSourceRows,
} from "./sources";
import type {
  AggregateRow,
  SourceOption,
  SourceRowLike,
  SourceSearchStats,
  SourceSite,
} from "./sources";
import type { Site } from "../types/tvbox";

export const SOURCE_CACHE_TTL = 10 * 60_000;
/** 最多保留最近几次检索的行；一次真实配置约 300~400 条，8 份足够。 */
const MAX_BUNDLES = 8;
const PREFETCH_TIMEOUT_MS = 20_000;
const WARM_LIMIT = 4;

export type SourceOrigin = "search" | "prefetch" | "manual";

/** 一次聚合检索的原始行 + 当时的站点快照。 */
export interface SourceBundle {
  keyword: string;
  rows: SourceRowLike[];
  stats: SourceSearchStats;
  sites: SourceSite[];
  storedAt: number;
  origin: SourceOrigin;
}

/** 面板直接消费的视图；全部由缓存同步派生，不携带 Promise。 */
export interface SourceView {
  options: SourceOption[];
  stats: SourceSearchStats;
  /** 结果来自哪类检索，多个 bundle 合并时为 mixed。 */
  origin: SourceOrigin | "mixed" | "none";
  /** 已有一次「按该片名」的完整检索，无需后台补全。 */
  complete: boolean;
  /** 后台补全正在进行。 */
  pending: boolean;
  /** 有可直接展示的缓存结果（点开面板 0 IPC）。 */
  cached: boolean;
  ageMs?: number;
}

export interface SourceCacheStats {
  scope: string;
  bundles: number;
  publishes: number;
  /** 实际发出的全站聚合 IPC 次数，探针用它验证「点换源不重新检索」。 */
  aggregateCalls: number;
  prefetches: number;
  derivedHits: number;
  pending: number;
}

export interface SourceCache {
  publish(
    keyword: string,
    rows: readonly AggregateRow[],
    sites: readonly Site[],
    stats: SourceSearchStats,
    origin: SourceOrigin,
  ): void;
  view(title: string, sites: readonly Site[], excludeSiteKey?: string): SourceView;
  ensure(
    title: string,
    sites: readonly Site[],
    excludeSiteKey?: string,
    options?: { force?: boolean; timeoutMs?: number },
  ): Promise<SourceView>;
  refresh(
    word: string,
    sites: readonly Site[],
    excludeSiteKey: string,
    timeoutMs?: number,
  ): Promise<SourceView>;
  /** 后台预取，fire-and-forget；重复调用幂等。 */
  prefetch(title: string, sites: readonly Site[]): void;
  /** 预热前几个候选的 detailContent，让「切换」即时出画。 */
  warmDetails(options: readonly SourceOption[]): Promise<void>;
  subscribe(listener: () => void): () => void;
  stats(): SourceCacheStats;
  setScope(scope: string): void;
  clear(): void;
}

export interface SourceCacheOptions {
  fetchRows?: (
    keyword: string,
    sites: readonly Site[],
    timeoutMs: number,
  ) => Promise<{ rows: AggregateRow[]; stats: SourceSearchStats }>;
  fetchDetail?: (siteKey: string, vodId: string) => Promise<unknown>;
  now?: () => number;
  ttlMs?: number;
}

const EMPTY_VIEW: SourceView = {
  options: [],
  stats: { ...EMPTY_SOURCE_STATS },
  origin: "none",
  complete: false,
  pending: false,
  cached: false,
};

/** 站点清单只需这四个字段；保存快照可避免配置刷新后名称/可用性丢失。 */
function siteSnapshot(sites: readonly Site[]): SourceSite[] {
  return sites.map(({ key, name, runtime, enabled }) => ({ key, name, runtime, enabled }));
}

/** 只保留派生候选需要的字段，避免整份 VodInfo 长期驻留。 */
function compactRows(rows: readonly AggregateRow[]): SourceRowLike[] {
  return rows.map((row) => ({
    siteKey: row.siteKey,
    ok: row.ok,
    data: row.ok && row.data?.list
      ? {
          list: row.data.list
            .filter((vod) => vod.vod_id && vod.vod_name)
            .map((vod) => ({
              vod_id: vod.vod_id,
              vod_name: vod.vod_name,
              vod_remarks: vod.vod_remarks,
              vod_pic: vod.vod_pic,
            })),
        }
      : undefined,
  }));
}

/**
 * 两个归一化片名是否可能指同一部片：相等、或一个是另一个的片段。
 * 后续仍会用 titleMatchScore 逐条打分，这里只是排除明显无关的搜索。
 */
function related(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  return a === b || a.includes(b) || b.includes(a);
}

function sortOptions(options: SourceOption[]): SourceOption[] {
  return options.sort(
    (a, b) => b.matchScore - a.matchScore || a.siteName.localeCompare(b.siteName, "zh-CN"),
  );
}

class MemorySourceCache implements SourceCache {
  private readonly bundles = new Map<string, SourceBundle>();
  private readonly pending = new Map<string, Promise<void>>();
  /** 已经按该片名做过完整检索；即使结果为空也不反复发 20s 请求。 */
  private readonly completeKeys = new Set<string>();
  private readonly warmed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly fetchRows: NonNullable<SourceCacheOptions["fetchRows"]>;
  private readonly fetchDetail: NonNullable<SourceCacheOptions["fetchDetail"]>;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private scope = "default";
  private queue: Promise<unknown> = Promise.resolve();
  private publishes = 0;
  private aggregateCalls = 0;
  private prefetches = 0;
  private derivedHits = 0;

  constructor(options: SourceCacheOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SOURCE_CACHE_TTL;
    this.fetchDetail = options.fetchDetail ?? ((siteKey, vodId) => api.detail(siteKey, vodId));
    this.fetchRows =
      options.fetchRows ??
      ((keyword, sites, timeoutMs) => fetchSourceRows(keyword, sites, timeoutMs));
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // 面板回调异常不应打断缓存写入。
      }
    }
  }

  private fresh(): SourceBundle[] {
    const now = this.now();
    const alive: SourceBundle[] = [];
    for (const [key, bundle] of this.bundles) {
      if (now - bundle.storedAt > this.ttlMs) {
        this.bundles.delete(key);
      } else {
        alive.push(bundle);
      }
    }
    return alive;
  }

  publish(
    keyword: string,
    rows: readonly AggregateRow[],
    sites: readonly Site[],
    stats: SourceSearchStats,
    origin: SourceOrigin,
  ): void {
    const word = keyword.trim();
    const key = normalizeTitle(word);
    if (!key) {
      return;
    }
    this.bundles.delete(key);
    this.bundles.set(key, {
      keyword: word,
      rows: compactRows(rows),
      stats: { ...stats },
      sites: siteSnapshot(sites),
      storedAt: this.now(),
      origin,
    });
    while (this.bundles.size > MAX_BUNDLES) {
      const oldest = this.bundles.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.bundles.delete(oldest);
    }
    this.publishes += 1;
    this.notify();
  }

  view(title: string, sites: readonly Site[], excludeSiteKey = ""): SourceView {
    const key = normalizeTitle(title);
    if (!key) {
      return { ...EMPTY_VIEW, pending: false };
    }
    const now = this.now();
    const bundles = this.fresh();
    const eligible: readonly SourceSite[] = sites;
    const merged = new Map<string, { option: SourceOption; origin: SourceOrigin; at: number }>();
    const origins = new Set<SourceOrigin>();
    let baseStats: SourceSearchStats = { ...EMPTY_SOURCE_STATS };
    let baseAt = 0;

    for (const bundle of bundles) {
      if (!related(normalizeTitle(bundle.keyword), key)) {
        continue;
      }
      const options = collectSourceOptions(
        bundle.rows,
        title,
        eligible.length > 0 ? eligible : bundle.sites,
        excludeSiteKey,
      );
      if (options.length === 0) {
        continue;
      }
      origins.add(bundle.origin);
      if (bundle.storedAt >= baseAt) {
        baseStats = bundle.stats;
        baseAt = bundle.storedAt;
      }
      for (const option of options) {
        const previous = merged.get(option.siteKey);
        // 同站取片名最匹配的一条；同分用更新的检索结果。
        if (
          !previous ||
          option.matchScore > previous.option.matchScore ||
          (option.matchScore === previous.option.matchScore && bundle.storedAt > previous.at)
        ) {
          merged.set(option.siteKey, {
            option,
            origin: bundle.origin,
            at: bundle.storedAt,
          });
        }
      }
    }

    const options = sortOptions([...merged.values()].map((item) => item.option));
    if (options.length > 0) {
      this.derivedHits += 1;
    }
    const exact = bundles.some(
      (bundle) =>
        normalizeTitle(bundle.keyword) === key &&
        (bundle.origin !== "search" || bundle.stats.total > 0),
    );
    return {
      options,
      stats: {
        ...baseStats,
        matched: options.filter((item) => item.matchScore >= 2).length,
      },
      origin: origins.size === 0 ? "none" : origins.size === 1 ? [...origins][0] : "mixed",
      complete: exact || this.completeKeys.has(key),
      pending: this.pending.has(key),
      cached: options.length > 0,
      ageMs: baseAt > 0 ? now - baseAt : undefined,
    };
  }

  async ensure(
    title: string,
    sites: readonly Site[],
    excludeSiteKey = "",
    options: { force?: boolean; timeoutMs?: number } = {},
  ): Promise<SourceView> {
    const word = title.trim();
    const key = normalizeTitle(word);
    if (!key) {
      return this.view(word, sites, excludeSiteKey);
    }
    const current = this.view(word, sites, excludeSiteKey);
    if (!options.force && (this.completeKeys.has(key) || current.complete)) {
      return current;
    }

    const inflight = this.pending.get(key);
    if (inflight && !options.force) {
      try {
        await inflight;
      } catch {
        // 失败由调用方展示，这里仍返回当前缓存视图。
      }
      return this.view(word, sites, excludeSiteKey);
    }

    const scopeAtStart = this.scope;
    const timeoutMs = options.timeoutMs ?? PREFETCH_TIMEOUT_MS;
    const task = (async () => {
      this.aggregateCalls += 1;
      const result = await this.fetchRows(word, sites, timeoutMs);
      // 配置切换后旧请求的结果不能写进新 scope。
      if (scopeAtStart !== this.scope) {
        return;
      }
      this.publish(word, result.rows, sites, result.stats, options.force ? "manual" : "prefetch");
      this.completeKeys.add(key);
      if (!options.force) {
        this.prefetches += 1;
      }
    })().finally(() => {
      this.pending.delete(key);
      this.notify();
    });
    this.pending.set(key, task);
    this.notify(); // 面板据此显示「正在后台补全其它源」
    if (options.force) {
      // 手动「重新搜索」要把失败暴露给面板；后台预取则静默降级到现有缓存。
      await task;
    } else {
      try {
        await task;
      } catch {
        // 预取失败保留搜索缓存，不打扰用户。
      }
    }
    return this.view(word, sites, excludeSiteKey);
  }

  refresh(
    word: string,
    sites: readonly Site[],
    excludeSiteKey: string,
    timeoutMs = PREFETCH_TIMEOUT_MS,
  ): Promise<SourceView> {
    return this.ensure(word, sites, excludeSiteKey, { force: true, timeoutMs });
  }

  prefetch(title: string, sites: readonly Site[]): void {
    const key = normalizeTitle(title);
    if (!key || sites.length === 0) {
      return;
    }
    if (this.completeKeys.has(key) || this.pending.has(key)) {
      return;
    }
    const current = this.view(title, sites);
    if (current.complete) {
      // 搜索词就是完整片名：搜索结果已经是全量，无需再检索一次。
      this.completeKeys.add(key);
      return;
    }
    // 从搜索结果连续点开多部影片时串行预取，避免同时扇出多次 20s 聚合。
    this.queue = this.queue
      .then(() => this.ensure(title, sites))
      .catch(() => undefined);
    void this.queue;
  }

  async warmDetails(options: readonly SourceOption[]): Promise<void> {
    const targets = options
      .filter((option) => option.matchScore >= 2)
      .slice(0, WARM_LIMIT)
      .filter((option) => !this.warmed.has(`${option.siteKey}:${option.vodId}`));
    if (targets.length === 0) {
      return;
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const option = targets[cursor++];
        this.warmed.add(`${option.siteKey}:${option.vodId}`);
        try {
          await this.fetchDetail(option.siteKey, option.vodId);
        } catch {
          // 预热是纯优化：失败时切源仍会按需拉详情。
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stats(): SourceCacheStats {
    return {
      scope: this.scope,
      bundles: this.bundles.size,
      publishes: this.publishes,
      aggregateCalls: this.aggregateCalls,
      prefetches: this.prefetches,
      derivedHits: this.derivedHits,
      pending: this.pending.size,
    };
  }

  setScope(scope: string): void {
    const next = scope || "default";
    if (next === this.scope) {
      return;
    }
    this.scope = next;
    this.clear();
  }

  clear(): void {
    this.bundles.clear();
    this.pending.clear();
    this.completeKeys.clear();
    this.warmed.clear();
    this.queue = Promise.resolve();
    this.notify();
  }
}

/** 供单测注入假检索 / 假时钟；应用代码用下面的单例。 */
export function createSourceCache(options?: SourceCacheOptions): SourceCache {
  return new MemorySourceCache(options);
}

export const sourceCache: SourceCache = new MemorySourceCache();

/* 页面侧使用的具名快捷入口，避免每个组件都写 `sourceCache.xxx`。 */
export const publishSearchResults: SourceCache["publish"] = (...args) =>
  sourceCache.publish(...args);
export const getSourceView: SourceCache["view"] = (...args) => sourceCache.view(...args);
export const ensureSources: SourceCache["ensure"] = (...args) => sourceCache.ensure(...args);
export const refreshSources: SourceCache["refresh"] = (...args) => sourceCache.refresh(...args);
export const prefetchSources: SourceCache["prefetch"] = (...args) => sourceCache.prefetch(...args);
export const warmSourceDetails: SourceCache["warmDetails"] = (...args) =>
  sourceCache.warmDetails(...args);
export const subscribeSourceCache: SourceCache["subscribe"] = (...args) =>
  sourceCache.subscribe(...args);
export const setSourceCacheScope: SourceCache["setScope"] = (scope) =>
  sourceCache.setScope(scope);
export const clearSourceCache: SourceCache["clear"] = () => sourceCache.clear();
