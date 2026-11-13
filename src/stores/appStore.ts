import { useMemo } from "react";
import { create } from "zustand";
import { usableHomeSites } from "../lib/format";
import type { LiveSource, Site } from "../types/tvbox";

const SITE_CACHE_KEY = "luma:sites:v1";
const SIDEBAR_KEY = "luma:sidebar:v1";
/** 首页选中的站点：手动切换与「空站自动顺延」都写这里，跨重启/重开保留。 */
export const HOME_SITE_KEY = "luma:home:site:v1";

/** 最近一次导入的站点列表缓存：configList 不返回站点，重启后靠它恢复。 */
export interface SiteCache {
  configId: string;
  sites: Site[];
  lives: LiveSource[];
}

/** 稳定空数组：让下游 useEffect 的 sites 引用不会每次渲染都变化。 */
export const EMPTY_SITES: Site[] = [];

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

/** 首页上次选中的站点；读不到/损坏时返回空串，交给默认站逻辑。 */
function readHomeSite(): string {
  try {
    return window.localStorage.getItem(HOME_SITE_KEY) ?? "";
  } catch {
    return "";
  }
}

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

interface AppStore {
  /** active 配置快照（站点 + 直播源）；null = 尚未就绪。 */
  cache: SiteCache | null;
  /** 首页选中站点（空串 = 走默认站自动顺延）。 */
  preferredSite: string;
  sidebarCollapsed: boolean;
  setCache: (cache: SiteCache | null) => void;
  setPreferredSite: (key: string) => void;
  setSidebarCollapsed: (value: boolean) => void;
  toggleSidebar: () => void;
}

/**
 * 跨页共享的客户端状态（Zustand）。
 *
 * localStorage 持久化写在 action 里而不是 effect：store 是唯一写入者，
 * 键名与取值格式保持迁移前不变（探针读 `luma:home:site:v1`）。
 * 页面局部状态（各页 useState / pageCache）不进 store。
 */
export const useAppStore = create<AppStore>((set, get) => ({
  cache: readSiteCache(),
  preferredSite: readHomeSite(),
  sidebarCollapsed: readSidebarCollapsed(),
  setCache: (cache) => {
    try {
      if (cache) {
        window.localStorage.setItem(SITE_CACHE_KEY, JSON.stringify(cache));
      } else {
        window.localStorage.removeItem(SITE_CACHE_KEY);
      }
    } catch {
      // 本地存储失败不影响本次会话使用。
    }
    set({ cache });
  },
  setPreferredSite: (key) => {
    try {
      if (key) {
        window.localStorage.setItem(HOME_SITE_KEY, key);
      } else {
        window.localStorage.removeItem(HOME_SITE_KEY);
      }
    } catch {
      // 本地存储失败不影响本次会话使用。
    }
    set({ preferredSite: key });
  },
  setSidebarCollapsed: (value) => {
    try {
      window.localStorage.setItem(SIDEBAR_KEY, value ? "1" : "0");
    } catch {
      // 本地存储失败不影响本次会话使用。
    }
    set({ sidebarCollapsed: value });
  },
  toggleSidebar: () => {
    get().setSidebarCollapsed(!get().sidebarCollapsed);
  },
}));

/**
 * 站点派生量：usableSites 过滤口径与首页「空站自动顺延」共用
 * usableHomeSites，避免两处规则漂移；siteKey 是实际生效的首页站点。
 */
export function useSiteState() {
  const sites = useAppStore((s) => s.cache?.sites ?? EMPTY_SITES);
  const preferredSite = useAppStore((s) => s.preferredSite);
  const usableSites = useMemo(() => usableHomeSites(sites), [sites]);
  const siteKey = useMemo(() => {
    if (preferredSite && usableSites.some((item) => item.key === preferredSite)) {
      return preferredSite;
    }
    return usableSites[0]?.key ?? "";
  }, [preferredSite, usableSites]);
  return { sites, usableSites, siteKey, preferredSite };
}
