/**
 * 豆瓣元数据补全：按片名（可选年份）问后端要一份豆瓣信息。
 *
 * 取数模型（2.0.0 重构）：后端主动推。前端只发一个 `douban_request`，后端把结果
 * 用 `douban-meta` 事件分两段推回——搜索到货推 `cover`（封面先出），详情到货推
 * `full`（评分/简介补全）。与全站搜索的 `search-chunk` 是同一套推送模型，并发/限流
 * 收口到后端一处，前端不再自己排队。
 *
 * 三条硬约束：
 * 1. **静默回退**。豆瓣是锦上添花：没匹配（`none`）或传输失败（`error`）就跟没有
 *    这个功能一样——不弹 toast、不占位、不报错，详情页/头图照常用源站信息渲染。
 * 2. **中心 store**。所有结果按 key 存进 `store`，组件经 `useSyncExternalStore`
 *    读快照；`fetchDoubanMeta` 是同一 store 上的 Promise 视图（解析到终态）。
 *    同 key 并发只发一次请求（`requested` 集 + 后端 active 去重）。
 * 3. **key 含代理模式**（title+year+proxyType+custom）。换代理后 key 变，下一次
 *    请求自然走新代理（「即时生效」）；组件从设置页返回时重新挂载即读到新值。
 */
import { api } from "./invoke";
import type { DoubanProxyType } from "./doubanSettings";
import { readDoubanPrefs } from "./doubanSettings";
import { log } from "./logger";

/** Rust `douban_meta` / `douban-meta` 事件里的资料体（字段顺序与契约一致）。 */
export interface DoubanMeta {
  id: string;
  title: string;
  year: string;
  rating: number;
  ratingCount: number;
  intro: string;
  directors: string[];
  actors: string[];
  genres: string[];
  pic: string;
  url: string;
}

/** 富化阶段：cover=仅封面，full=含评分/简介，none=确认无匹配，error=传输失败可重试。 */
export type DoubanPhase = "cover" | "full" | "none" | "error";

/** 后端 `douban-meta` 事件 payload（`key` 为前端 store 槽位标识，原样回带）。 */
export interface DoubanMetaEvent {
  key: string;
  phase: DoubanPhase;
  meta: unknown;
}

export interface FetchDoubanOptions {
  priority?: boolean;
  /**
   * 采集库自带的豆瓣 subject id（`vod_douban_id`）。有值时后端按 id 直取详情，
   * 跳过搜索那一跳；槽位键同时含 id，与标题路径的正/负缓存互不污染。
   */
  subjectId?: string;
}

interface Entry {
  meta: DoubanMeta | null;
  phase: DoubanPhase | null;
}

const store = new Map<string, Entry>();
/**
 * store 上限：键含代理模式与 subject id，换一次代理就换一整套键空间。没有上限时
 * 旧键永远读不到、也永不释放（简介/演员表每条约 1–4 KB，翻完 3000 部即常驻十几 MB）。
 * 淘汰用「删除后重插」维持插入序，取最旧一条。
 */
const MAX_STORE_ENTRIES = 600;

function setStore(key: string, entry: Entry): void {
  store.delete(key);
  store.set(key, entry);
  while (store.size > MAX_STORE_ENTRIES) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}
const listeners = new Map<string, Set<() => void>>();
const waiters = new Map<string, Set<(meta: DoubanMeta | null) => void>>();
// 已发出、尚未收到终态的 key：避免同一部片重复发请求。
const requested = new Set<string>();
let unlisten: Promise<() => void> | null = null;

/** 当前生效的代理参数（自定义却没填前缀 → 按直连，与后端兜底一致）。 */
function proxyArgs(): { proxyType: DoubanProxyType; custom: string } {
  const prefs = readDoubanPrefs();
  const prefix = prefs.proxyPrefix.trim();
  const proxyType: DoubanProxyType =
    prefs.proxyType === "custom" && !prefix ? "direct" : prefs.proxyType;
  return { proxyType, custom: proxyType === "custom" ? prefix : "" };
}

/** store 槽位键：含代理模式，换代理即落到新键、下次请求走新代理。 */
/**
 * store 槽位键：含代理模式，换代理即落到新键、下次请求走新代理。
 *
 * 含 subject id：按 id 直取与按标题匹配是两条不同证据链，同键会共享正/负缓存 ——
 * 标题路径的「无匹配」不该压掉 id 直取，乱填的 id 也不该废掉该剧的标题路径。
 */
export function doubanKey(title: string, year?: string, subjectId?: string): string {
  const { proxyType, custom } = proxyArgs();
  return `${title}\u0000${(year ?? "").trim()}\u0000${proxyType}\u0000${custom}\u0000${(subjectId ?? "").trim()}`;
}

function dispatch(key: string): void {
  const set = listeners.get(key);
  if (set) {
    for (const cb of set) cb();
  }
}

function settleWaiters(key: string, meta: DoubanMeta | null): void {
  const set = waiters.get(key);
  if (set) {
    waiters.delete(key);
    for (const resolve of set) resolve(meta);
  }
}

