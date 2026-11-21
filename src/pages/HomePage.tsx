import { FolderOpen, Puzzle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Navigate } from "../lib/nav";
import AsyncBoundary from "../components/AsyncBoundary";
import Empty from "../components/Empty";
import IconButton from "../components/IconButton";
import FavStar from "../components/FavStar";
import SiteSelect from "../components/SiteSelect";
import { toggleFavoriteSite, useFavoriteSites } from "../lib/siteFavorites";
import HomeHero from "../components/HomeHero";
import HomeSkeleton from "../components/HomeSkeleton";
import PosterRail from "../components/PosterRail";
import SearchSkeleton from "../components/Skeleton";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import {
  activeOptionV,
  buildExtend,
  filterDefsFor,
} from "../lib/categoryFilters";
import { CACHE_TTL } from "../lib/queryClient";
import { putDetailSeed } from "../lib/handoff";
import { notify } from "../lib/notify";
import { leafClasses } from "../lib/categories";
import { usableHomeSites } from "../lib/format";
import {
  capItems,
  clampLoadedPages,
  dropLru,
  putLru,
  type LruStore,
} from "../lib/listLimits";
import { usePageState } from "../lib/usePageState";
import type { HomeResult, ResultPage, Site, VodInfo } from "../types/luma";

interface HomePageProps {
  sites: Site[];
  siteKey: string;
  onSiteChange: (key: string) => void;
  /** 当前站是「用户从未确认过的默认站」时为空站自动顺延；用户手动选站后为 false。 */
  isDefaultSite: boolean;
  navigate: Navigate;
}

/** 默认站首页无推荐时，最多再往后试探几个站，避免冷启动落在空站上像坏了。 */
const AUTO_FALLBACK_LIMIT = 6;

/**
 * 默认站首页只给了分类、没有推荐列表时，从它后面依次找第一个真正有
 * `list` 的可用站。探测通过 `load` 注入（通常是 `api.home`），便于单测。
 * 只试「当前站往后 LIMIT 个」，不对全站发请求，避免冷启动风暴。
 */
export async function findHomeSiteWithList(
  candidates: { key: string }[],
  currentKey: string,
  load: (key: string) => Promise<{ list?: unknown[] }>,
  isAlive: () => boolean = () => true,
): Promise<string | null> {
  const from = candidates.findIndex((item) => item.key === currentKey);
  if (from < 0) {
    return null;
  }
  for (const candidate of candidates.slice(
    from + 1,
    from + 1 + AUTO_FALLBACK_LIMIT,
  )) {
    if (!isAlive()) {
      return null;
    }
    try {
      const result = await load(candidate.key);
      if ((result?.list ?? []).length > 0) {
        return candidate.key;
      }
    } catch {
      // 探测失败就跳到下一个候选，不影响其它站。
    }
  }
  return null;
}

/**
 * 首页「直接用页内缓存跳过请求」的判定（纯函数，便于在 node 下行为测试）。
 *
 * 四个前提缺一不可，外加一个 TTL 闸门：
 * - 缓存归属当前站（`homeState.siteKey === siteKey`），否则是别的站的残留；
 * - 真的有推荐（`hasList`）：只有分类的源 / 一次网络抖动留下的空结果绝不缓存，
 *   否则「有缓存就跳过」会让首页永久停在空态、自动顺延也再没机会跑；
 * - 不是手动刷新（`reload === 0`）、不是主动切站（`!force`）；
 * - 页内缓存未过期：`now - storedAt < ttlMs`。usePageState 本身没有 TTL，
 *   缺这道闸门就会「挂几小时返回首页仍是旧内容、且一次回源机会都不给」。
 *   超过 TTL 一律回到请求路径，由 数据缓存（`CACHE_TTL.home`）处理真正的
 *   新鲜度——数据缓存 TTL 内返回首页仍秒开，行为不变。
 */
export function shouldSkipHomeRequest(
  decision: {
    owned: boolean;
    hasList: boolean;
    storedAt: number;
    reload: number;
    force: boolean;
  },
  now: number = Date.now(),
  ttlMs: number = CACHE_TTL.home,
): boolean {
  if (!decision.owned || !decision.hasList || decision.reload !== 0 || decision.force) {
    return false;
  }
  return now - decision.storedAt < ttlMs;
}

