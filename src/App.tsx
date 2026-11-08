import { useCallback, useMemo, useState } from "react";
import CategoryPage from "./pages/CategoryPage";
import DetailPage from "./pages/DetailPage";
import FavoritesPage from "./pages/FavoritesPage";
import HomePage from "./pages/HomePage";
import LivePage from "./pages/LivePage";
import PlayerPage from "./pages/PlayerPage";
import SearchPage from "./pages/SearchPage";
import SettingsPage from "./pages/SettingsPage";
import type { ConfigSnapshot, LiveSource, Site } from "./types/tvbox";

/** 单窗口内的视图联合类型；不使用 react-router。 */
export type View =
  | { name: "home" }
  | { name: "category"; siteKey: string; tid: string; title: string }
  | { name: "search" }
  | { name: "detail"; siteKey: string; vodId: string }
  | {
      name: "player";
      siteKey: string;
      vodId: string;
      vodName: string;
      playUrl: string;
      episodeName: string;
    }
  | { name: "live" }
  | { name: "favorites" }
  | { name: "settings" };

/** replace=true 时替换栈顶，用于同页切换剧集，避免返回键回退到上一集。 */
export type Navigate = (view: View, replace?: boolean) => void;

const SITE_CACHE_KEY = "tvbox:sites:v1";

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
    const raw = window.localStorage.getItem(SITE_CACHE_KEY);
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

  const sites = cache?.sites ?? [];
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

  const navigate = useCallback<Navigate>((next, replace = false) => {
    setStack((current) =>
      replace ? [...current.slice(0, -1), next] : [...current, next],
    );
  }, []);

  const back = useCallback(() => {
    setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }, []);

  const resetTo = useCallback((next: View) => {
    setStack([next]);
  }, []);

  const handleImported = useCallback((snapshot: ConfigSnapshot) => {
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
    setCache((current) => {
      if (!current || current.configId !== id) {
        return current;
      }
      try {
        window.localStorage.removeItem(SITE_CACHE_KEY);
      } catch {
        // 忽略缓存清理失败。
      }
      return null;
    });
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
        return <SearchPage sites={sites} siteKey={siteKey} navigate={navigate} />;
      case "detail":
        return (
          <DetailPage
            siteKey={view.siteKey}
            vodId={view.vodId}
            siteName={sites.find((item) => item.key === view.siteKey)?.name}
            navigate={navigate}
            onBack={back}
          />
        );
      case "player":
        return (
          <PlayerPage
            siteKey={view.siteKey}
            vodId={view.vodId}
            vodName={view.vodName}
            episodeName={view.episodeName}
            playUrl={view.playUrl}
            navigate={navigate}
            onBack={back}
          />
        );
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
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark">TV</span>
          <span className="brand__text">
            TVBox
            <small>Desktop</small>
          </span>
        </div>
        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={section === item.key ? "nav__item is-active" : "nav__item"}
              onClick={() => resetTo({ name: item.key })}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar__foot">
          <span>本地播放框架</span>
          <span>v0.1.0</span>
        </div>
      </aside>
      <main className="content">{content}</main>
    </div>
  );
}
