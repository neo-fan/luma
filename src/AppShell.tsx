import {
  Suspense,
  lazy,
  useCallback,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import Spinner from "./components/Spinner";
import NavIcon from "./components/NavIcon";
import CommandPalette from "./components/CommandPalette";
import PlayerHost from "./components/player/PlayerHost";
import { Toaster } from "sonner";
import { notify } from "./lib/notify";
import { NOTICE_TTL } from "./lib/notice";
import { usableHomeSites } from "./lib/format";
import { api, errorMessage } from "./lib/invoke";
import { clearDataCache, resetCacheForScope } from "./lib/queryClient";
import { clearSourceCache, setSourceCacheScope } from "./lib/sourceCache";
import { noDetailSources } from "./lib/noDetailSource";
import { forgetCards } from "./lib/cardIndex";
import { clearPageStates } from "./lib/usePageState";
import { clearCoverAttempts } from "./lib/coverBackfill";
import { log } from "./lib/logger";
import {
  APP_VERSION,
  BUILD_TIME,
  formatVersion,
  IS_DEV_BUILD,
  readableBuildTime,
} from "./lib/version";
import { currentStartedAt, loadStartedAt, unifiedBuildStamp } from "./lib/appInfo";
import { navBack, registerNav, viewToLocation, type View } from "./lib/nav";
import { useAppStore, useSiteState, selectLives } from "./stores/appStore";
import type { ConfigSnapshot, LiveSource } from "./types/luma";

/**
 * 直播播放页按需加载（ArtPlayer + hls.js 约 750 kB，不能挂在启动路径上），
 * 但**渲染位置在 AppShell 的常驻层**而不是路由里：切到别的页面时只切
 * visibility，ArtPlayer / hls.js 实例与那条流继续活着（后台播放）。
 */
const LivePage = lazy(() => import("./pages/LivePage"));

/** 侧栏展示用：prerelease 缩写（如 `1.2.0-beta` → `1.2.0.b`），数据源仍是合法 semver。 */
const versionLabel = formatVersion(APP_VERSION);

const NAV_ITEMS: {
  key: NavKey | "player";
  label: string;
}[] = [
  { key: "home", label: "首页" },
  { key: "live", label: "直播" },
  // 「播放」是独立导航项：播放页常驻，切到别的页面后仍在这里切回来继续看。
  // 入口始终显示（需求 2026-11-15）：没有会话时落到 /player 的续播页，
  // 取最近一条历史；没有历史时那里是美化过的空态。
  { key: "player", label: "播放" },
  { key: "search", label: "搜索" },
  { key: "favorites", label: "收藏" },
  { key: "history", label: "历史" },
  { key: "settings", label: "设置" },
];

/** 有固定路由的导航项（`player` 指向当前会话，不在这里）。 */
type NavKey = "home" | "live" | "search" | "favorites" | "history" | "settings";

/**
 * 配置导入/删除动作：布局持有（要清会话缓存），设置页路由包装组件
 * 经此 context 取用。
 */
export interface ConfigActions {
  onImported: (snapshot: ConfigSnapshot) => void;
  onConfigRemoved: (id: string) => void;
}

export const ConfigActionsContext = createContext<ConfigActions | null>(null);

/**
 * 导入新配置或删除配置后，把三类页面缓存（page / source / 封面回填尝试）与
 * 滚动位置一次性清掉：旧站点的详情/分类/筛选状态都不能再复用。两个 handler 都
 * 要这套清场，抽出来避免漂移。
 */
function resetSessionCaches(
  scrollPositions: MutableRefObject<Map<number, number>>,
): void {
  clearDataCache();
  clearSourceCache();
  clearPageStates();
  clearCoverAttempts();
  // 卡片索引按 siteKey 存，换配置后旧的 siteKey 再也不会被访问，留着只是漏内存。
  forgetCards();
  scrollPositions.current.clear();
}

export default function AppShell() {
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setPreferredSite = useAppStore((s) => s.setPreferredSite);
  const setCache = useAppStore((s) => s.setCache);
  const preferredSite = useAppStore((s) => s.preferredSite);
  const playSession = useAppStore((s) => s.playSession);
  const mediaPlaying = useAppStore((s) => s.mediaPlaying);
  const { sites } = useSiteState();

  /** 全局命令面板（Ctrl+K）。 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * 统一 build 号：宿主本次启动时刻（见 `lib/appInfo.ts`）。前端不再自报构建
   * 时间——dev 下 Vite 与 cargo 的构建时刻必然不同，两处数字永远对不上。
   */
  const [startedAt, setStartedAt] = useState(currentStartedAt);
  useEffect(() => {
    let alive = true;
    void loadStartedAt().then((value) => {
      if (alive && value) {
        setStartedAt(value);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const location = useLocation();
  const rNav = useNavigate();
  const contentRef = useRef<HTMLElement | null>(null);

  /* ---------- 直播常驻层 ---------- */
  const lives = useAppStore(selectLives);
  const isLiveRoute = location.pathname === "/live";
  /**
   * 首次进入直播页之后才把常驻层挂上：没进过直播的人不该为它加载
   * ArtPlayer + hls.js 的 750 kB。挂上之后不再卸载——卸载就等于停播。
   */
  const [liveMounted, setLiveMounted] = useState(false);
  useEffect(() => {
    if (isLiveRoute) {
      setLiveMounted(true);
    }
  }, [isLiveRoute]);

  /**
   * 滚动锚点：当前路由页自己的 `.page-body`。
   *
   * `.content` 是 `overflow:hidden`（layout.css:300-308），改版后滚动一律发生在
   * 每个页面的 `.page-body` 里（layout.css:296 已把这条写成约定），所以这里必须
   * 认 `.page-body`，否则保存到的永远是 0。
   *
   * 选择器限定 `:scope > .page .page-body`：常驻直播层 `.live-host` 里也有一棵
   * `.page-body`，它不是当前路由，不参与滚动存取。
   */
  const scrollHost = useCallback(
    () => contentRef.current?.querySelector<HTMLElement>(":scope > .page .page-body") ?? null,
    [],
  );

  /** 切页前保存、切页后恢复；key 是 react-router 分配的 history 序号。 */
  const scrollPositions = useRef(new Map<number, number>());
  const currentIdxRef = useRef(0);

  const saveScroll = useCallback(() => {
    const el = scrollHost();
    if (el) {
      scrollPositions.current.set(currentIdxRef.current, el.scrollTop);
    }
  }, [scrollHost]);

  // 恢复要等一帧：详情页缓存命中是同步直出，但布局撑开 scrollHeight 需要 rAF。
  useLayoutEffect(() => {
    const idx =
      typeof window.history.state?.idx === "number"
        ? window.history.state.idx
        : 0;
    currentIdxRef.current = idx;
    const el = scrollHost();
    if (!el) {
      return;
    }
    const saved = scrollPositions.current.get(idx) ?? 0;
    el.scrollTop = saved;
    const frame = window.requestAnimationFrame(() => {
      el.scrollTop = saved;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.key, scrollHost]);

  // 导航桥：所有页面 props / 自动换线 / 命令面板的跳转都汇到这里，
  // 保证跳转前先保存当前页滚动位置。
  useEffect(() => {
    registerNav({
      navigate: (view: View, replace = false) => {
        saveScroll();
        const loc = viewToLocation(view);
        rNav(loc.pathname + loc.search, { replace, state: loc.state });
      },
      back: () => {
        saveScroll();
        rNav(-1);
      },
      resetTo: (view: View) => {
        saveScroll();
        const loc = viewToLocation(view);
        rNav(loc.pathname + loc.search, { replace: true, state: loc.state });
      },
    });
    return () => registerNav(null);
  }, [rNav, saveScroll]);

  /**
   * 全局 Esc 返回上一级。
   *
   * 输入框里按 Esc 交给控件自己处理（重命名取消、搜索框清空等），换源/选集
   * 弹层也有自己的 Esc 逻辑——这里跳过，避免一次 Esc 既关弹层又退页面。
   * history.state.idx 是 react-router data router 维护的栈深度，0 = 根。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      // 全屏播放器里按 Esc，先让浏览器退出全屏，别顺手把播放页也退掉。
      if (document.fullscreenElement) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (document.querySelector(".source-picker")) {
        return;
      }
      // 命令面板开着时 Esc 只关面板（Radix 处理），别顺手退页面。
      if (document.querySelector("[cmdk-root]")) {
        return;
      }
      if ((window.history.state?.idx ?? 0) > 0) {
        event.preventDefault();
        navBack();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleImported = useCallback(
    (snapshot: ConfigSnapshot) => {
      // 换了配置（或重新导入同一份）后，旧站点的详情/分类与页面筛选状态
      // 都不能再复用；scope 变化会清一次，同 id 重导入也强制清一次。
      resetCacheForScope(snapshot.id);
      setSourceCacheScope(snapshot.id);
      // siteKey 只在同一份配置内有意义，换配置后旧的「无详情源」记忆作废。
      noDetailSources.setScope(snapshot.id);
      resetSessionCaches(scrollPositions);
      setCache({
        configId: snapshot.id,
        sites: snapshot.sites,
        lives: (snapshot.lives ?? []) as LiveSource[],
      });
    },
    [setCache],
  );

  const handleConfigRemoved = useCallback(
    (id: string) => {
      resetSessionCaches(scrollPositions);
      const current = useAppStore.getState().cache;
      if (current && current.configId === id) {
        setCache(null);
      }
    },
    [setCache],
  );

  /**
   * 订阅定时刷新的推送。
   *
   * 后台更新不能静默改数据：Rust 侧换了 active 快照，这里的站点缓存必须
   * 同步替换，否则界面上还是旧站点、fan-out 却已经跑新站点。只在内容真的
   * 变化（`changed`）时替换——没变化就什么都不做，连提示都不弹。
   */
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    void api
      .onConfigRefreshed((outcome) => {
        if (!outcome.changed || !outcome.snapshot) {
          return;
        }
        handleImported(outcome.snapshot);
        notify.success(
          `「${outcome.name}」订阅已自动更新：${outcome.enabled} 个可用站点`,
        );
        log.info("config auto refreshed", {
          id: outcome.configId,
          sites: outcome.sites,
          enabled: outcome.enabled,
        });
      })
      .then((off) => {
        if (alive) {
          unlisten = off;
        } else {
          off();
        }
      })
      .catch((err) => {
        // 老后端 / 无事件权限时退化为「只在设置页手动检查」，不打断启动。
        log.warn("config-refreshed listen failed", {
          message: errorMessage(err),
        });
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [handleImported]);

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
      resetCacheForScope(snapshot.id);
        setSourceCacheScope(snapshot.id);
        noDetailSources.setScope(snapshot.id);
        // 后端是唯一真源：即使 configId 相同，运行策略升级（例如导入时屏蔽
        // jar 源）也会改变 sites，必须无条件覆盖旧缓存，否则前端又会列出
        // 已被禁止运行的站点。
        setCache({
          configId: snapshot.id,
          sites: snapshot.sites,
          lives: (snapshot.lives ?? []) as LiveSource[],
        });
        // 记住的首页站若不在当前 active 配置的可用站里（换配置/重导入/
        // 站点被屏蔽），清掉它，让首页回退到默认站并重新自动顺延。
        const usableKeys = new Set(
          usableHomeSites(snapshot.sites).map((s) => s.key),
        );
        const current = useAppStore.getState().preferredSite;
        if (current && !usableKeys.has(current)) {
          setPreferredSite("");
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
  }, [setCache, setPreferredSite]);

  const sectionPath = `/${location.pathname.split("/")[1] ?? ""}`;
  const isPlayerRoute = location.pathname.startsWith("/player");
  const section = location.pathname.startsWith("/detail")
    ? "home"
    : isPlayerRoute
      ? "player"
      : sectionPath === "/" || sectionPath === ""
        ? "home"
        : sectionPath.slice(1);
  /**
   * 「播放」导航只服务点播会话。
   *
   * 直播有一次独立的播放页（`/live`），不进 playSession；旧版本留下的
   * `siteKey="live"` 会话属于脏数据，不能再出现在这个入口里——点进去是
   * 一个没有直播分支的点播页，只会黑屏。
   */
  const vodSession =
    playSession && playSession.siteKey !== "live" ? playSession : null;
  // 侧栏所有入口始终在位；「播放」指向会依据有没有会话变化，见下方 loc。
  const navItems = NAV_ITEMS;

  return (
    <ConfigActionsContext.Provider
      value={{
        onImported: handleImported,
        onConfigRemoved: handleConfigRemoved,
      }}
    >
      <div className={sidebarCollapsed ? "app is-sidebar-collapsed" : "app"}>
        <aside
          className={sidebarCollapsed ? "sidebar is-collapsed" : "sidebar"}
        >
          <div className="brand">
            <span className="brand__mark">
              <img src="/icon.svg" alt="" />
            </span>
            <span className="brand__text">Luma</span>
          </div>
          <nav className="nav">
            {navItems.map((item) => {
              // 「播放」不是固定路径：有会话时指向会话播放页（随时切回来继续播），
              // 没有会话时落到 /player 续播页（最近一条历史 / 空态）。
              // 播放/直播是常驻层：切到别的页面后音频还在放，图标上亮一个小圆点。
              const showPlayingDot =
                (item.key === "player" && mediaPlaying.vod && !isPlayerRoute) ||
                (item.key === "live" && mediaPlaying.live && !isLiveRoute);
              const loc =
                item.key === "player"
                  ? vodSession
                    ? {
                        pathname: `/player/${encodeURIComponent(vodSession.siteKey)}/${encodeURIComponent(vodSession.vodId)}`,
                        search: "",
                      }
                    : { pathname: "/player", search: "" }
                  : viewToLocation({ name: item.key as NavKey });
              return (
                <button
                  key={item.key}
                  type="button"
                  className={
                    section === item.key ? "nav__item is-active" : "nav__item"
                  }
                  onClick={() => {
                    // 侧栏是「平级切换」：替换当前历史条目（与旧 resetTo 语义一致）。
                    saveScroll();
                    rNav(loc.pathname + loc.search, { replace: true });
                  }}
                  // 收缩后文字隐藏，靠 title / aria-label 保持可读与可访问。
                  title={item.label}
                  aria-label={item.label}
                >
                  <span className="nav__icon">
                    <NavIcon name={item.key} />
                    {showPlayingDot ? <span className="nav__dot" aria-hidden="true" /> : null}
                  </span>
                  <span className="nav__label">{item.label}</span>
                </button>
              );
            })}
          </nav>
          <div className="sidebar__bottom">
            <button
              type="button"
              className="sidebar__collapse"
              onClick={toggleSidebar}
              aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
              title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
            >
              <span className="nav__icon">
                <NavIcon name="collapse" />
              </span>
              <span className="nav__label">
                {sidebarCollapsed ? "展开" : "收起"}
              </span>
            </button>
            <div className="sidebar__foot">
              <span className="sidebar__version">
                version: {versionLabel}
                {/* 调试窗口与已安装的正式版同机并存，版本号一样但数据目录
                    不同（Luma-debug vs Luma），必须一眼可辨。 */}
                {IS_DEV_BUILD ? (
                  <span
                    className="sidebar__dev"
                    title="调试构建（tauri dev）：数据目录、窗口标题都与正式版分开"
                  >
                    dev
                  </span>
                ) : null}
              </span>
              <span
                className="sidebar__stamp"
                title={readableBuildTime(startedAt || BUILD_TIME) || "构建时间戳"}
              >
                build: {unifiedBuildStamp(startedAt) || "unknown"}
              </span>
            </div>
          </div>
        </aside>
        {/* 路由内容：播放页常驻在下方独立层里，这里只渲染其它页面。停在播放
          路由时也要保留 Outlet 挂载——它是首页/搜索等页面的状态容器；滚动不在
          这里，而在每个页面的 `.page-body`（见上方 scrollHost）。 */}
        <main className="content" ref={contentRef}>
          <Suspense
            fallback={
              <section className="page">
                <Spinner label="正在打开页面…" />
              </section>
            }
          >
            <Outlet />
          </Suspense>
          {/* 直播常驻层：停在 /live 时正常显示，切到其它页面只切 visibility
              （DOM 与播放实例都还在，音频继续播）。进点播播放页时由 LivePage
              自己暂停——直播和点播只能有一个在播。
              LivePage 是 lazy 组件，必须自带 Suspense：它在同步输入（点侧栏）
              期间挂载，没有边界的话 React 会直接抛「component suspended while
              responding to synchronous input」。 */}
          {liveMounted ? (
            <Suspense fallback={null}>
              <div
                className={isLiveRoute ? "live-host" : "live-host is-idle"}
                aria-hidden={!isLiveRoute}
              >
                <LivePage
                  lives={lives}
                  vodActive={isPlayerRoute}
                  liveActive={isLiveRoute}
                />
              </div>
            </Suspense>
          ) : null}
        </main>
        {/* 播放器常驻层：切页不卸载，视频继续播（需求：播放页独立导航 + 后台播放）。 */}
        {vodSession ? (
          <PlayerHost session={vodSession} active={isPlayerRoute} />
        ) : null}
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          navigate={(view) => {
            saveScroll();
            const loc = viewToLocation(view);
            rNav(loc.pathname + loc.search, {
              replace: true,
              state: loc.state,
            });
          }}
          sites={sites}
          homeSite={preferredSite}
          onPickHomeSite={(siteKey) => {
            setPreferredSite(siteKey);
            saveScroll();
            rNav("/", { replace: true });
          }}
        />
        <Toaster
          theme="dark"
          /* 右下角：右上角是每页的页头工具条（换源 / 刷新 / 收藏 / 搜索），
             toast 浮在那儿会直接盖住操作，用户只能等 4 秒。 */
          position="bottom-right"
          duration={NOTICE_TTL.info}
          /* 告知类 4s 自动消失：再给一个 × 是纯噪音，还容易被圆角裁掉。
             只有「常驻、需要用户处置」的 error toast 才由 notify.ts 单独开 closeButton。 */
          /* sonner 默认 expand=false：多条提示叠成一摞，后面几条被压得只露
             一条边、文字全被裁掉（看起来像「显示不全」的残影）。全部展开，
             同时最多 3 条，超出由 sonner 排队，条条完整可读。 */
          expand
          visibleToasts={3}
          gap={10}
          toastOptions={{
            style: {
              background: "var(--panel-raised)",
              color: "var(--text)",
              border: "1px solid var(--border-strong)",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--fs-sm)",
            },
          }}
        />
      </div>
    </ConfigActionsContext.Provider>
  );
}

// 供本文件内 ConfigActions 消费方（设置页路由包装）以外的潜在使用方导入。
export function useConfigActions(): ConfigActions | null {
  return useContext(ConfigActionsContext);
}