/**
 * 站点切换防抖窗口：下拉连点时只在用户停下后发一次请求。
 * 300ms 足够覆盖「按住方向键快速扫过多个站点 / 连续点选」，又不会让
 * 正常切换显得迟钝。
 */
const SWITCH_DEBOUNCE_MS = 300;

/** 沉浸式首页：推荐列表前 5 条进头图轮播，其余进横排。 */
const HERO_COUNT = 5;
/** 分类无限滚动的硬上限：超过后停止翻页，避免 catItems 无限增长。 */
const MAX_CAT_PAGES = 20;
const MAX_CAT_ITEMS = 1200;
/** 推荐流页内快照只保留最近几个站点；73 个站点各留一份会平白吃掉 renderer 内存。 */
const MAX_HOME_SNAPSHOTS = 6;

/**
 * 首页推荐数据 + 归属站点键 + 写入时刻。存储随站点换键（usePageState 渲染期取值），
 * 但「这份数据由哪个站点拉回」仍要由值自己携带：跨挂载、自动顺延等路径里
 * siteKey 与数据并非原子变化，归属判断以数据为准才不会把旧站列表当成新站
 * 结果（跳过请求 / 闪现空态，2026-11-15 CDP 实测）。
 *
 * `storedAt` 是页内缓存的写入时刻（epoch ms）：usePageState 本身没有 TTL，
 * 没有它「挂几小时返回首页」会一直命中页内缓存、连一次回源机会都不给，
 * 数据缓存 的 5 分钟新鲜度形同虚设。加载 effect 用 `now - storedAt` 决定是否
 * 跳过请求；超过 TTL 一律走请求路径，新鲜度交由 数据缓存 处理（见
 * {@link shouldSkipHomeRequest}）。
 */
type ScopedHome = { siteKey: string; data: HomeResult | null; storedAt: number };

const EMPTY_HOME: ScopedHome = { siteKey: "", data: null, storedAt: 0 };

/** 首页内联的分类选择：tid="" 表示回到推荐流。存站点 key 是为了切站后
 *  不把上一个站点的 type_id 带过去（TVBox 的 tid 只在产生它的站点有效）。
 *  page 字段在无限滚动下复用为「已加载页数」，而非「当前页码」。 */
interface CategorySelection {
  siteKey: string;
  tid: string;
  page: number;
}

/**
 * 由单页结果推断是否还有下一页：
 * - endless 源（pagecount≈9999）看本页是否还有条目，有就继续；
 * - 普通源看当前页是否小于上报总页数（部分 py 源第 2 页会把 pagecount 报成 1，
 *   取 max(1, pagecount, 本页号) 避免「2/1」这种自相矛盾）。
 */
function morePages(result: ResultPage, page: number): boolean {
  const raw = result.pagecount ?? 1;
  if (raw >= 999) {
    return (result.list ?? []).length > 0;
  }
  return page < Math.max(1, raw, result.page ?? page);
}

