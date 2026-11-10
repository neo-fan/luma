/**
 * 前端唯一 IPC 入口（规格书 7.1 / 0 节第 5 条）。
 *
 * 所有系统能力必须经本模块走 Rust command；禁止在别处直接 import
 * `@tauri-apps/api`，禁止 import 任何 Node 内置模块。
 */
import { invoke } from "@tauri-apps/api/core";
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

/** 7.1 的 command 面：一一对应，不额外暴露能力。 */
export const api = {
  configImport(source: ConfigSource): Promise<ConfigSnapshot> {
    return call("config_import", { source });
  },

  configList(): Promise<ConfigMeta[]> {
    return call("config_list");
  },

  configRemove(id: string): Promise<void> {
    return call("config_remove", { id });
  },

  spiderInvoke(req: SpiderRequest): Promise<unknown> {
    return call("spider_invoke", { request: req });
  },

  home(siteKey: string): Promise<HomeResult> {
    return spider<HomeResult>(siteKey, "homeContent", []);
  },

  category(siteKey: string, tid: string, page: number): Promise<ResultPage> {
    return spider<ResultPage>(siteKey, "categoryContent", [tid, page]);
  },

  search(siteKey: string, keyword: string, page: number): Promise<ResultPage> {
    // TVBox 统一签名是 (key, quick, pg)；CMS 兼容两参数，py/js 需要三参数。
    return spider<ResultPage>(siteKey, "searchContent", [keyword, false, page]);
  },

  detail(siteKey: string, vodId: string): Promise<VodInfo[]> {
    return spider<VodInfo[]>(siteKey, "detailContent", [vodId]);
  },

  httpFetch(req: FetchRequest): Promise<FetchResponse> {
    return call("http_fetch", { req });
  },

  liveParse(url: string, ua?: string): Promise<LiveListResult> {
    return call("live_parse", { url, ua });
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
