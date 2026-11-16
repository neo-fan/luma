/**
 * 前端唯一 IPC 入口（规格书 7.1 / 0 节第 5 条）。
 *
 * 所有系统能力必须经本模块走 Rust command；禁止在别处直接 import
 * `@tauri-apps/api`，禁止 import 任何 Node 内置模块。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { CACHE_TTL, pageCache } from "./pageCache";
import { rememberCards } from "./cardIndex";
import { mergeHomeFallback, normalizeHomeResult } from "./home";
import { pickRecoveryCandidate } from "./detailRecovery";
import { noDetailSources } from "./noDetailSource";
import { loadCategoryPage } from "./categoryLoad";
import { log } from "./logger";
// type-only：sources.ts 运行时反向依赖本模块，这里只借类型不引运行时代码。
import type { AggregateRow } from "./sources";
import type { DoubanMeta } from "./douban";
import type { DoubanProxyType } from "./doubanSettings";
import type {
  AppError,
  ConfigMeta,
  ConfigSnapshot,
  ConfigSource,
  Diagnostics,
  FavoriteItem,
  FetchRequest,
  FetchResponse,
  GhProbeResult,
  GhProxyState,
  HistoryItem,
  HomeResult,
  ParseRequest,
  ParseResolved,
  PlayRequest,
  PlayResolved,
  LiveListResult,
  EpgResult,
  LiveSource,
  ProxyStatus,
  RefreshOutcome,
  RefreshSettings,
  ResultPage,
  Site,
  SiteHealthResult,
  SpiderMethod,
  SpiderRequest,
  VodInfo,
  VodRef,
} from "../types/luma";

/** 把 invoke 抛出的任意错误收敛成 AppError。 */
export function toAppError(err: unknown): AppError {
  if (typeof err === "object" && err !== null && "code" in err && "message" in err) {
    return err as AppError;
  }
  // 前端自己 `throw new Error("…")` 的地方（播放编排、换源）也走这里。
  // Error 实例没有 `code` 字段，旧逻辑会把它降级成 "unknown IPC error"，
  // 用户看不到真正原因（实测网盘线路那句提示就是这么丢的）。
  if (err instanceof Error) {
    return { code: "INTERNAL", message: err.message };
  }
  if (typeof err === "string") {
    return { code: "INTERNAL", message: err };
  }
  // 兜底：至少把对象上的 message 取出来，别让界面只剩一句 unknown。
  const message = (err as { message?: unknown } | null)?.message;
  return {
    code: "INTERNAL",
    message: typeof message === "string" && message.trim() ? message : "unknown IPC error",
    cause: String(err),
  };
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
 * 运行态窄化守卫层（不引第三方依赖，手写）。
 *
 * 边界（必须看懂再接线）：这里**只收窄不可信来源**——localStorage 旧数据 /
 * 跨版本缓存这类「写入方与读取方版本可能不同」的字节，正是形状漂移最可能的
 * 来源。Rust command 的返回值（同进程、版本匹配）**不在本层收窄**：它的类型
 * 由 `contracts/luma.schema.json` → `src/types/luma.ts` → Rust 序列化三处同步
 * 保证，加守卫反而会改变行为语义（把后端契约回归悄悄吞掉）。
 *
 * 因此接线点只应是 localStorage / pageState 的读回路径；不要给 `call(...)` /
 * `spider(...)` 的返回结果套这里。
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * 收窄站点数组：每项必须是对象且 `key` / `name` 为非空字符串，否则**整项丢弃**。
 * 整体不是数组时返回 `[]`。合法项原样返回（保留对象引用，不改字段）。
 *
 * 丢弃会发一条 `log.warn`（带 dropped 计数）：这是用户数据，不该静默消失。
 */
export function narrowSites(value: unknown): Site[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: Site[] = [];
  let dropped = 0;
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      isNonEmptyString((item as { key?: unknown }).key) &&
      isNonEmptyString((item as { name?: unknown }).name)
    ) {
      kept.push(item as Site);
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    log.warn("ipc narrow dropped sites", { dropped });
  }
  return kept;
}

