import { createHashRouter, Navigate as Redirect, useLocation, useParams, useSearchParams } from "react-router-dom";
import AppShell, { useConfigActions } from "./AppShell";
import DetailPage from "./pages/DetailPage";
import FavoritesPage from "./pages/FavoritesPage";
import HistoryPage from "./pages/HistoryPage";
import HomePage from "./pages/HomePage";
import LivePage from "./pages/LivePage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import { lazy } from "react";
import { canFailover } from "./lib/format";
import { navBack, navNavigate, type DetailNavState, type PlayerNavState } from "./lib/nav";
import { useAppStore, useSiteState } from "./stores/appStore";

/**
 * 只有播放页走按需加载：ArtPlayer + hls.js 约 750 kB 全在它里面，占首屏体积
 * 的八成以上。其余页面每个只有几 kB，静态导入让导航同步直出——既不会有
 * chunk 加载空窗，也不会破坏窗口探针「点完侧栏立即操作 DOM」的时序。
 */
const PlayerPage = lazy(() => import("./pages/PlayerPage"));

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

function PlayerPageRoute() {
  const { siteKey = "", vodId = "" } = useParams();
  const location = useLocation();
  const state = (location.state ?? null) as PlayerNavState | null;
  const { sites } = useSiteState();
  // 直接输 URL / history.state 丢失（如 WebView 恢复会话）时没有播放参数，
  // 回首页兜底，绝不空转解析。
  if (!state?.playUrl) {
    return <Redirect to="/" replace />;
  }
  // `changeable: 0` 的源不允许跨站换源，别再对它发起搜索。
  const site = sites.find((item) => item.key === siteKey);
  return (
    <PlayerPage
      // 换源 / 切集 / 切线路都替换当前条目（不新增层级），但必须换 key：
      // 否则 React 复用同一实例，旧的 ArtPlayer / hls.js / 计时器与
      // 新地址解析交错，出现「只有声音没画面」或双流双声。key 变化让
      // 整页干净卸载，所有播放内核按 effect cleanup 顺序彻底销毁。
      key={`${siteKey}:${vodId}:${state.playUrl}`}
      siteKey={siteKey}
      vodId={vodId}
      vodName={state.vodName}
      episodeName={state.episodeName}
      playUrl={state.playUrl}
      playFrom={state.playFrom}
      liveUa={state.ua}
      liveLines={state.liveLines}
      liveLine={state.liveLine}
      liveSource={state.liveSource}
      failoverKey={state.failoverKey}
      allowFailover={canFailover(site)}
      sites={sites}
      siteName={site?.name}
      navigate={navNavigate}
      onBack={navBack}
    />
  );
}

function LivePageRoute() {
  const lives = useAppStore((s) => s.cache?.lives ?? []);
  return <LivePage lives={lives} navigate={navNavigate} />;
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
