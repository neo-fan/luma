import {
  createHashRouter,
  Navigate as Redirect,
  useLocation,
  useNavigate,
  useParams,
  useRouteError,
  useSearchParams,
} from "react-router-dom";
import AppShell, { useConfigActions } from "./AppShell";
import DetailPage from "./pages/DetailPage";
import FavoritesPage from "./pages/FavoritesPage";
import HistoryPage from "./pages/HistoryPage";
import HomePage from "./pages/HomePage";
import PlayPage from "./pages/PlayPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import { useEffect } from "react";
import Empty from "./components/Empty";
import { log } from "./lib/logger";
import { navBack, navNavigate, type DetailNavState, type PlayerNavState } from "./lib/nav";
import { useAppStore, useSiteState } from "./stores/appStore";

/**
 * 播放页本体走按需加载（ArtPlayer + hls.js 约 750 kB），但**渲染位置挪到了
 * AppShell 的常驻层**：路由只同步会话，播放器不随路由卸载，切页后继续播。
 */

/**
 * 路由级错误边界。
 *
 * react-router 默认渲染的 "Unexpected Application Error" 只有一段英文堆栈：
 * 用户看不出发生了什么，日志里也没有记录（React 把这个异常交给了路由边界，
 * 不会再冒泡到 window.onerror）。所以这里自己接住：
 *   · 先把异常写进前端日志（`target: "ui"`，落到 logs/ui/ui.<date>.log）；
 *   · 再给用户可操作的出口（重试 / 回首页 / 复制错误）。
 * 边界只包一层：错误页本身不允许再依赖页面级组件，保持能在任何情况下渲染。
 */
function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();

  const info = (() => {
    if (error instanceof Error) {
      return { message: error.message, stack: error.stack ?? "" };
    }
    return { message: String(error ?? "unknown error"), stack: "" };
  })();

  useEffect(() => {
    log.error("route error", {
      message: info.message,
      stack: info.stack.slice(0, 3000),
      hash: window.location.hash,
    });
  }, [info.message, info.stack]);

  return (
    <section className="page">
      <header className="page-head">
        <h1 className="page-title">页面出错了</h1>
      </header>
      <Empty
        title={info.message}
        description="这一步触发了前端异常，详情已经写进日志（设置 → 诊断里可以导出）。可以重试，或先回首页。"
        action={
          <div className="route-error__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate(0)}
            >
              重试
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                window.location.hash = "#/";
              }}
            >
              回到首页
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(
                  `${info.message}\n\n${info.stack}`,
                );
              }}
            >
              复制错误
            </button>
          </div>
        }
      />
    </section>
  );
}

/** 侧栏 / 命令面板的平级跳转（resetTo 语义）由 AppShell 直接处理。 */

function HomePageRoute() {
  const { sites, siteKey, preferredSite } = useSiteState();
  const setPreferredSite = useAppStore((s) => s.setPreferredSite);
  return (
    <HomePage
      sites={sites}
      siteKey={siteKey}
      onSiteChange={setPreferredSite}
      isDefaultSite={!preferredSite}
      navigate={navNavigate}
    />
  );
}

function SearchPageRoute() {
  const { sites } = useSiteState();
  const [params] = useSearchParams();
  return (
    <SearchPage
      sites={sites}
      navigate={navNavigate}
      initialKeyword={params.get("q") ?? undefined}
    />
  );
}

function DetailPageRoute() {
  const { siteKey = "", vodId = "" } = useParams();
  const location = useLocation();
  const { title } = (location.state ?? {}) as DetailNavState;
  const { sites } = useSiteState();
  return (
    <DetailPage
      // 同一路径不同条目（换了影片）必须干净重挂载，避免旧详情状态串页。
      key={`${location.key}`}
      siteKey={siteKey}
      vodId={vodId}
      title={title}
      siteName={sites.find((item) => item.key === siteKey)?.name}
      sites={sites}
      navigate={navNavigate}
      onBack={navBack}
    />
  );
}

/**
 * 播放页路由**不再自己渲染播放器**：播放器常驻在 AppShell（见 PlayerHost），
 * 这里只负责把导航 state 同步进全局播放会话。这样切到首页/搜索/设置时播放
 * 不会中断（后台继续播），侧栏「播放」随时能切回来。
 */
function PlayerPageRoute() {
  const { siteKey = "", vodId = "" } = useParams();
  const location = useLocation();
  const state = (location.state ?? null) as PlayerNavState | null;
  const openPlaySession = useAppStore((s) => s.openPlaySession);
  const nav = useNavigate();
  useEffect(() => {
    // 旧会话 / 旧链接里的直播地址：直播有自己的播放页，这里不该接。
    if (siteKey === "live") {
      nav("/live", { replace: true });
      return;
    }
    if (state?.playUrl) {
      openPlaySession({
        siteKey,
        vodId,
        vodName: state.vodName,
        playUrl: state.playUrl,
        episodeName: state.episodeName,
        playFrom: state.playFrom,
        failoverKey: state.failoverKey,
      });
      return;
    }
    // 直接输 URL / WebView 恢复会话导致 state 丢失：没有地址就没法解析，
    // 有旧会话（内存里还在播）就让它继续，否则回首页兜底，绝不空转。
    if (!useAppStore.getState().playSession) {
      nav("/", { replace: true });
    }
  }, [siteKey, vodId, state, openPlaySession, nav]);
  return null;
}

/**
 * 直播播放页**不挂在路由里**，而是和点播播放器一样常驻在 AppShell。
 *
 * 需求（2026-11-15 用户）：「直播页面需要支持后台播放，除非切换到点播页面，
 * 不然他应该在后台播放」＋「直播和点播只能播放一个」。要保住同一条流，就必须
 * 保住同一个 ArtPlayer / hls.js 实例：路由切走就卸载页面 = 重新拉流。
 * 所以 `/live` 只占一个路由位（让 URL / 侧栏高亮成立），真正渲染在
 * `AppShell` 的常驻层里，切页只切 `visibility`。
 */

function SettingsPageRoute() {
  const activeConfigId = useAppStore((s) => s.cache?.configId);
  const sites = useAppStore((s) => s.cache?.sites);
  const actions = useConfigActions();
  return (
    <SettingsPage
      activeConfigId={activeConfigId}
      sites={sites ?? []}
      onImported={actions?.onImported ?? (() => {})}
      onConfigRemoved={actions?.onConfigRemoved ?? (() => {})}
    />
  );
}

export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    // 任何子路由的渲染异常都收在这里（AppShell 自身崩了也能接住）。
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomePageRoute /> },
      { path: "live", element: null },
      { path: "search", element: <SearchPageRoute /> },
      { path: "favorites", element: <FavoritesRoute /> },
      { path: "history", element: <HistoryRoute /> },
      { path: "settings", element: <SettingsPageRoute /> },
      { path: "detail/:siteKey/:vodId", element: <DetailPageRoute /> },
      // 「播放」入口始终存在：没有会话时落到 /player 的续播页（取最近一条历史），
      // 一条历史都没有时是空态，而不是把人送回首页。
      { path: "player", element: <PlayPageRoute /> },
      { path: "player/:siteKey/:vodId", element: <PlayerPageRoute /> },
      // 未知路径回首页兜底（hash 路由下不会命中，防御性保留）。
      { path: "*", element: <Redirect to="/" replace /> },
    ],
  },
]);

function FavoritesRoute() {
  return <FavoritesPage navigate={navNavigate} />;
}

function HistoryRoute() {
  return <HistoryPage navigate={navNavigate} />;
}

function PlayPageRoute() {
  return <PlayPage navigate={navNavigate} />;
}