/**
 * 收窄直播源数组：每项必须是对象且 `name` / `url` 为非空字符串，否则整项丢弃。
 * 整体不是数组时返回 `[]`。
 *
 * 取舍：分组容器型源（只有 `channels`、没有 `url`）会被这里丢弃。这是有意为之
 * 的跨版本信任边界——`luma:sites:v1` 里持久化的 `lives` 字段没有版本握手，
 * 宁可丢弃无法确证的项，也不要让漂移结构（`name`/`url` 缺失）流入
 * `LivePage` / `useLiveCatalog` 的按索引寻址。
 */
export function narrowLives(value: unknown): LiveSource[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const kept: LiveSource[] = [];
  let dropped = 0;
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      isNonEmptyString((item as { name?: unknown }).name) &&
      isNonEmptyString((item as { url?: unknown }).url)
    ) {
      kept.push(item as LiveSource);
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    log.warn("ipc narrow dropped lives", { dropped });
  }
  return kept;
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
    const found = page?.list ?? [];
    // 详情空 + 同站按名也搜不到：这个源大概率只做发现/推荐（如「豆瓣[py]」的
    // detailContent 直接返回空），记下来让详情页换成人话，而不是「加载失败」。
    // 只影响文案，回查与跨源自愈照旧，所以单次即记也不会带来功能风险。
    if (found.length === 0 && noDetailSources.note(siteKey, vodId)) {
      log.info("source marked as no-detail", { siteKey, vodId, title });
    }
    const candidate = pickRecoveryCandidate(found, title, vodId);
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

  /** 订阅自动刷新设置（间隔 + active 的上次检查/变化/错误）。 */
  configRefreshSettings(): Promise<RefreshSettings> {
    return call("config_refresh_settings");
  },

  /** 设置自动刷新间隔（小时，0 = 关闭）。返回新的聚合视图。 */
  configSetRefreshInterval(hours: number): Promise<RefreshSettings> {
    return call("config_set_refresh_interval", { hours });
  },

  /** 手动检查订阅（id 省略 = active）；`changed` 为假时 snapshot 缺省。 */
  configRefresh(id?: string): Promise<RefreshOutcome> {
    return call("config_refresh", { id });
  },

  /** GitHub 加速：当前前缀 + 内置候选。 */
  ghProxyState(): Promise<GhProxyState> {
    return call("gh_proxy_state");
  },

  /**
   * 切换加速代理。会重写全部已存配置里的 GitHub 链接，返回带 active 运行
   * 快照的状态——前端必须用它替换站点缓存（旧缓存里的 ext 还挂着旧前缀）。
   */
  ghProxySet(prefix: string): Promise<GhProxyState> {
    return call("gh_proxy_set", { prefix });
  },

  /** 并发探测全部候选（返回顺序与 choices 一致）。 */
  ghProxyTest(): Promise<GhProbeResult[]> {
    return call("gh_proxy_test");
  },

  /**
   * 后台定时刷新到点后的推送。放在本模块是为了守住「唯一 IPC 入口」：
   * 页面只能通过这里订阅，不得直接 import `@tauri-apps/api/event`。
   */
  onConfigRefreshed(handler: (outcome: RefreshOutcome) => void): Promise<UnlistenFn> {
    return listen<RefreshOutcome>("config-refreshed", (event) => handler(event.payload));
  },

  spiderInvoke(req: SpiderRequest): Promise<unknown> {
    return call("spider_invoke", { request: req });
  },

  /**
   * 流式全站搜索的逐站推送（`SpiderRequest.stream = true` 时后端 emit）。
   * payload 与聚合结果的单行完全同构——事件只是增量预览，最终 IPC
   * 返回值仍是完整聚合（真相源），前端用它做对账。
   */
  onSearchChunk(handler: (row: AggregateRow) => void): Promise<UnlistenFn> {
    return listen<AggregateRow>("search-chunk", (event) => handler(event.payload));
  },

  /**
   * 首页：先取 `homeContent`（分类 + 有些源自带 list）。若 list 为空，再问
   * 一次标准方法 `homeVideoContent` 补推荐流——豆瓣等严格按协议分家的源
   * 只在这里放卡片。兜底失败一律吞掉、保留 base，绝不让首页因缺该方法而报错
   * （老 py 脚本、部分 CMS 源可能没有独立推荐流）。两次调用包在同一缓存
   * 条目里，force/scope 语义不变。
   */
  home(siteKey: string, force = false): Promise<HomeResult> {
    const key = cacheKeys.home(siteKey);
    return pageCache.load(
      key,
      CACHE_TTL.home,
      async () => {
        // JS 源按 TVBox 原始协议给 `class`，py 适配层给 `classes`：在这里统一，
        // 否则 JS 源首页分类空白。
        const base = normalizeHomeResult(await spider<HomeResult>(siteKey, "homeContent", []));
        if (base.list.length > 0) {
          return base;
        }
        let merged: HomeResult;
        try {
          const extra = await spider<HomeResult>(siteKey, "homeVideoContent", []);
          merged = mergeHomeFallback(base, extra);
        } catch (err) {
          log.warn("homeVideoContent unavailable", {
            siteKey,
            message: errorMessage(err),
          });
          merged = base;
        }
        if (merged.list.length === 0) {
          // 首页一个卡片都没有：不写长缓存。源侧偶发失败（或一次响应错位）
          // 若被缓存 5 分钟，用户切回来还是空，只能靠重启。
          log.warn("home recommendation empty", {
            siteKey,
            classes: merged.classes.length,
          });
          pageCache.invalidate(key);
        }
        return merged;
      },
      force,
    ).then((result) => {
      // 纯发现型源（豆瓣[py] 等）没有 detailContent，详情页靠这份索引回填卡片。
      rememberCards(siteKey, result?.list);
      return result;
    });
  },

  category(siteKey: string, tid: string, page: number, force = false): Promise<ResultPage> {
    const key = cacheKeys.category(siteKey, tid, page);
    const load = (withForce: boolean) =>
      pageCache.load<ResultPage>(
        key,
        CACHE_TTL.category,
        () => spider<ResultPage>(siteKey, "categoryContent", [String(tid), page]),
        withForce,
      );
    return loadCategoryPage(
      load,
      () => {
        pageCache.invalidate(key);
      },
      force,
      (reason, attempt) => {
        log.warn("category page retry", { siteKey, tid, page, reason, attempt });
      },
    ).then((result) => {
      rememberCards(siteKey, result?.list);
      return result;
    });
  },

  search(siteKey: string, keyword: string, page: number, force = false): Promise<ResultPage> {
    // TVBox 统一签名是 (key, quick, pg)；CMS 兼容两参数，py/js 需要三参数。
    return pageCache.load(
      cacheKeys.search(siteKey, keyword, page),
      CACHE_TTL.search,
      () => spider<ResultPage>(siteKey, "searchContent", [keyword, false, page]),
      force,
    ).then((result) => {
      rememberCards(siteKey, result?.list);
      return result;
    });
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

  /**
   * 按片名（可带年份）取豆瓣元数据；没匹配上时后端返回 `null`，不是错误。
   *
   * 代理参数由 Rust 侧决定怎么用（内置前缀或用户自定义前缀），前端只透传
   * 设置里的选择，这样换代理不用改 command 签名。调用方是 `src/lib/douban.ts`，
   * 失败一律静默降级，详情页不依赖它。
   */
  doubanMeta(
    title: string,
    year?: string,
    proxyType?: DoubanProxyType,
    proxyPrefix?: string,
  ): Promise<DoubanMeta | null> {
    return call("douban_meta", { title, year, proxyType, proxyPrefix });
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

  /** 拉取节目单并按频道名匹配，返回当前频道的当日节目列表。 */
  liveEpg(epgUrl: string, channel: string, date?: string): Promise<EpgResult> {
    // Tauri v2 默认把 Rust 参数 snake_case(epg_url) 映射成 JS 的 camelCase(epgUrl)。
    return call("live_epg", { epgUrl, channel, date });
  },

  /**
   * 预热节目单原始表（只下载不解析）。直播页挂载时调一次：`e.xml` 有 7.6 MB，
   * 冷缓存首次要十几秒，用户点频道时再拉就会对着「加载节目单…」干等。
   */
  liveEpgWarm(epgUrl: string): Promise<void> {
    return call("live_epg_warm", { epgUrl });
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
