/**
 * 前端唯一 IPC 入口（规格书 7.1 / 0 节第 5 条）。
 *
 * 所有系统能力必须经本模块走 Rust command；禁止在别处直接 import
 * `@tauri-apps/api`，禁止 import 任何 Node 内置模块。
 */
import { invoke } from "@tauri-apps/api/core";
import { CACHE_TTL, pageCache } from "./pageCache";
import type {
  AppError,
  ConfigMeta,
  ConfigSnapshot,
  ConfigSource,
  FavoriteItem,
  FetchRequest,
  FetchResponse,
  HistoryItem,
  HomeResult,
  ParseRequest,
  ParseResolved,
  PlayRequest,
  PlayResolved,
  LiveListResult,
  ProxyStatus,
  ResultPage,
  SpiderMethod,
  SpiderRequest,
  VodInfo,
  VodRef,
} from "../types/tvbox";

/** 把 invoke 抛出的任意错误收敛成 AppError。 */
export function toAppError(err: unknown): AppError {
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    return err as AppError;
  }
  if (typeof err === "string") {
    return { code: "INTERNAL", message: err };
  }
  return { code: "INTERNAL", message: "unknown IPC error", cause: String(err) };
}

/** 页面只需展示 message；集中在此，避免各处重复 `toAppError(err).message`。 */
export function errorMessage(err: unknown): string {
  return toAppError(err).message;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw toAppError(err);
  }
}

function spider<T>(siteKey: string, method: SpiderMethod, args: unknown[]): Promise<T> {
  const req: SpiderRequest = { siteKey, method, args };
  return call<T>("spider_invoke", { request: req });
}

/**
 * 读结果的缓存键：页面用同一组函数做首屏直出 / 失效，避免手写字符串漂移。
 * 只覆盖「短时间内不会变、且重复拉取代价高」的 spider 读操作；收藏、历史、
 * 解析地址与播放解析不带时效保证，一律不走缓存。
 */
export const cacheKeys = {
  home: (siteKey: string) => `home:${siteKey}`,
  category: (siteKey: string, tid: string, page: number) =>
    `category:${siteKey}:${tid}:${page}`,
  search: (siteKey: string, keyword: string, page: number) =>
    `search:${siteKey}:${keyword}:${page}`,
  detail: (siteKey: string, vodId: string) => `detail:${siteKey}:${vodId}`,
  live: (url: string, ua?: string) => `live:${url}:${ua ?? ""}`,
};

/** 7.1 的 command 面：一一对应，不额外暴露能力。 */
export const api = {
  configImport(source: ConfigSource): Promise<ConfigSnapshot> {
    return call("config_import", { source });
  },

  configList(): Promise<ConfigMeta[]> {
    return call("config_list");
  },

  /** 后端当前启用的配置；启动时用它对齐前端的站点缓存。 */
  configActive(): Promise<ConfigSnapshot | null> {
    return call("config_active");
  },

  configRemove(id: string): Promise<void> {
    return call("config_remove", { id });
  },

  spiderInvoke(req: SpiderRequest): Promise<unknown> {
    return call("spider_invoke", { request: req });
  },

  /** force=true 用于页面上的「刷新」按钮；其余调用自动复用缓存。 */
  home(siteKey: string, force = false): Promise<HomeResult> {
    return pageCache.load(
      cacheKeys.home(siteKey),
      CACHE_TTL.home,
      () => spider<HomeResult>(siteKey, "homeContent", []),
      force,
    );
  },

  category(siteKey: string, tid: string, page: number, force = false): Promise<ResultPage> {
    return pageCache.load(
      cacheKeys.category(siteKey, tid, page),
      CACHE_TTL.category,
      () => spider<ResultPage>(siteKey, "categoryContent", [tid, page]),
      force,
    );
  },

  search(siteKey: string, keyword: string, page: number, force = false): Promise<ResultPage> {
    // TVBox 统一签名是 (key, quick, pg)；CMS 兼容两参数，py/js 需要三参数。
    return pageCache.load(
      cacheKeys.search(siteKey, keyword, page),
      CACHE_TTL.search,
      () => spider<ResultPage>(siteKey, "searchContent", [keyword, false, page]),
      force,
    );
  },

  /** 详情页、播放页选集面板、手动换源、自动换源都读同一份详情。 */
  async detail(siteKey: string, vodId: string, force = false): Promise<VodInfo[]> {
    const key = cacheKeys.detail(siteKey, vodId);
    const list = await pageCache.load(
      key,
      CACHE_TTL.detail,
      () => spider<VodInfo[]>(siteKey, "detailContent", [vodId]),
      force,
    );
    // 空详情多半是源站偶发失败，别把它缓存十分钟；下次进来 / 点刷新可重试。
    if (!list || list.length === 0) {
      pageCache.invalidate(key);
    }
    return list;
  },

  httpFetch(req: FetchRequest): Promise<FetchResponse> {
    return call("http_fetch", { req });
  },

  /** 直播 m3u 动辄数千频道，返回直播页时不要重新下载解析一遍。 */
  liveParse(url: string, ua?: string, force = false): Promise<LiveListResult> {
    return pageCache.load(
      cacheKeys.live(url, ua),
      CACHE_TTL.live,
      () => call("live_parse", { url, ua }),
      force,
    );
  },

  proxyStatus(): Promise<ProxyStatus> {
    return call("proxy_status");
  },

  resolvePlay(req: PlayRequest): Promise<PlayResolved> {
    return call("resolve_play", { request: req });
  },

  /** `parses[]` 通用解析池：`playerContent` 返回 parse=1 / jx=1 时调用。 */
  parseResolve(req: ParseRequest): Promise<ParseResolved> {
    return call("parse_resolve", { request: req });
  },

  openExternal(url: string): Promise<void> {
    return call("open_external", { url });
  },

  /** T-30：浏览器无法解码时交给随包 mpv（带防盗链头）。 */
  mpvPlay(url: string, title?: string, headers?: [string, string][]): Promise<{ pid: number; pipe: string }> {
    return call("mpv_play", { url, title, headers });
  },

  favoritesList(): Promise<FavoriteItem[]> {
    return call("favorites_list");
  },

  favoritesToggle(vod: VodRef): Promise<boolean> {
    return call("favorites_toggle", { vod });
  },

  historyList(): Promise<HistoryItem[]> {
    return call("history_list");
  },

  historyUpsert(item: HistoryItem): Promise<void> {
    return call("history_upsert", { item });
  },

  historyClear(): Promise<void> {
    return call("history_clear");
  },
};

export type Api = typeof api;
