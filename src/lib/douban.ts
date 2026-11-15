/**
 * 豆瓣元数据补全：按片名（可选年份）问 Rust 要一份豆瓣信息。
 *
 * 三条硬约束，决定了这里的写法：
 * 1. **静默回退默认**。豆瓣是「锦上添花」：没匹配上（同名片 / 新片 / 接口
 *    限流 / 代理不可用）就跟没有这个功能一样——不弹 toast、不占位、不报错，
 *    详情页照常用源站给的信息渲染。所以所有失败都收敛成 `null`。
 * 2. **一次详情只打一次**。同一 title+year 进进出出（播放页返回、换线路、
 *    重复点同一张卡）不该反复打豆瓣；这里做进程内 Map 缓存（含「查无此片」
 *    这种负结果），FIFO 上限 200 条。缓存键带上代理模式，切换代理后下一次
 *    请求会重新走一遍，保证设置「即时生效」。
 * 3. **同片并发只发一次**。详情页重新挂载时可能同时发出两次请求，用
 *    `inflight` 表把并发的同键请求合并成一个 Promise。
 */
import { api, errorMessage } from "./invoke";
import type { DoubanProxyType } from "./doubanSettings";
import { readDoubanPrefs } from "./doubanSettings";
import { log } from "./logger";

/** Rust `douban_meta` 的返回体（字段顺序与契约一致）。 */
export interface DoubanMeta {
  id: string;
  title: string;
  /** 上映/首播年份，取不到时为空串。 */
  year: string;
  /** 0~10 的评分；0 表示没有评分（不是「零分」）。 */
  rating: number;
  /** 评价人数。 */
  ratingCount: number;
  intro: string;
  directors: string[];
  actors: string[];
  genres: string[];
  pic: string;
  /** 豆瓣条目地址，仅作来源说明，不在客户端打开。 */
  url: string;
}

/** 进程内缓存的条数上限：一次浏览几十部片，200 条足够且不会涨。 */
const CACHE_LIMIT = 200;
/** 命中了的资料缓存 10 分钟（和 Rust 侧一致）；没命中的只留 1 分钟，别把「刚被豆瓣限流」记成永久没有。 */
const HIT_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 60_000;
/** 搜索有频率限制：同时最多两个在途，其余排队，避免一屏海报把豆瓣打到限流。 */
const MAX_PARALLEL = 2;

interface CachedMeta {
  meta: DoubanMeta | null;
  at: number;
}

const cache = new Map<string, CachedMeta>();
const inflight = new Map<string, Promise<DoubanMeta | null>>();
let running = 0;
const waiters: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (running < MAX_PARALLEL) {
    running += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    waiters.push(resolve);
  });
}

function releaseSlot(): void {
  running -= 1;
  const next = waiters.shift();
  if (next) {
    next();
  }
}

function readCache(key: string): DoubanMeta | null | undefined {
  const hit = cache.get(key);
  if (!hit) {
    return undefined;
  }
  const ttl = hit.meta ? HIT_TTL_MS : MISS_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.meta;
}

/** 测试 / 「换配置后想重新拉」时可清空缓存。 */
export function clearDoubanMetaCache(): void {
  cache.clear();
  inflight.clear();
}

function remember(key: string, meta: DoubanMeta | null): void {
  if (cache.size >= CACHE_LIMIT) {
    // Map 保持插入顺序：删最早那条就是 FIFO。
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, { meta, at: Date.now() });
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 后端在并行开发中，字段类型不完全受本文件控制：这里统一收敛一次，
 * 组件拿到的永远是「干净」的结构，渲染层不用再判 `undefined`。
 */
export function normalizeDoubanMeta(raw: unknown): DoubanMeta | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const id = value.id === undefined || value.id === null ? "" : String(value.id);
  const intro = typeof value.intro === "string" ? value.intro.trim() : "";
  const pic = typeof value.pic === "string" ? value.pic.trim() : "";
  // 一条既没有片名、也没有评分/简介/海报的记录对界面毫无意义，当作没拿到。
  if (!title && !intro && !pic && num(value.rating) === 0) {
    return null;
  }
  return {
    id,
    title,
    year:
      typeof value.year === "string"
        ? value.year.trim()
        : value.year === undefined || value.year === null
          ? ""
          : String(value.year),
    rating: Math.min(10, Math.max(0, num(value.rating))),
    ratingCount: Math.max(0, Math.round(num(value.ratingCount))),
    intro,
    directors: strings(value.directors),
    actors: strings(value.actors),
    genres: strings(value.genres),
    pic,
    url: typeof value.url === "string" ? value.url : "",
  };
}

/** 10000 以上换成「x.x 万人评价」，一行放得下。 */
export function formatVotes(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return "";
  }
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1).replace(/\.0$/, "")} 万人评价`;
  }
  return `${Math.round(count)} 人评价`;
}

/**
 * 按片名取豆瓣信息；拿不到就是 `null`（**永不 reject**）。
 *
 * @param title 片名（详情页优先用 `vod_name`，回退到列表带来的 title）
 * @param year  年份，可空；同名片（如翻拍）靠它区分
 */
export async function fetchDoubanMeta(
  title: string,
  year?: string,
): Promise<DoubanMeta | null> {
  const word = (title ?? "").trim();
  if (!word) {
    return null;
  }
  const prefs = readDoubanPrefs();
  if (!prefs.enabled) {
    // 设置里关掉 = 完全不发请求，也不读缓存。
    return null;
  }
  const proxyPrefix = prefs.proxyPrefix.trim();
  // 自定义模式却没填前缀：一定失败，按直连发，至少别把用户的详情页拖住。
  const proxyType: DoubanProxyType =
    prefs.proxyType === "custom" && !proxyPrefix ? "direct" : prefs.proxyType;
  const custom = proxyType === "custom" ? proxyPrefix : "";
  const key = `${word}\u0000${(year ?? "").trim()}\u0000${proxyType}\u0000${custom}`;

  const cached = readCache(key);
  if (cached !== undefined) {
    return cached;
  }
  const inFlight = inflight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async (): Promise<DoubanMeta | null> => {
    await acquireSlot();
    try {
      const raw = await api.doubanMeta(
        word,
        (year ?? "").trim() || undefined,
        proxyType,
        custom || undefined,
      );
      const meta = normalizeDoubanMeta(raw);
      remember(key, meta);
      return meta;
    } catch (err) {
      // 网络 / 代理 / 后端未实现都会走到这里：对界面而言等价于「没有豆瓣信息」。
      // 只留一条 info 便于复盘，不进控制台报错（试运行下 error 会打到 devtools）。
      log.info("douban meta unavailable", {
        title: word,
        proxyType,
        message: errorMessage(err),
      });
      remember(key, null);
      return null;
    } finally {
      releaseSlot();
    }
  })();

  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}