/** 首页：站点切换 + 分类标签（页内切换）+ 推荐/分类网格。 */
export default function HomePage({
  sites,
  siteKey,
  onSiteChange,
  isDefaultSite,
  navigate,
}: HomePageProps) {
  // 首页推荐内容按站点保留，返回首页时直接出结果；只留最近 6 个站点，
  // 避免 73 个站点各存一份 HomeResult（含整张推荐列表）把 renderer 撑大。
  const favoriteSites = useFavoriteSites();
  const [homeSnapshots, setHomeSnapshots] = usePageState<LruStore<ScopedHome>>(
    "home:data:v3",
    { values: {}, order: [] },
  );
  const homeState = homeSnapshots.values[siteKey] ?? EMPTY_HOME;
  const rememberHome = useCallback(
    (next: ScopedHome) => {
      setHomeSnapshots((prev) =>
        putLru(prev, next.siteKey, next, MAX_HOME_SNAPSHOTS),
      );
    },
    [setHomeSnapshots],
  );
  const forgetHome = useCallback(
    (key: string) => setHomeSnapshots((prev) => dropLru(prev, key)),
    [setHomeSnapshots],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  /**
   * 分类直接切换底下这张网格，不再 push 一个二级页面：选中态、页码跨
   * 「看详情 → 返回」保留，和原 CategoryPage 的体验一致。
   */
  const [selection, setSelection] = usePageState<CategorySelection>(
    "home:category:v1",
    {
      siteKey,
      tid: "",
      page: 1,
    },
  );
  const activeTid = selection.siteKey === siteKey ? selection.tid : "";
  /**
   * 分类无限滚动：累积已加载的多页，向下滚动到底自动拉下一页。
   * selection.page 复用为「已加载页数」，跨「看详情 → 返回」保留；返回时按缓存
   * 瞬间补齐已加载的页，滚动位置不丢。
   */
  const [catItems, setCatItems] = useState<VodInfo[]>([]);
  const [catNext, setCatNext] = useState(1);
  const [catHasMore, setCatHasMore] = useState(true);
  const [catLoading, setCatLoading] = useState(false);
  const [catLoadingMore, setCatLoadingMore] = useState(false);
  /** 因 20 页 / 1200 条上限而停止，区别于源站自然到底。 */
  const [catCapReached, setCatCapReached] = useState(false);
  const [catError, setCatError] = useState("");
  const [catReload, setCatReload] = useState(0);
  /**
   * 筛选面板选中值：`{ [filterKey]: 选项v }`。空串/未选=「全部」，不进
   * extend（py 源对缺省值有自己的默认语义，塞空串反而覆盖）。切站 / 切
   * 分类时重置——TVBox 的筛选定义与选中值都只对产生它的分类有效。
   */
  const [filterSel, setFilterSel] = useState<Record<string, string>>({});
  /** 下拉的即时值；真正的 siteKey 由防抖后的 onSiteChange 更新。 */
  const [draftSite, setDraftSite] = useState(siteKey);
  /** 下一次 siteKey 生效时是否跳过缓存（用户主动切换 = 自动刷新）。 */
  const forceNextRef = useRef<string | null>(null);
  const switchTimerRef = useRef<number | null>(null);
  /** 用户一旦手动选站，就别再自动顺延——即使选中的站首页为空也尊重。 */
  const userActedRef = useRef(false);
  /** 本轮自动顺延已试过的站，避免 onSiteChange 前后反复试探同一站。 */
  const fallbackTriedRef = useRef<Set<string>>(new Set());
  /**
   * 本次 reload 是不是**用户点刷新**引起的（而不是切站 / 自动顺延）。
   * 只用于决定要不要在完成后回一句「已刷新」——刷新是用户主动发起、
   * 结果却可能与上一屏完全一样（CMS 推荐位是固定的），没有确认就等于
   * 「按钮没反应」。
   */
  const manualRefreshRef = useRef(false);
  /**
   * 本次挂载内「加载 effect 已排上过号」的站点。加载 effect 只在
   * siteKey/reload 变化时运行，同一次挂载里空结果不会再排号；用它区分
   * 「这一帧还没排号（pendingHome）」和「请求已结束但确实是空（该出空态）」。
   */
  const loadScheduledRef = useRef<Set<string>>(new Set());

  const site = sites.find((item) => item.key === siteKey);
  // CMS 的父级分类（有子分类）在 `ac=videolist&t=<父级>` 上返回空列表，
  // 只展示叶子分类，避免用户点进一个永远为空、分页也永远禁用的类目。
  const classes = leafClasses(
    homeState.data?.classes?.length ? homeState.data.classes : (site?.categories ?? []),
  );
  // 值的归属以数据自己携带的 siteKey 为准：usePageState 现在在渲染期换值，
  // 键一变这份读回的就是新站点的数据（没有则为 null），不存在旧数据串页。
  const homeForSite = homeState.siteKey === siteKey ? homeState.data : null;
  const list = homeForSite?.list ?? [];
  /** 空结果不算有效缓存：只有真正拉到列表才阻止重复请求。 */
  const hasList = list.length > 0;
  const selectedSite = sites.some((item) => item.key === draftSite)
    ? draftSite
    : siteKey;

  // 当前分类的筛选定义（豆瓣[py] 等 py/js 源在 homeContent(filter=true) 里
  // 顺带返回；CMS 源没有）。定义与选中值一起算出 extend。两层都要 memo：
  // filterDefs 不 memo 的话每次渲染都是新数组，activeExtend 的 useMemo
  // 依赖失效、分类加载 effect 每帧重跑（请求风暴，2026-11-20 实测）。
  const filterMap = homeForSite?.filters ?? null;
  const filterDefs = useMemo(
    () => filterDefsFor(filterMap, activeTid),
    [filterMap, activeTid],
  );
  const activeExtend = useMemo(
    () => buildExtend(filterDefs, filterSel),
    [filterDefs, filterSel],
  );
  /** loadMore / 手动刷新 effect 只订阅 catReload 等自己的信号，extend 走 ref 取最新。 */
  const extendRef = useRef(activeExtend);
  extendRef.current = activeExtend;
  /** 上一次分类加载用的 extend 签名：识别「筛选变了」，避免沿用旧页数。 */
  const extendSignatureRef = useRef("");

  // 新策略只屏蔽 jvm（Android dex/jar）源，quickjs 已解禁。
  // 旧 localStorage 缓存没有 disabledReason：这里按 runtime 兜一层，
  // 保证 enabled=true 的 jvm 站仍被判为屏蔽。
  const blockedKeys = new Set(
    sites
      .filter(
        (item) =>
          Boolean(item.disabledReason) ||
          item.runtime === "jvm" ||
          item.enabled === false,
      )
      .map((item) => item.key),
  );
  const blockedHints = new Map(
    sites.map((item) => [
      item.key,
      Boolean(item.disabledReason) || item.runtime === "jvm"
        ? "已屏蔽"
        : "已禁用",
    ]),
  );

  // 外部 siteKey 变化（配置加载、App 恢复偏好）时同步下拉显示。
  useEffect(() => {
    setDraftSite(siteKey);
  }, [siteKey]);

  useEffect(() => {
    return () => {
      if (switchTimerRef.current !== null) {
        window.clearTimeout(switchTimerRef.current);
      }
    };
  }, []);

  /**
   * 站点切换：立即更新下拉显示，300ms 后才真正切换并强制刷新。
   * 快速 A→B→C 只会请求 C；C 与当前站点相同时直接取消，不发请求。
   */
  const switchSite = (next: string) => {
    setDraftSite(next);
    // 用户主动选站：永久关闭默认空站的自动顺延，尊重其选择。
    userActedRef.current = true;
    if (switchTimerRef.current !== null) {
      window.clearTimeout(switchTimerRef.current);
    }
    switchTimerRef.current = window.setTimeout(() => {
      switchTimerRef.current = null;
      if (next === siteKey) {
        return;
      }
      forceNextRef.current = next;
      onSiteChange(next);
    }, SWITCH_DEBOUNCE_MS);
  };

  useEffect(() => {
    const force = forceNextRef.current === siteKey;
    if (force) {
      forceNextRef.current = null;
    }
    if (siteKey) {
      loadScheduledRef.current.add(siteKey);
    }
    // 已有「有内容」缓存、且不是手动刷新 / 主动切站点：跳过整个请求。
    // 注意用 hasList 而非 home：空结果（如只给分类的豆瓣源、或一次网络
    // 抖动）绝不缓存，否则「有缓存就跳过」会让首页永久停在空态、无法自愈。
    // TTL 闸门见 shouldSkipHomeRequest：页内缓存超过 CACHE_TTL.home 不再跳过，
    // 回到请求路径，由 数据缓存 处理新鲜度（数据缓存 TTL 内仍秒开）。
    if (
      shouldSkipHomeRequest({
        owned: homeForSite !== null,
        hasList,
        storedAt: homeState.storedAt,
        reload,
        force,
      })
    ) {
      // 走到这里说明本次不需要请求，但上一个 effect 可能在被取消时留下
      // loading=true（切站/StrictMode 双跑都会）：不清掉的话刷新图标会一直
      // 转、按钮一直 disabled，用户点不动刷新。命中缓存直接收敛成静止态。
      setLoading(false);
      return;
    }
    let alive = true;
    const run = async () => {
      if (!siteKey) {
        forgetHome(siteKey);
        setError("");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      // 冷启动或刚导入配置后，站点写入与页面挂载可能抢跑，失败时自动重试一次。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await api.home(siteKey, reload > 0 || force);
          if (alive) {
            // 空结果不写缓存：下次进入重新拉，也让自动顺延每次都有机会执行。
            // 有内容才缓存，保证返回首页仍能秒开。
            // 有卡片、或只有分类的源都要留住：DRPY/js 源的推荐流经常是空的
            // （源侧接口本身不给），分类才是唯一入口——若按 list 判空就会把
            // classes 一起丢掉，页面只剩「暂无分类 + 暂无推荐内容」，看起来像
            // 这个源彻底坏了。
            const cards = (result?.list ?? []).length;
            const cats = (result?.classes ?? []).length;
            rememberHome({
              siteKey,
              data: cards > 0 || cats > 0 ? result : null,
              storedAt: Date.now(),
            });
            setError("");
            setLoading(false);
            if (manualRefreshRef.current) {
              manualRefreshRef.current = false;
              notify.success(
                cards > 0
                  ? `已刷新 · ${cards} 个内容`
                  : "已刷新 · 该站点没有推荐内容",
              );
            }
          }
          // 冷启动默认站若**既没卡片也没分类**，自动往后找第一个真有内容的
          // 站并记住，避免首页看起来「没数据」。只给分类的源不算空——它的分类
          // 就是入口。仅发生在用户从未手动选站时；用户主动选的站一律尊重。
          if (
            alive &&
            (result?.list ?? []).length === 0 &&
            (result?.classes ?? []).length === 0 &&
            isDefaultSite &&
            !userActedRef.current &&
            !fallbackTriedRef.current.has(siteKey)
          ) {
            fallbackTriedRef.current.add(siteKey);
            void (async () => {
              const next = await findHomeSiteWithList(
                usableHomeSites(sites),
                siteKey,
                (key) => api.home(key),
                () => alive,
              );
              if (next && alive && !userActedRef.current) {
                // onSiteChange 写 preferredSite 并持久化，下次冷启动直接用它。
                onSiteChange(next);
              }
            })();
          }
          return;
        } catch (err) {
          if (!alive) {
            return;
          }
          if (attempt === 1) {
            rememberHome({ siteKey, data: null, storedAt: Date.now() });
            setError(errorMessage(err));
            setLoading(false);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 600));
          if (!alive) {
            return;
          }
        }
      }
      if (alive) {
        setLoading(false);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [siteKey, reload, rememberHome, forgetHome]);

  /**
   * 分类无限滚动的「进入 / 切换」：站点或分类变化时，按已加载页数
   * （selection.page，看详情返回时保留）从 数据缓存 瞬间补齐多页并累积；
   * 首次进入该分类只拉第 1 页。页面本身不动（页头、站点下拉、分类 chip 常驻）。
   */
  useEffect(() => {
    if (!activeTid || !siteKey) {
      setCatItems([]);
      setCatNext(1);
      setCatHasMore(true);
      setCatCapReached(false);
      setCatLoading(false);
      return;
    }
    const extendChanged = extendSignatureRef.current !== JSON.stringify(activeExtend);
    extendSignatureRef.current = JSON.stringify(activeExtend);
    // 筛选条件变化（或按条件重新进入）时：旧条件下已加载的页数对新条件毫无
    // 意义（pagecount/条目完全不同），只拉第 1 页。
    const requestedPages =
      !extendChanged && selection.siteKey === siteKey ? Math.max(1, selection.page) : 1;
    const pagesLoaded = clampLoadedPages(requestedPages, MAX_CAT_PAGES);
    // 返回时若快照记着超限页数，说明上次就是被上限截住的，不重放第 21 页。
    let capReached = requestedPages > MAX_CAT_PAGES;
    let alive = true;
    setCatItems([]);
    setCatNext(1);
    setCatHasMore(true);
    setCatCapReached(false);
    setCatLoading(true);
    setCatError("");
    void (async () => {
      const all: VodInfo[] = [];
      let hasMore = true;
      for (let page = 1; page <= pagesLoaded && alive; page += 1) {
        try {
          const result = await api.category(siteKey, activeTid, page, false, activeExtend);
          all.push(...(result.list ?? []));
          const nextHasMore = morePages(result, page);
          if (all.length >= MAX_CAT_ITEMS && nextHasMore) {
            capReached = true;
            hasMore = false;
            break;
          }
          hasMore = nextHasMore;
          if (!hasMore) {
            break;
          }
        } catch (err) {
          if (alive) {
            setCatError(errorMessage(err));
            // 出错即停：避免哨兵反复重试同一条会失败的请求。
            hasMore = false;
          }
          break;
        }
      }
      if (alive) {
        const capped = capItems(all, MAX_CAT_ITEMS);
        setCatItems(capped.items);
        setCatNext(clampLoadedPages(pagesLoaded + 1, MAX_CAT_PAGES));
        setCatHasMore(hasMore && !capped.truncated && pagesLoaded < MAX_CAT_PAGES);
        setCatCapReached(capReached || capped.truncated);
        setCatLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // selection 故意不进依赖：只在站点 / 分类变化时重跑；page 由 loadMore 更新，
    // 不应触发整段重拉。activeExtend 变化（筛选面板点选）必须整段重拉：
    // 换条件后第 1 页就不同了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, activeTid, activeExtend]);

  /** 切站 / 切分类时清空筛选选中值（定义与选中值都只对产生它的分类有效）。 */
  useEffect(() => {
    setFilterSel({});
  }, [siteKey, activeTid]);

  const isCategory = activeTid !== "";
  const catList = catItems;
  const shownList = isCategory ? catList : list;
  /**
   * 首页请求是否「在途但 loading 还没置上」。setLoading(true) 发生在 effect
   * 回调里，切站/换源后的第一帧它还是 false——骨架必须从这一帧就顶上，
   * 否则 AsyncBoundary 会先闪一帧空态。
   */
  const pendingHome =
    !isCategory &&
    !hasList &&
    Boolean(siteKey) &&
    !loadScheduledRef.current.has(siteKey);
  const busy = isCategory ? catLoading || catLoadingMore : loading || pendingHome;
  const shownError = isCategory ? catError : error;
  // 沉浸式首页：头图轮播吃掉前 5 条，剩下的铺成横排（不够 5 条时只出头图）。
  const heroItems = list.slice(0, HERO_COUNT);
  const railItems = list.length > HERO_COUNT ? list.slice(HERO_COUNT) : [];
  const siteLabel = site?.name ?? siteKey;

  /** 推荐区头图/横排与分类区卡片共用同一个进详情入口。 */
  const openVod = useCallback(
    (vod: VodInfo) => {
      // 手上的卡片直接交给详情页做首帧，落地不必先等 detailContent。
      putDetailSeed(siteKey, vod);
      navigate({
        name: "detail",
        siteKey,
        vodId: String(vod.vod_id),
        title: vod.vod_name,
      });
    },
    [navigate, siteKey],
  );

  /**
   * 拉下一页并追加到累积列表；由底部哨兵（IntersectionObserver）在滚动到底前触发。
   * 出错即把 hasMore 置否，避免哨兵反复重试同一条会失败的请求形成死循环。
   */
  const loadMore = useCallback(() => {
    if (!activeTid || !siteKey || !catHasMore || catLoadingMore || catLoading) {
      return;
    }
    const page = catNext;
    if (page > MAX_CAT_PAGES) {
      setCatHasMore(false);
      setCatCapReached(true);
      return;
    }
    setCatLoadingMore(true);
    void (async () => {
      try {
        const result = await api.category(siteKey, activeTid, page, false, extendRef.current);
        const items = result.list ?? [];
        const merged = capItems([...catItems, ...items], MAX_CAT_ITEMS);
        const sourceHasMore = morePages(result, page);
        const byPageLimit = page + 1 > MAX_CAT_PAGES;
        const limitStopped =
          merged.truncated || byPageLimit || catItems.length >= MAX_CAT_ITEMS;
        setCatItems(merged.items);
        setCatNext(clampLoadedPages(page + 1, MAX_CAT_PAGES));
        setCatHasMore(sourceHasMore && !limitStopped);
        setCatCapReached(limitStopped && (sourceHasMore || merged.truncated));
        // 持久化已加载页数，返回详情后从缓存瞬间补回、滚动位置不丢。
        setSelection((prev) =>
          prev.siteKey === siteKey
            ? { ...prev, tid: activeTid, page: page + 1 }
            : prev,
        );
      } catch (err) {
        setCatError(errorMessage(err));
        setCatHasMore(false);
      } finally {
        setCatLoadingMore(false);
      }
    })();
  }, [activeTid, siteKey, catHasMore, catLoadingMore, catLoading, catNext, catItems]);

  /** 强制刷新分类：清空累积，绕过缓存重新拉第 1 页。 */
  useEffect(() => {
    if (catReload === 0 || !activeTid || !siteKey) {
      return;
    }
    let alive = true;
    setCatItems([]);
    setCatNext(1);
    setCatHasMore(true);
    setCatCapReached(false);
    setCatLoading(true);
    setCatError("");
    void (async () => {
      try {
        const result = await api.category(siteKey, activeTid, 1, true, extendRef.current);
        if (alive) {
          const items = result.list ?? [];
          const capped = capItems(items, MAX_CAT_ITEMS);
          setCatItems(capped.items);
          setCatNext(2);
          setCatHasMore(morePages(result, 1) && !capped.truncated);
          setCatCapReached(capped.truncated);
          setSelection((prev) =>
            prev.siteKey === siteKey
              ? { ...prev, tid: activeTid, page: 1 }
              : prev,
          );
          if (manualRefreshRef.current) {
            manualRefreshRef.current = false;
            notify.success(
              capped.items.length > 0
                ? `已刷新 · ${capped.items.length} 个内容`
                : "已刷新 · 该分类暂无内容",
            );
          }
        }
      } catch (err) {
        if (alive) {
          setCatError(errorMessage(err));
          setCatHasMore(false);
        }
      } finally {
        if (alive) {
          setCatLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catReload]);

  /** 底部哨兵：进入视口前 400px 即拉下一页；用 ref 持有最新 loadMore 避免反复重建观察器。 */
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !isCategory) {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMoreRef.current();
        }
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [isCategory]);

  const selectCategory = (tid: string) => {
    const next = String(tid);
    setSelection({
      siteKey,
      tid: String(activeTid) === next ? "" : next,
      page: 1,
    });
  };

  /**
   * 筛选点选：点「全部」（v=""）或再点已选项 = 清除该组（回源默认）；
   * 其它 = 记入选中值。extend 变化由分类加载 effect 的 activeExtend 依赖
   * 收口，这里只管状态。
   */
  const pickFilter = (key: string, value: string) => {
    setFilterSel((prev) => {
      const next = { ...prev };
      if (value === "" || prev[key] === value) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  };
  /** 刷新的是「当前看得见的那张网格」：分类态刷分类，推荐态刷首页。 */
  const refreshVisible = () => {
    manualRefreshRef.current = true;
    if (isCategory) {
      setCatReload((value) => value + 1);
    } else {
      setReload((value) => value + 1);
    }
  };

  if (sites.length === 0) {
    return (
      <section className="page page--home">
        <header className="page-head">
          <h1 className="page-title">首页</h1>
        </header>
        <Empty
          title="还没有导入订阅"
          description="导入一份订阅后，这里会列出可用的站点与推荐内容。"
          icon={FolderOpen}
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate({ name: "settings" })}
            >
              去导入订阅
            </button>
          }
        />
      </section>
    );
  }

  if (sites.length > 0 && !siteKey) {
    return (
      <section className="page page--home">
        <header className="page-head">
          <h1 className="page-title">首页</h1>
        </header>
        <Empty
          title={`当前订阅的 ${sites.length} 个站点都需要 jar 运行时`}
          description="这些是 csp_/jar 源，依赖 Android 运行时（P2）。可以先用「直播」页，或导入含 CMS / py / js 站点的订阅。"
          icon={Puzzle}
        />
      </section>
    );
  }

  return (
    <section className="page page--home">
      {/* 页头 + 分类 chip 在滚动区之外：滚多长的网格都能换站 / 刷新 / 切分类。 */}
      <header className="page-head">
        <div className="page-head__main">
          <h1 className="page-title">首页</h1>
          <SiteSelect
            sites={sites}
            value={selectedSite}
            onChange={switchSite}
            allowAll={false}
            disabledKeys={blockedKeys}
            disabledHints={blockedHints}
          />
          {siteKey ? (
            <FavStar
              className="site-fav"
              on={favoriteSites.includes(siteKey)}
              onToggle={() => toggleFavoriteSite(siteKey)}
            />
          ) : null}
        </div>
        <IconButton
          name="refresh"
          label="刷新"
          busy={busy}
          disabled={!siteKey || busy}
          onClick={refreshVisible}
        />
      </header>

      {/* 分类 chip 是「切换下方网格」，不再是路由跳转：点同一个可取消回到推荐。 */}
      {siteKey ? (
        <div className="chip-row chip-row--tabs">
          <button
            type="button"
            className={isCategory ? "chip" : "chip is-active"}
            aria-pressed={!isCategory}
            onClick={() => selectCategory("")}
          >
            推荐
          </button>
          {classes.length === 0 ? (
            <span className="chip chip--muted">暂无分类</span>
          ) : (
            classes.map((item) => (
              <button
                key={item.type_id}
                type="button"
                className={
                  activeTid === item.type_id ? "chip is-active" : "chip"
                }
                aria-pressed={activeTid === item.type_id}
                title={
                  item.parentName
                    ? `${item.parentName} / ${item.type_name}`
                    : item.type_name
                }
                onClick={() => selectCategory(item.type_id)}
              >
                {item.type_name || item.type_id}
              </button>
            ))
          )}
        </div>
      ) : null}

      {/* 筛选面板：TVBox `homeContent(filter=true)` 返回的 filters（豆瓣[py]
          的「电影筛选/电视筛选」等）。有定义才渲染；每组一行 chips，点
          「全部」清该组。 */}
      {isCategory && filterDefs.length > 0 ? (
        <div className="filter-panel" data-testid="filter-panel">
          {filterDefs.map((def) => {
            const activeV = activeOptionV(def, filterSel);
            return (
              <div className="filter-group" key={def.key}>
                <span className="filter-group__name">{def.name}</span>
                <div className="filter-group__options">
                  {def.value.map((option) => {
                    const active = activeV === option.v;
                    return (
                      <button
                        key={`${option.v}`}
                        type="button"
                        className={active ? "chip chip--filter is-active" : "chip chip--filter"}
                        aria-pressed={active}
                        onClick={() => pickFilter(def.key, option.v)}
                      >
                        {option.n}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <div className="page-body">
        <AsyncBoundary
          loading={busy || pendingHome}
          error={shownError}
          errorTitle={isCategory ? "分类内容加载失败" : "首页内容加载失败"}
          isEmpty={shownList.length === 0}
          loadingLabel={isCategory ? "正在加载分类内容…" : "正在加载首页内容…"}
          skeleton={
            isCategory ? <SearchSkeleton count={12} /> : <HomeSkeleton />
          }
          emptyTitle={isCategory ? "该分类暂无内容" : "该站点暂无推荐内容"}
          emptyDescription={
            isCategory
              ? "换个分类或站点试试。"
              : "可以换一个站点，或直接使用搜索。"
          }
          onRetry={refreshVisible}
        >
          {isCategory ? (
            <div className="vod-grid">
              {shownList.map((vod) => (
                <VodCard
                  // 不用下标拼 key：刷新/切分类时列表重排会让 React 重挂卡片、重下封面。
                  key={String(vod.vod_id)}
                  title={vod.vod_name}
                  pic={vod.vod_pic}
                  remarks={vod.vod_remarks}
                  onOpen={() => openVod(vod)}
                />
              ))}
            </div>
          ) : (
            // 沉浸式首页（需求 2026-11-15）：整幅头图轮播 + 横向推荐条，像腾讯视频那样
            // 一行一行左右翻，而不是一屏格子；分类 tab 仍是卡片网格。
            <>
              <HomeHero items={heroItems} onOpen={openVod} site={siteLabel} />
              {railItems.length > 0 ? (
                <PosterRail
                  title="为你推荐"
                  items={railItems}
                  onOpen={openVod}
                  site={siteLabel}
                />
              ) : null}
            </>
          )}
        </AsyncBoundary>

        {isCategory ? (
          <div className="infinite-foot">
            {catLoadingMore ? <Spinner label="正在加载更多…" /> : null}
            {catCapReached ? (
              <p className="tip">
                已加载 {MAX_CAT_ITEMS} 条上限；刷新可从头重新加载。
              </p>
            ) : null}
            {!catHasMore && !catCapReached && catItems.length > 0 ? (
              <p className="tip">已经到底啦，没有更多内容了</p>
            ) : null}
            {/* 滚动哨兵：进入视口前 400px 自动拉下一页；已无更多时不再触发 */}
            <div
              ref={sentinelRef}
              className="infinite-sentinel"
              aria-hidden="true"
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
