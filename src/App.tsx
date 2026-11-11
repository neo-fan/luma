import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Spinner from "./components/Spinner";
import NavIcon from "./components/NavIcon";
import CategoryPage from "./pages/CategoryPage";
import DetailPage from "./pages/DetailPage";
import FavoritesPage from "./pages/FavoritesPage";
import HomePage from "./pages/HomePage";
import LivePage from "./pages/LivePage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import { canFailover } from "./lib/format";
import { api, errorMessage } from "./lib/invoke";
import { pageCache } from "./lib/pageCache";
import { clearSourceCache, setSourceCacheScope } from "./lib/sourceCache";
import { clearPageStates } from "./lib/usePageState";
import { log } from "./lib/logger";
import { APP_VERSION } from "./lib/version";
import type { ConfigSnapshot, LiveSource, Site } from "./types/tvbox";

/**
 * 只有播放页走按需加载：ArtPlayer + hls.js 约 750 kB 全在它里面，占首屏体积
 * 的八成以上。其余页面每个只有几 kB，静态导入让导航同步直出——既不会有
 * chunk 加载空窗，也不会破坏窗口探针「点完侧栏立即操作 DOM」的时序。
 */
const PlayerPage = lazy(() => import("./pages/PlayerPage"));

/** 单窗口内的视图联合类型；不使用 react-router。 */
export type View =
  | { name: "home" }
  | { name: "category"; siteKey: string; tid: string; title: string }
  | { name: "search" }
  | { name: "detail"; siteKey: string; vodId: string; /** 搜索/列表已知片名，用于提前预取换源候选 */ title?: string }
  | {
      name: "player";
      siteKey: string;
      vodId: string;
      vodName: string;
      playUrl: string;
      episodeName: string;
      /** TVBox 线路名（vod_play_from），playerContent 的第一个参数。 */
      playFrom?: string;
      /** 直播源声明的 UA；`lives[].ua` 只在拉列表时用过，播放也要带。 */
      ua?: string;
    }
  | { name: "live" }
  | { name: "favorites" }
  | { name: "settings" };

/** replace=true 时替换栈顶，用于同页切换剧集，避免返回键回退到上一集。 */
export type Navigate = (view: View, replace?: boolean) => void;

const SITE_CACHE_KEY = "luma:sites:v1";
const LEGACY_SITE_CACHE_KEY = "tvbox:sites:v1";
const SIDEBAR_KEY = "luma:sidebar:v1";
/** 稳定空数组：让下游 useEffect 的 sites 引用不会每次渲染都变化。 */
const EMPTY_SITES: Site[] = [];

/** 侧栏收缩状态；读取失败时保持展开。 */
function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

/** 视图标识：用于按「栈深度 + 页面」保存滚动位置，同名页面不同深度互不覆盖。 */
function viewKey(view: View): string {
  switch (view.name) {
    case "category":
      return `category:${view.siteKey}:${view.tid}`;
    case "detail":
      return `detail:${view.siteKey}:${view.vodId}`;
    case "player":
      return `player:${view.siteKey}:${view.vodId}:${view.playUrl}`;
    default:
      return view.name;
  }
}

interface SiteCache {
  configId: string;
  sites: Site[];
  lives: LiveSource[];
}

const NAV_ITEMS: { key: "home" | "live" | "search" | "favorites" | "settings"; label: string }[] = [
  { key: "home", label: "首页" },
  { key: "live", label: "直播" },
  { key: "search", label: "搜索" },
  { key: "favorites", label: "收藏" },
  { key: "settings", label: "设置" },
];

