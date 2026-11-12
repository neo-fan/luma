/**
 * 前端唯一 IPC 入口（规格书 7.1 / 0 节第 5 条）。
 *
 * 所有系统能力必须经本模块走 Rust command；禁止在别处直接 import
 * `@tauri-apps/api`，禁止 import 任何 Node 内置模块。
 */
import { invoke } from "@tauri-apps/api/core";
import { CACHE_TTL, pageCache } from "./pageCache";
import { mergeHomeFallback } from "./home";
import { pickRecoveryCandidate } from "./detailRecovery";
import { log } from "./logger";
import type {
  AppError,
  ConfigMeta,
  ConfigSnapshot,
  ConfigSource,
  Diagnostics,
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
  SiteHealthResult,
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
    const appError = toAppError(err);
    // 只记失败：成功的 IPC 太吵，且错误才是试运行反馈需要的上下文。
    // 不记录 args —— 里面可能有播放直链 / 配置地址。
    log.error("ipc failed", { cmd, code: appError.code, message: appError.message });
    throw appError;
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

/**
 * 空详情的按名回查：TVBox 的 `vod_id` 只在本源、本次抓取内有效。源站换库、
 * 配置刷新、卡片没带 id 时，用旧 id 调 `detailContent` 通常不报错，只回空
 * list。这里按片名重新问本站一次，拿到新 id 再拉详情；失败也只记日志，
 * 不把一次空结果升级成异常（详情页还能走换源）。
 *
 * 只在调用方显式给了片名时启用：播放页选集、自动换源、候选预热仍是单次
 * 请求，不受影响。
 */
async function recoverDetail(
  siteKey: string,
  vodId: string,
  title: string,
  cacheKey: string,
): Promise<VodInfo[]> {
  try {
    const page = await api.search(siteKey, title, 1);
    const candidate = pickRecoveryCandidate(page?.list, title, vodId);
    if (!candidate) {
      log.warn("detail recovery: no title match", { siteKey, vodId, title });
      return [];
    }
    const recoveredId = String(candidate.vod_id);
    const list = await spider<VodInfo[]>(siteKey, "detailContent", [recoveredId]);
    if (!list || list.length === 0) {
      log.warn("detail recovery: retry still empty", { siteKey, vodId, recoveredId, title });
      return [];
    }
    // 写回原 key：详情页刷新 / 回退直接命中，不必再回查一轮。
    pageCache.put(cacheKey, list, CACHE_TTL.detail);
    log.info("detail recovered by title", { siteKey, vodId, recoveredId, title });
    return list;
  } catch (err) {
    log.warn("detail recovery failed", {
      siteKey,
      vodId,
      title,
      message: errorMessage(err),
    });
    return [];
  }
}

/** 7.1 的 command 面：一一对应，不额外暴露能力。 */
export const api = {
  /**
   * 导入配置。`source.name` 是用户在导入框里填的名字（可空）：后端优先
   * 用显式名字，其次沿用同名配置已有的名字，最后才取域名/配置内名称。
   */
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

  /** 手动切换配置；返回新 active 的运行快照，前端拿来替换站点缓存。 */
  configActivate(id: string): Promise<ConfigSnapshot> {
    return call("config_activate", { id });
  },

  /** 站点体检：并发探测各站可达性与耗时（诊断动作，不写缓存）。 */
  siteHealth(timeoutMs?: number): Promise<SiteHealthResult> {
    return call("site_health", { req: { timeoutMs } });
  },

  /** 手动启用/禁用单站，返回改后的运行快照供前端换缓存。 */
  siteSetEnabled(siteKey: string, enabled: boolean): Promise<ConfigSnapshot> {
    return call("site_set_enabled", { req: { siteKey, enabled } });
  },

  /** 重命名已保存的配置（不切换 active）。 */
  configRename(id: string, name: string): Promise<ConfigMeta> {
    return call("config_rename", { id, name });
  },

  configRemove(id: string): Promise<void> {
    return call("config_remove", { id });
  },

  spiderInvoke(req: SpiderRequest): Promise<unknown> {
    return call("spider_invoke", { request: req });
  },

  /**
   * 首页：先取 `homeContent`（分类 + 有些源自带 list）。若 list 为空，再问
   * 一次标准方法 `homeVideoContent` 补推荐流——豆瓣等严格按协议分家的源
   * 只在这里放卡片。兜底失败一律吞掉、保留 base，绝不让首页因缺该方法而报错
   * （老 py 脚本、部分 CMS 源可能没有独立推荐流）。两次调用包在同一缓存
   * 条目里，force/scope 语义不变。
   */
  home(siteKey: string, force = false): Promise<HomeResult> {
    return pageCache.load(
      cacheKeys.home(siteKey),
      CACHE_TTL.home,
      async () => {
        const base = await spider<HomeResult>(siteKey, "homeContent", []);
        if ((base?.list ?? []).length > 0) {
          return base;
        }
        try {
          const extra = await spider<HomeResult>(siteKey, "homeVideoContent", []);
          return mergeHomeFallback(base, extra);
        } catch (err) {
          log.warn("homeVideoContent unavailable", {
            siteKey,
            message: errorMessage(err),
          });
          return base;
        }
      },
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

  /**
   * 详情页、播放页选集面板、手动换源、自动换源都读同一份详情。
   * `fallbackTitle` 只有详情页传：空结果时按片名自愈回查一次。
   */
  async detail(
    siteKey: string,
    vodId: string,
    force = false,
    fallbackTitle = "",
  ): Promise<VodInfo[]> {
    const key = cacheKeys.detail(siteKey, vodId);
    const title = fallbackTitle.trim();
    // 空 id 不值得发一次注定失败的请求：CMS 会当成 `ac=detail&ids=` 并返回
    // 默认列表或空，python 源则常被脚本拼成无效 URL。
    const list = vodId.trim()
      ? await pageCache.load(
          key,
          CACHE_TTL.detail,
          () => spider<VodInfo[]>(siteKey, "detailContent", [vodId]),
          force,
        )
      : [];
    if (list && list.length > 0) {
      return list;
    }
    // 空详情多半是源站偶发失败，或该源压根不提供详情（发现/推荐类源直接
    // `return {"list": []}`）。别缓存十分钟；同时留一条带站点与 id 的记录，
    // 否则 UI 上只剩「未获取到影片详情」，无从复盘。
    pageCache.invalidate(key);
    log.warn("detail empty", {
      siteKey,
      vodId,
      title,
      reason: list ? "empty list" : "no result",
    });
    if (!title) {
      return list ?? [];
    }
    const recovered = await recoverDetail(siteKey, vodId, title, key);
    return recovered.length > 0 ? recovered : (list ?? []);
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

  /** 只补收藏条目的元数据（老记录缺封面时用），不改收藏时间。 */
  favoritesPatchMeta(vod: VodRef): Promise<boolean> {
    return call("favorites_patch_meta", { vod });
  },

  historyList(): Promise<HistoryItem[]> {
    return call("history_list");
  },

  historyUpsert(item: HistoryItem): Promise<void> {
    return call("history_upsert", { item });
  },

  /** 只补历史条目的元数据（老记录缺封面时用），不改 `updatedAt`。 */
  historyPatchMeta(vod: VodRef): Promise<boolean> {
    return call("history_patch_meta", { vod });
  },

  historyClear(): Promise<void> {
    return call("history_clear");
  },

  /** 删除单条历史（历史页每行的「删除」）。 */
  historyRemove(siteKey: string, vodId: string): Promise<void> {
    return call("history_remove", { siteKey, vodId });
  },

  /** 试运行诊断：版本 / 数据目录 / 日志目录 / 当前配置规模。 */
  diagnostics(): Promise<Diagnostics> {
    return call("diagnostics");
  },

  /** 在资源管理器里打开日志目录，方便把日志发给开发者。 */
  openLogDir(): Promise<void> {
    return call("open_log_dir");
  },

  /** 生成一份「诊断 + 日志尾部」的反馈文件，返回其绝对路径。 */
  exportReport(): Promise<string> {
    return call("export_report");
  },

  /** 写系统剪贴板（避开 WebView2 的 clipboard 权限弹窗）。 */
  copyText(text: string): Promise<void> {
    return call("copy_text", { text });
  },
};

export type Api = typeof api;
