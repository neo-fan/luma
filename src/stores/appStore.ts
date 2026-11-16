import { useMemo } from "react";
import { create } from "zustand";
import { usableHomeSites } from "../lib/format";
import {
  HOME_SITE_KEY,
  SIDEBAR_KEY,
  SITE_CACHE_KEY,
} from "../lib/storageKeys";
import { narrowLives, narrowSites } from "../lib/invoke";
import type { LiveSource, Site } from "../types/luma";

/** 首页选中的站点：手动切换与「空站自动顺延」都写这里，跨重启/重开保留。 */
export { HOME_SITE_KEY };

/** 最近一次导入的站点列表缓存：configList 不返回站点，重启后靠它恢复。 */
export interface SiteCache {
  configId: string;
  sites: Site[];
  lives: LiveSource[];
}

/** 稳定空数组：让下游 useEffect 的 sites 引用不会每次渲染都变化。 */
export const EMPTY_SITES: Site[] = [];

/** 稳定空数组：直播源同理，见 `selectLives` 的注释。 */
export const EMPTY_LIVES: LiveSource[] = [];

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
    // localStorage 是唯一「写入方版本 ≠ 读取方版本」的来源：旧版本/被手改过的
    // 缓存里 sites / lives 可能夹带形状漂移的项。收窄层只在这条读回路径上跑，
    // 丢弃非法项；Rust 快照经 setCache 直接落库时不经此处（见 invoke.ts）。
    return {
      configId: cache.configId,
      sites: narrowSites(cache.sites),
      lives: Array.isArray(cache.lives) ? narrowLives(cache.lives) : [],
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
  /**
   * 播放会话：播放页从「路由页」升级为「常驻层」后，这里是唯一真源。
   * 浏览器前进/后退、侧栏切页都不会销毁播放器实例，切回来还在播。
   * null = 还没播过任何东西。
   */
  playSession: PlaySession | null;
  /**
   * 后台播放状态：播放页/直播页是常驻层，切到别的页面后音频还在放。
   * 侧栏图标据此显示一个小圆点，告诉用户「它还在响、切回去还能接上」。
   */
  mediaPlaying: { vod: boolean; live: boolean };
  setCache: (cache: SiteCache | null) => void;
  setPreferredSite: (key: string) => void;
  setSidebarCollapsed: (value: boolean) => void;
  toggleSidebar: () => void;
  openPlaySession: (session: PlaySession) => void;
  setMediaPlaying: (kind: "vod" | "live", playing: boolean) => void;
}

/** 播放会话（与路由 state 同形，AppShell 常驻渲染播放页时用它当 props）。 */
export interface PlaySession {
  siteKey: string;
  vodId: string;
  vodName: string;
  playUrl: string;
  episodeName: string;
  playFrom?: string;
  failoverKey?: string;
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
  playSession: null,
  mediaPlaying: { vod: false, live: false },
  setMediaPlaying: (kind, playing) => {
    const current = get().mediaPlaying;
    if (current[kind] === playing) {
      return;
    }
    // 直播与点播共用一套声音：谁真的在出声，图标就只亮谁。
    // 开播的一方把另一方清零；真正暂停对方由 LivePage / 播放器各自处理。
    const next = playing
      ? { vod: false, live: false, [kind]: true }
      : { ...current, [kind]: false };
    set({ mediaPlaying: next });
  },
  openPlaySession: (session) => {
    // 同一个播放地址重复写入（路由 effect 重跑 / 探针多次点击）不该让常驻
    // 播放器重建：key 里带 playUrl，引用一变就整页重挂载 = 黑屏重播。
    const current = get().playSession;
    if (
      current &&
      current.siteKey === session.siteKey &&
      current.vodId === session.vodId &&
      current.playUrl === session.playUrl
    ) {
      return;
    }
    set({ playSession: session });
  },
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
 * 直播源选择器。
 *
 * 必须在「没有配置」时返回**同一个**空数组引用：zustand 用 Object.is 比较
 * 快照，`s.cache?.lives ?? []` 每次渲染都造新数组，会被判定为「快照一直在变」
 * 而无限重渲染——2026-11-14 实测，没导入配置时打开直播页直接
 * `Maximum update depth exceeded` 白屏（React 的 getSnapshot 警告就是这条）。
 */
export const selectLives = (state: AppStore): LiveSource[] =>
  state.cache?.lives ?? EMPTY_LIVES;

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
