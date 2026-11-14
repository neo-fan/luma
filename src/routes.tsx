import { createHashRouter, Navigate as Redirect, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import AppShell, { useConfigActions } from "./AppShell";
import DetailPage from "./pages/DetailPage";
import FavoritesPage from "./pages/FavoritesPage";
import HistoryPage from "./pages/HistoryPage";
import HomePage from "./pages/HomePage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import { lazy, useEffect } from "react";
import { navBack, navNavigate, type DetailNavState, type PlayerNavState } from "./lib/nav";
import { useAppStore, useSiteState } from "./stores/appStore";

/**
 * 直播页现在是**播放页**（自带 ArtPlayer + hls.js），不能再静态打进主包：
 * 首页/搜索只需要 DOM，把 ~750 kB 的解码器挂在启动路径上不值得。
 * AppShell 的 Suspense 会接住这次按需加载。
 */
const LivePage = lazy(() => import("./pages/LivePage"));

/**
 * 播放页本体走按需加载（ArtPlayer + hls.js 约 750 kB），但**渲染位置挪到了
 * AppShell 的常驻层**：路由只同步会话，播放器不随路由卸载，切页后继续播。
 */

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
 * 直播路由就是直播播放页本身（2026-11-14 用户要求：不再有「列表页 → 播放页」
 * 两级）。页面自己管理选中频道，换台只改 state 不进路由。
 */
function LivePageRoute() {
  const lives = useAppStore((s) => s.cache?.lives ?? []);
  return <LivePage lives={lives} />;
}

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
    children: [
      { index: true, element: <HomePageRoute /> },
      { path: "live", element: <LivePageRoute /> },
      { path: "search", element: <SearchPageRoute /> },
      { path: "favorites", element: <FavoritesRoute /> },
      { path: "history", element: <HistoryRoute /> },
      { path: "settings", element: <SettingsPageRoute /> },
      { path: "detail/:siteKey/:vodId", element: <DetailPageRoute /> },
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
