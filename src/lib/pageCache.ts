/**
 * 页面级内存数据缓存。
 *
 * 目标：详情页 / 播放页 / 换源弹层反复要同一份 detailContent，视图切换时
 * 组件会被卸载重建，若每次都发 IPC 就会重新拉一遍几十上百集的播放列表。
 * 这里把 spider 结果按「配置 scope + 业务 key」缓存起来，并做三件事：
 *   1. TTL + LRU：只在本次进程内有效，条目上限防止浏览很多影片后无限增长；
 *   2. in-flight 去重：React StrictMode 会双挂载 effect，详情页与播放页也可能
 *      同时请求同一份详情，共享 Promise 把 N 次 IPC 收敛成 1 次；
 *   3. 配置 scope：切到另一份配置后旧站点的详情 / 分类必须整体失效。
 *
 * 缓存只放「可序列化的读结果」；播放进度、收藏等易变数据不进这里。
 */
export interface CacheStats {
  entries: number;
  pending: number;
  /** 命中未过期缓存的次数（累计）。 */
  hits: number;
  /** 未命中 / 强制刷新的次数（累计）。 */
  misses: number;
  /** 实际调用 loader 的次数（累计）。 */
  loads: number;
}

export interface PageCache {
  /** 同步读取未过期的值；只用于首屏直出，过期返回 undefined。 */
  peek<T>(key: string): T | undefined;
  /** 条目已存活的毫秒数，不存在返回 undefined。 */
  age(key: string): number | undefined;
  /** 命中即返回缓存，否则调用 loader（并发共享同一个 Promise）。 */
  load<T>(key: string, ttlMs: number, loader: () => Promise<T>, force?: boolean): Promise<T>;
  /** 直接写入一个已取得的结果（例如按片名回查恢复的详情）。 */
  put(key: string, value: unknown, ttlMs: number): void;
  /** 按业务 key 前缀失效，返回删除的条目数。 */
  invalidate(prefix: string): number;
  clear(): void;
  /** scope 变化则整体清空；相同 scope 不动。 */
  setScope(scope: string): void;
  stats(): CacheStats;
}

/** 缓存时长（毫秒）。影片详情变动最少、代价最高，给最长 TTL。 */
export const CACHE_TTL = {
  detail: 10 * 60_000,
  home: 5 * 60_000,
  category: 5 * 60_000,
  search: 2 * 60_000,
  live: 5 * 60_000,
} as const;

interface Entry {
  value: unknown;
  storedAt: number;
  expiresAt: number;
}

/** scope 与业务 key 的分隔符，避免 `a:b` 与 `a` 前缀互相误伤。 */
const SEP = "\u0000";
const DEFAULT_MAX_ENTRIES = 60;

class MemoryPageCache implements PageCache {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly clock: () => number;
  private readonly maxEntries: number;
  private scope = "default";
  private hits = 0;
  private misses = 0;
  private loads = 0;

  constructor(clock: () => number = Date.now, maxEntries = DEFAULT_MAX_ENTRIES) {
    this.clock = clock;
    this.maxEntries = Math.max(1, maxEntries);
  }

  private scoped(key: string): string {
    return `${this.scope}${SEP}${key}`;
  }

  /** 读取新鲜条目并把它移到 LRU 末尾；过期条目直接淘汰。 */
  private fresh(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    this.touch(key, entry);
    return entry;
  }

  private touch(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  peek<T>(key: string): T | undefined {
    const entry = this.fresh(this.scoped(key));
    return entry ? (entry.value as T) : undefined;
  }

  age(key: string): number | undefined {
    const entry = this.entries.get(this.scoped(key));
    return entry ? this.clock() - entry.storedAt : undefined;
  }

  load<T>(key: string, ttlMs: number, loader: () => Promise<T>, force = false): Promise<T> {
    const scoped = this.scoped(key);
    if (!force) {
      const hit = this.fresh(scoped);
      if (hit) {
        this.hits += 1;
        return Promise.resolve(hit.value as T);
      }
      this.misses += 1;
    } else {
      this.misses += 1;
    }

    // 同一个 key 的并发请求（StrictMode 双挂载、详情+播放页同时读）共用结果。
    const inflight = this.pending.get(scoped);
    if (inflight) {
      return inflight as Promise<T>;
    }

    this.loads += 1;
    const task = (async () => {
      try {
        const value = await loader();
        const now = this.clock();
        this.entries.delete(scoped);
        this.entries.set(scoped, {
          value,
          storedAt: now,
          expiresAt: now + Math.max(1, ttlMs),
        });
        while (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          this.entries.delete(oldest);
        }
        return value;
      } finally {
        // 失败不写缓存，pending 也要清掉，下一次 load 可以重试。
        this.pending.delete(scoped);
      }
    })();
    this.pending.set(scoped, task);
    return task;
  }

  put(key: string, value: unknown, ttlMs: number): void {
    const scoped = this.scoped(key);
    const now = this.clock();
    this.entries.delete(scoped);
    this.entries.set(scoped, {
      value,
      storedAt: now,
      expiresAt: now + Math.max(1, ttlMs),
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  invalidate(prefix: string): number {
    const scopedPrefix = this.scoped(prefix);
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(scopedPrefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(scopedPrefix)) {
        this.pending.delete(key);
      }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.pending.clear();
  }

  setScope(scope: string): void {
    const next = scope || "default";
    if (next === this.scope) {
      return;
    }
    this.scope = next;
    this.clear();
  }

  stats(): CacheStats {
    return {
      entries: this.entries.size,
      pending: this.pending.size,
      hits: this.hits,
      misses: this.misses,
      loads: this.loads,
    };
  }
}

/** 供单测注入假时钟与容量上限；应用代码用下面的单例。 */
export function createPageCache(clock?: () => number, maxEntries?: number): PageCache {
  return new MemoryPageCache(clock, maxEntries);
}

export const pageCache: PageCache = new MemoryPageCache();
