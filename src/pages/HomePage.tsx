import { useEffect, useRef, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import IconButton from "../components/IconButton";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { leafClasses } from "../lib/categories";
import { usableHomeSites } from "../lib/format";
import { usePageState } from "../lib/usePageState";
import type { HomeResult, ResultPage, Site } from "../types/tvbox";

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
  for (const candidate of candidates.slice(from + 1, from + 1 + AUTO_FALLBACK_LIMIT)) {
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
 * 站点切换防抖窗口：下拉连点时只在用户停下后发一次请求。
 * 300ms 足够覆盖「按住方向键快速扫过多个站点 / 连续点选」，又不会让
 * 正常切换显得迟钝。
 */
const SWITCH_DEBOUNCE_MS = 300;

/** 首页内联的分类选择：tid="" 表示回到推荐流。存站点 key 是为了切站后
 *  不把上一个站点的 type_id 带过去（TVBox 的 tid 只在产生它的站点有效）。 */
interface CategorySelection {
  siteKey: string;
  tid: string;
  page: number;
}

/** 首页：站点切换 + 分类标签（页内切换）+ 推荐/分类网格。 */
export default function HomePage({
  sites,
  siteKey,
  onSiteChange,
  isDefaultSite,
  navigate,
}: HomePageProps) {
  // 首页推荐内容按站点保留，返回首页时直接出结果；站点 key 变化时自然失效。
  const [home, setHome] = usePageState<HomeResult | null>(`home:${siteKey}:data`, null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  /**
   * 分类直接切换底下这张网格，不再 push 一个二级页面：选中态、页码跨
   * 「看详情 → 返回」保留，和原 CategoryPage 的体验一致。
   */
  const [selection, setSelection] = usePageState<CategorySelection>("home:category:v1", {
    siteKey,
    tid: "",
    page: 1,
  });
  const activeTid = selection.siteKey === siteKey ? selection.tid : "";
  const catPage = selection.siteKey === siteKey ? selection.page : 1;
  const [catData, setCatData] = useState<ResultPage | null>(null);
  const [catLoading, setCatLoading] = useState(false);
  const [catError, setCatError] = useState("");
  const [catReload, setCatReload] = useState(0);
  /** 强制刷新只用一次：不像「reload>0 常驻」那样把后续翻页都变成绕过缓存。 */
  const catForceRef = useRef(false);
  /** 下拉的即时值；真正的 siteKey 由防抖后的 onSiteChange 更新。 */
  const [draftSite, setDraftSite] = useState(siteKey);
  /** 下一次 siteKey 生效时是否跳过缓存（用户主动切换 = 自动刷新）。 */
  const forceNextRef = useRef<string | null>(null);
  const switchTimerRef = useRef<number | null>(null);
  /** 用户一旦手动选站，就别再自动顺延——即使选中的站首页为空也尊重。 */
  const userActedRef = useRef(false);
  /** 本轮自动顺延已试过的站，避免 onSiteChange 前后反复试探同一站。 */
  const fallbackTriedRef = useRef<Set<string>>(new Set());

  const site = sites.find((item) => item.key === siteKey);
  // CMS 的父级分类（有子分类）在 `ac=videolist&t=<父级>` 上返回空列表，
  // 只展示叶子分类，避免用户点进一个永远为空、分页也永远禁用的类目。
  const classes = leafClasses(home?.classes?.length ? home.classes : site?.categories ?? []);
  const list = home?.list ?? [];
  /** 空结果不算有效缓存：只有真正拉到列表才阻止重复请求。 */
  const hasList = list.length > 0;
  const selectedSite = sites.some((item) => item.key === draftSite) ? draftSite : siteKey;

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
    // 已有「有内容」缓存、且不是手动刷新 / 主动切站点：跳过整个请求。
    // 注意用 hasList 而非 home：空结果（如只给分类的豆瓣源、或一次网络
    // 抖动）绝不缓存，否则「有缓存就跳过」会让首页永久停在空态、无法自愈。
    if (home && hasList && reload === 0 && !force) {
      // 走到这里说明本次不需要请求，但上一个 effect 可能在被取消时留下
      // loading=true（切站/StrictMode 双跑都会）：不清掉的话刷新图标会一直
      // 转、按钮一直 disabled，用户点不动刷新。命中缓存直接收敛成静止态。
      setLoading(false);
      return;
    }
    let alive = true;
    const run = async () => {
      if (!siteKey) {
        setHome(null);
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
            setHome((result?.list ?? []).length > 0 ? result : null);
            setError("");
            setLoading(false);
          }
          // 冷启动默认站若只给分类、没有推荐列表（如豆瓣源），自动往后找
          // 第一个有内容的站并记住，避免首页看起来「没数据」。仅发生在
          // 用户从未手动选站时；用户主动选的站（哪怕空）一律尊重。
          if (
            alive &&
            (result?.list ?? []).length === 0 &&
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
            setHome(null);
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
  }, [siteKey, reload]);

  /**
   * 选中分类后只替换下方网格，页面本身不动（页头、站点下拉、分类 chip 常驻）。
   * 数据走 api.category 的 pageCache：看完详情返回时是 0 IPC 直出。
   */
  useEffect(() => {
    if (!activeTid || !siteKey) {
      setCatData(null);
      setCatError("");
      setCatLoading(false);
      return;
    }
    let alive = true;
    const run = async () => {
      setCatLoading(true);
      setCatError("");
      // 换分类/翻页时先清掉旧列表，避免新 chip 已高亮、下面还挂着上一个分类的卡片。
      setCatData(null);
      const force = catForceRef.current;
      catForceRef.current = false;
      try {
        const result = await api.category(siteKey, activeTid, catPage, force);
        if (alive) {
          setCatData(result);
        }
      } catch (err) {
        if (alive) {
          setCatData(null);
          setCatError(errorMessage(err));
        }
      } finally {
        if (alive) {
          setCatLoading(false);
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [siteKey, activeTid, catPage, catReload]);

  const isCategory = activeTid !== "";
  const catList = catData?.list ?? [];
  const currentPage = catData?.page ?? catPage;
  const rawPageCount = catData?.pagecount ?? 1;
  // py 源常用 9999 表示「还有下一页」，把它当真实总页数会显示成「1 / 9999」。
  const endless = rawPageCount >= 999;
  // 部分 py 源翻到第 2 页会把 pagecount 报成 1，取「当前页 + 源报的总数」的
  // 较大值，避免出现「2 / 1」这种自相矛盾的页码。
  const pageCount = Math.max(1, rawPageCount, currentPage);
  const pageLabel = endless ? `第 ${currentPage} 页` : `${currentPage} / ${pageCount}`;
  // 当前页真的没内容时别再放行「下一页」，否则会一页页走进永久空列表。
  const noMore = !catLoading && !!catData && catList.length === 0;
  const shownList = isCategory ? catList : list;
  const busy = isCategory ? catLoading : loading;
  const shownError = isCategory ? catError : error;
  const selectCategory = (tid: string) => {
    const next = String(tid);
    setSelection({ siteKey, tid: String(activeTid) === next ? "" : next, page: 1 });
  };
  const setPage = (page: number) =>
    setSelection({ siteKey, tid: String(activeTid), page: Math.max(1, page) });
  /** 刷新的是「当前看得见的那张网格」：分类态刷分类，推荐态刷首页。 */
  const refreshVisible = () => {
    if (isCategory) {
      catForceRef.current = true;
      setCatReload((value) => value + 1);
    } else {
      setReload((value) => value + 1);
    }
  };

  if (sites.length === 0) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">首页</h1>
        </header>
        <Empty
          title="请先在设置导入配置"
          description="导入 TVBox 配置后，这里会列出可用的站点与推荐内容。"
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate({ name: "settings" })}
            >
              前往设置
            </button>
          }
        />
      </section>
    );
  }

  if (sites.length > 0 && !siteKey) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">首页</h1>
        </header>
        <Empty
          title={`当前配置的 ${sites.length} 个站点都需要 jar 运行时`}
          description="这些是 csp_/jar 源，依赖 Android 运行时（P2）。可以先用「直播」页，或导入含 CMS / py / js 站点的配置。"
        />
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <h1 className="page-title">首页</h1>
          <select
            className="select"
            value={selectedSite}
            onChange={(event) => switchSite(event.target.value)}
            aria-label="选择站点"
          >
            {sites.map((item) => {
              // 新策略只屏蔽 jvm（Android dex/jar）源，quickjs 已解禁。
              // 旧 localStorage 缓存没有 disabledReason：这里按 runtime 兜一层，
              // 保证 enabled=true 的 jvm 站仍被判为屏蔽。
              const blocked = Boolean(item.disabledReason) || item.runtime === "jvm";
              const suffix = blocked ? "（已屏蔽）" : item.enabled ? "" : "（已禁用）";
              return (
                <option key={item.key} value={item.key} disabled={blocked || !item.enabled}>
                  {item.name}
                  {suffix}
                </option>
              );
            })}
          </select>
        </div>
        <IconButton
          name="refresh"
          label="刷新"
          busy={busy}
          disabled={!siteKey || busy}
          onClick={refreshVisible}
        />
      </header>

      {shownError ? (
        <ErrorBar
          message={`${isCategory ? "分类" : "首页"}加载失败：${shownError}`}
          onRetry={refreshVisible}
        />
      ) : null}

      {!siteKey ? (
        <Empty
          title="没有可用的 CMS 站点"
          description="当前配置里没有启用中的 CMS 站点，请检查配置或到设置重新导入。"
        />
      ) : null}

      {/* 分类 chip 是「切换下方网格」，不再是路由跳转：点同一个可取消回到推荐。 */}
      {siteKey ? (
        <div className="chip-row">
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
                className={activeTid === item.type_id ? "chip is-active" : "chip"}
                aria-pressed={activeTid === item.type_id}
                title={item.parentName ? `${item.parentName} / ${item.type_name}` : item.type_name}
                onClick={() => selectCategory(item.type_id)}
              >
                {item.type_name || item.type_id}
              </button>
            ))
          )}
        </div>
      ) : null}

      {busy && shownList.length === 0 ? (
        <Spinner center label={isCategory ? "正在加载分类内容…" : "正在加载首页内容…"} />
      ) : null}

      {!busy && siteKey && !shownError && shownList.length === 0 ? (
        <Empty
          title={isCategory ? "该分类暂无内容" : "该站点暂无推荐内容"}
          description={
            isCategory
              ? `第 ${currentPage} 页没有内容，可点上一页返回或换个分类试试。`
              : "可以换一个站点，或直接使用搜索。"
          }
        />
      ) : null}

      {shownList.length > 0 ? (
        <div className="vod-grid">
          {shownList.map((vod, index) => (
            <VodCard
              key={`${vod.vod_id}-${index}`}
              title={vod.vod_name}
              pic={vod.vod_pic}
              remarks={vod.vod_remarks}
              onOpen={() =>
                navigate({
                  name: "detail",
                  siteKey,
                  vodId: String(vod.vod_id),
                  title: vod.vod_name,
                })
              }
            />
          ))}
        </div>
      ) : null}

      {isCategory ? (
        <div className="pager">
          <IconButton
            name="back"
            label="上一页"
            disabled={catLoading || catPage <= 1}
            onClick={() => setPage(catPage - 1)}
          />
          <span className="pager__label">{pageLabel}</span>
          <IconButton
            name="next"
            label="下一页"
            disabled={catLoading || noMore || (!endless && catPage >= pageCount)}
            onClick={() => setPage(catPage + 1)}
          />
        </div>
      ) : null}
    </section>
  );
}
