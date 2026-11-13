/**
 * 应用层导航词汇表与 react-router 桥。
 *
 * `View` 是页面之间沟通的业务词汇（页面 props 里的 navigate 只认它），
 * 真正的 history/URL/back-forward 由 react-router（createHashRouter）承担：
 * - detail/player 的路径参数走 URL（siteKey/vodId），
 * - playUrl/liveLines 这类又长又带查询串的参数走 history.state
 *   （不进 URL，避免编码/长度问题）。
 *
 * 页面不直接 import react-router；桥由 AppShell 注册，页面通过
 * props 拿到的 navigate/back 语义与迁移前完全一致。
 */

/** 单窗口内的视图联合类型。 */
export type View =
  | { name: "home" }
  | { name: "search"; /** 从空详情页「全站搜索此片」跳进来时带上片名，落地即搜 */ keyword?: string }
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
      /** 直播频道在源里的全部可播放地址（线路）；多于 1 条时支持手动/自动切换。 */
      liveLines?: string[];
      /** 当前选中的直播线路序号（已记住的上次选择或默认 0）。 */
      liveLine?: number;
      /** 直播线路偏好记忆的源标识（与 LivePage 一致）。 */
      liveSource?: string;
      /** 自动换线记账本的 key（首轮=原片名，跨站跳转透传），缺省用 vodName。 */
      failoverKey?: string;
    }
  | { name: "live" }
  | { name: "favorites" }
  | { name: "history" }
  | { name: "settings" };

/** replace=true 时替换栈顶，用于同页切换剧集，避免返回键回退到上一集。 */
export type Navigate = (view: View, replace?: boolean) => void;

/** detail 路由随 history.state 携带的载荷。 */
export interface DetailNavState {
  title?: string;
}

/** player 路由随 history.state 携带的载荷（大字段不进 URL）。 */
export interface PlayerNavState {
  vodName: string;
  playUrl: string;
  episodeName: string;
  playFrom?: string;
  ua?: string;
  liveLines?: string[];
  liveLine?: number;
  liveSource?: string;
  failoverKey?: string;
}

/** View → react-router 目标（pathname + search + state）。 */
export interface AppLocation {
  pathname: string;
  search: string;
  state: unknown;
}

export function viewToLocation(view: View): AppLocation {
  switch (view.name) {
    case "home":
      return { pathname: "/", search: "", state: null };
    case "live":
      return { pathname: "/live", search: "", state: null };
    case "favorites":
      return { pathname: "/favorites", search: "", state: null };
    case "history":
      return { pathname: "/history", search: "", state: null };
    case "settings":
      return { pathname: "/settings", search: "", state: null };
    case "search": {
      const keyword = (view.keyword ?? "").trim();
      return {
        pathname: "/search",
        search: keyword ? `?q=${encodeURIComponent(keyword)}` : "",
        state: null,
      };
    }
    case "detail":
      return {
        pathname: `/detail/${encodeURIComponent(view.siteKey)}/${encodeURIComponent(view.vodId)}`,
        search: "",
        state: { title: view.title } satisfies DetailNavState,
      };
    case "player": {
      const state: PlayerNavState = {
        vodName: view.vodName,
        playUrl: view.playUrl,
        episodeName: view.episodeName,
        playFrom: view.playFrom,
        ua: view.ua,
        liveLines: view.liveLines,
        liveLine: view.liveLine,
        liveSource: view.liveSource,
        failoverKey: view.failoverKey,
      };
      return {
        pathname: `/player/${encodeURIComponent(view.siteKey)}/${encodeURIComponent(view.vodId)}`,
        search: "",
        state,
      };
    }
  }
}

/**
 * 导航桥：AppShell 挂载后注册真实实现（保存滚动 → router navigate）。
 * 路由包装组件统一走这里，保证所有入口（页面 props / 失败换线自动跳转 /
 * 命令面板）都过同一套滚动保存逻辑。
 */
interface NavImpl {
  navigate: (view: View, replace?: boolean) => void;
  back: () => void;
  /** 清栈跳转（侧栏/命令面板）：等价 router 的 replace 语义。 */
  resetTo: (view: View) => void;
}

let impl: NavImpl | null = null;

export function registerNav(next: NavImpl | null): void {
  impl = next;
}

export function navNavigate(view: View, replace?: boolean): void {
  impl?.navigate(view, replace);
}

export function navBack(): void {
  impl?.back();
}

export function navResetTo(view: View): void {
  impl?.resetTo(view);
}