function handleEvent(evt: DoubanMetaEvent): void {
  const key = evt.key;
  const meta = evt.phase === "none" || evt.phase === "error" ? null : normalizeDoubanMeta(evt.meta);
  const prev = store.get(key);
  if (evt.phase === "error") {
    // 传输失败：保留已有封面（若有），phase 维持非终态，允许下次重新请求。
    requested.delete(key);
    setStore(key, { meta: prev?.meta ?? null, phase: prev?.phase ?? null });
    dispatch(key);
    settleWaiters(key, prev?.meta ?? null);
    return;
  }
  const terminal = evt.phase === "full" || evt.phase === "none";
  setStore(key, { meta, phase: evt.phase });
  if (terminal) requested.delete(key);
  dispatch(key);
  if (terminal) settleWaiters(key, meta);
}

/** 首次用到时订阅一次后端事件；进程内常驻。 */
function ensureListening(): void {
  if (unlisten) return;
  unlisten = api.onDoubanMeta((evt) => {
    try {
      handleEvent(evt);
    } catch (err) {
      log.warn("douban-meta event handling failed", { message: String(err) });
    }
  });
  void unlisten.catch((err) => {
    // 订阅失败（极端环境）：允许后续再试一次。
    log.warn("douban-meta listen failed", { message: String(err) });
    unlisten = null;
  });
}

/**
 * 触发一次富化（幂等）：已有终态或已在途则不重复发。`priority` 给「用户正在看」
 * 的入口（头图/详情/播放页），后端把它排到卡片预取前面。
 */
export function requestDouban(
  title: string,
  year?: string,
  priority = false,
  subjectId?: string,
): void {
  const word = (title ?? "").trim();
  if (!word) return;
  if (!readDoubanPrefs().enabled) return;
  ensureListening();
  const key = doubanKey(word, year, subjectId);
  const entry = store.get(key);
  if (entry?.phase === "full" || entry?.phase === "none") return;
  if (requested.has(key)) return;
  requested.add(key);
  const { proxyType, custom } = proxyArgs();
  api
    .doubanRequest(
      word,
      (year ?? "").trim() || undefined,
      proxyType,
      custom || undefined,
      priority,
      key,
      subjectId || undefined,
    )
    .catch((err) => {
      requested.delete(key);
      log.info("douban request failed", { title: word, message: String(err) });
    });
}

/** 读快照（供 useSyncExternalStore）：未到货返回 null。返回引用稳定。 */
export function getDoubanSnapshot(key: string): DoubanMeta | null {
  return store.get(key)?.meta ?? null;
}

/**
 * 只认终态 `full` 的快照，给「封面与简介同屏」的位置用（头图）。
 *
 * `cover` 相的 coarse 够出图，但没有评分/类型/简介；逐字段就地应用会让 meta 行和
 * 简介在 cover→full 之间各跳一次，同屏文字先跳再补图很难看。这类位置宁可让海报
 * 多等一跳，换一次到位。卡片只用图，走 `getDoubanSnapshot` 早出封面。
 */
export function getDoubanFullSnapshot(key: string): DoubanMeta | null {
  const entry = store.get(key);
  return entry?.phase === "full" ? entry.meta : null;
}

/** 订阅某个 key 的更新。 */
export function subscribeDouban(key: string, cb: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  return () => {
    const current = listeners.get(key);
    if (current) {
      current.delete(cb);
      if (current.size === 0) listeners.delete(key);
    }
  };
}

/**
 * Promise 视图：解析到终态（full 的资料 / none 的 null / error 的当前值）。
 * 详情页、播放页、卡片预取用它；头图/卡片渲染走 `useDoubanMeta`（能拿到中间 cover）。
 */
export function fetchDoubanMeta(
  title: string,
  year?: string,
  options: FetchDoubanOptions = {},
): Promise<DoubanMeta | null> {
  const word = (title ?? "").trim();
  if (!word) return Promise.resolve(null);
  if (!readDoubanPrefs().enabled) return Promise.resolve(null);
    ensureListening();
    const key = doubanKey(word, year, options.subjectId);
    const entry = store.get(key);
    if (entry?.phase === "full" || entry?.phase === "none") {
      return Promise.resolve(entry.meta);
    }
    return new Promise<DoubanMeta | null>((resolve) => {
      let set = waiters.get(key);
      if (!set) {
        set = new Set();
        waiters.set(key, set);
      }
      set.add(resolve);
      requestDouban(word, year, options.priority === true, options.subjectId);
    });
}

/** 清空 store（换配置 / 测试复位用）。在途请求的响应会重新填回。 */
export function clearDoubanMetaCache(): void {
  store.clear();
  requested.clear();
  waiters.clear();
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * 后端字段类型不完全受本文件控制：这里统一收敛一次，组件拿到的永远是「干净」
 * 的结构，渲染层不用再判 `undefined`。一条既没有片名、也没有评分/简介/海报的记录
 * 对界面毫无意义，当作没拿到（返回 null）。
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