/** 最近一次导入的站点列表缓存：configList 不返回站点，重启后靠它恢复。 */
function readSiteCache(): SiteCache | null {
  try {
    const raw =
      window.localStorage.getItem(SITE_CACHE_KEY) ??
      window.localStorage.getItem(LEGACY_SITE_CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const cache = parsed as { configId?: unknown; sites?: unknown; lives?: unknown };
    if (typeof cache.configId !== "string" || !Array.isArray(cache.sites)) {
      return null;
    }
    return {
      configId: cache.configId,
      sites: cache.sites as Site[],
      lives: Array.isArray(cache.lives) ? (cache.lives as LiveSource[]) : [],
    };
  } catch {
    return null;
  }
}

export default function App() {
  const [stack, setStack] = useState<View[]>([{ name: "home" }]);
  const [cache, setCache] = useState<SiteCache | null>(() => readSiteCache());
  const [preferredSite, setPreferredSite] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

  // 收缩偏好跨重启保留；StrictMode 双调用只是写同一个值。
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      // 本地存储失败不影响本次会话。
    }
  }, [sidebarCollapsed]);

  const sites = cache?.sites ?? EMPTY_SITES;
  const lives = cache?.lives ?? [];
  // py / js 运行时已在 P1 落地，只有 jvm（P2）暂时不可用。
  const usableSites = useMemo(
    () => sites.filter((item) => item.runtime !== "jvm" && item.enabled),
    [sites],
  );
  const siteKey = useMemo(() => {
    if (preferredSite && usableSites.some((item) => item.key === preferredSite)) {
      return preferredSite;
    }
    return usableSites[0]?.key ?? "";
  }, [preferredSite, usableSites]);

  const view = stack[stack.length - 1];
  const scrollKey = `${stack.length}:${viewKey(view)}`;
  const contentRef = useRef<HTMLElement | null>(null);
  /** 切页前保存、切页后恢复；只存数字，不占内存。 */
  const scrollPositions = useRef(new Map<string, number>());
  const scrollKeyRef = useRef(scrollKey);

  const saveScroll = useCallback(() => {
    const el = contentRef.current;
    if (el) {
      scrollPositions.current.set(scrollKeyRef.current, el.scrollTop);
    }
  }, []);

  // 恢复要等一帧：详情页缓存命中是同步直出，但布局撑开 scrollHeight 需要 rAF。
  useLayoutEffect(() => {
    scrollKeyRef.current = scrollKey;
    const el = contentRef.current;
    if (!el) {
      return;
    }
    const saved = scrollPositions.current.get(scrollKey) ?? 0;
    el.scrollTop = saved;
    const frame = window.requestAnimationFrame(() => {
      el.scrollTop = saved;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollKey]);

  const navigate = useCallback<Navigate>((next, replace = false) => {
    saveScroll();
    setStack((current) =>
      replace ? [...current.slice(0, -1), next] : [...current, next],
    );
  }, [saveScroll]);

  const back = useCallback(() => {
    saveScroll();
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, [saveScroll]);

  const resetTo = useCallback((next: View) => {
    saveScroll();
    setStack([next]);
  }, [saveScroll]);

  const handleImported = useCallback((snapshot: ConfigSnapshot) => {
    // 换了配置（或重新导入同一份）后，旧站点的详情/分类与页面筛选状态
    // 都不能再复用；scope 变化会清一次，同 id 重导入也强制清一次。
    pageCache.setScope(snapshot.id);
    pageCache.clear();
    setSourceCacheScope(snapshot.id);
    clearSourceCache();
    clearPageStates();
    scrollPositions.current.clear();
    const next: SiteCache = {
      configId: snapshot.id,
      sites: snapshot.sites,
      lives: (snapshot.lives ?? []) as LiveSource[],
    };
    setCache(next);
    try {
      window.localStorage.setItem(SITE_CACHE_KEY, JSON.stringify(next));
    } catch {
      // 本地缓存失败不影响本次会话使用。
    }
  }, []);

  const handleConfigRemoved = useCallback((id: string) => {
    pageCache.clear();
    clearSourceCache();
    clearPageStates();
    scrollPositions.current.clear();
    setCache((current) => {
      if (!current || current.configId !== id) {
        return current;
      }
      try {
        window.localStorage.removeItem(SITE_CACHE_KEY);
      window.localStorage.removeItem(LEGACY_SITE_CACHE_KEY);
      } catch {
        // 忽略缓存清理失败。
      }
      return null;
    });
  }, []);

  // 后端 active 配置与 localStorage 缓存可能不一致（重启后后端换了配置、
  // 外部删了配置文件等）。启动时以 Rust 的 ConfigStore 为准刷新一次，
  // 否则会出现「界面列着 101 个站点、聚合搜索却跑 0 个站点」。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const snapshot = await api.configActive();
        if (!alive || !snapshot || snapshot.sites.length === 0) {
          return;
        }
        // 后端 active 配置是唯一真源；换过配置就让旧 scope 的缓存整体失效。
        pageCache.setScope(snapshot.id);
        setSourceCacheScope(snapshot.id);
        // 后端是唯一真源：即使 configId 相同，运行策略升级（例如导入时屏蔽
        // jar 源）也会改变 sites，必须无条件覆盖旧缓存，否则前端又会列出
        // 已被禁止运行的站点。
        const next: SiteCache = {
          configId: snapshot.id,
          sites: snapshot.sites,
          lives: (snapshot.lives ?? []) as LiveSource[],
        };
        setCache(next);
        try {
          window.localStorage.setItem(SITE_CACHE_KEY, JSON.stringify(next));
        } catch {
          // 本地缓存失败不影响本次会话。
        }
        log.info("app ready", {
          version: APP_VERSION,
          configId: snapshot.id,
          configName: snapshot.name,
          sites: snapshot.sites.length,
          enabled: snapshot.sites.filter((site) => site.enabled).length,
          lives: snapshot.lives?.length ?? 0,
        });
      } catch (err) {
        // 后端没有该命令时保留本地缓存，不打断启动。
        log.warn("config_active failed", { message: errorMessage(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const section =
    view.name === "category" || view.name === "detail" || view.name === "player"
      ? "home"
      : view.name;

  const content = (() => {
    switch (view.name) {
      case "home":
        return (
          <HomePage
            sites={sites}
            siteKey={siteKey}
            onSiteChange={setPreferredSite}
            navigate={navigate}
          />
        );
      case "category":
        return (
          <CategoryPage
            siteKey={view.siteKey}
            tid={view.tid}
            title={view.title}
            onBack={back}
            navigate={navigate}
          />
        );
      case "search":
        return <SearchPage sites={sites} navigate={navigate} />;
      case "detail":
        return (
          <DetailPage
            key={`${view.siteKey}:${view.vodId}`}
            siteKey={view.siteKey}
            vodId={view.vodId}
            title={view.title}
            siteName={sites.find((item) => item.key === view.siteKey)?.name}
            sites={sites}
            navigate={navigate}
            onBack={back}
          />
        );
      case "player": {
        // `changeable: 0` 的源不允许跨站换源，别再对它发起搜索。
        const site = sites.find((item) => item.key === view.siteKey);
        return (
          <PlayerPage
            siteKey={view.siteKey}
            vodId={view.vodId}
            vodName={view.vodName}
            episodeName={view.episodeName}
            playUrl={view.playUrl}
            playFrom={view.playFrom}
            liveUa={view.ua}
            allowFailover={canFailover(site)}
            sites={sites}
            siteName={site?.name}
            navigate={navigate}
            onBack={back}
          />
        );
      }
      case "live":
        return <LivePage lives={lives} navigate={navigate} />;
      case "favorites":
        return <FavoritesPage navigate={navigate} />;
      case "settings":
        return (
          <SettingsPage
            activeConfigId={cache?.configId}
            onImported={handleImported}
            onConfigRemoved={handleConfigRemoved}
          />
        );
    }
  })();

  return (
    <div className="app">
      <aside className={sidebarCollapsed ? "sidebar is-collapsed" : "sidebar"}>
        <div className="brand">
          <span className="brand__mark">
            <img src="/icon.svg" alt="" />
          </span>
          <span className="brand__text">
            Luma
            <small>TVBox 兼容</small>
          </span>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={section === item.key ? "nav__item is-active" : "nav__item"}
              onClick={() => resetTo({ name: item.key })}
              // 收缩后文字隐藏，靠 title / aria-label 保持可读与可访问。
              title={item.label}
              aria-label={item.label}
            >
              <span className="nav__icon">
                <NavIcon name={item.key} />
              </span>
              <span className="nav__label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar__bottom">
          <button
            type="button"
            className="sidebar__collapse"
            onClick={() => setSidebarCollapsed((value) => !value)}
            aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            <span className="nav__icon">
              <NavIcon name={sidebarCollapsed ? "collapse-right" : "collapse-left"} />
            </span>
            <span className="nav__label">{sidebarCollapsed ? "展开" : "收起"}</span>
          </button>
          <div className="sidebar__foot">
            <span>本地播放框架</span>
            <span>Luma · v{APP_VERSION}</span>
          </div>
        </div>
      </aside>
      <main className="content" ref={contentRef}>
        <Suspense
          fallback={
            <section className="page">
              <Spinner label="正在打开页面…" />
            </section>
          }
        >
          {content}
        </Suspense>
      </main>
    </div>
  );
}
