/**
 * 应用层导航词汇表与 react-router 桥。
 *
 * `View` 是页面之间沟通的业务词汇（页面 props 里的 navigate 只认它），
 * 真正的 history/URL/back-forward 由 react-router（createHashRouter）承担：
 * - detail/player 的路径参数走 URL（siteKey/vodId），
 * - playUrl 这类又长又带查询串的参数走 history.state
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
  | ({ name: "player" } & PlayTarget)
  | { name: "live" }
  | { name: "favorites" }
  | { name: "history" }
  | { name: "settings" };

/**
 * 一次播放会话的身份（路由 / 导航载荷 / 常驻播放器共用一份定义）。
 *
 * 路由 / 导航载荷 / 常驻播放器共用这一份定义：`PlayerNavState` 与 `PlaySession` 都是
 * 它的别名，加字段只改这里。三处各写一遍的话，加一个 `failoverKey` 要改三处，漏一处
 * 就丢字段。
 */
export interface PlayTarget {
  siteKey: string;
  vodId: string;
  vodName: string;
  playUrl: string;
  episodeName: string;
  /** TVBox 线路名（vod_play_from），playerContent 的第一个参数。 */
  playFrom?: string;
  /** 自动换线记账本的 key（首轮=原片名，跨站跳转透传），缺省用 vodName。 */
  failoverKey?: string;
}

/** replace=true 时替换栈顶，用于同页切换剧集，避免返回键回退到上一集。 */
export type Navigate = (view: View, replace?: boolean) => void;

/** detail 路由随 history.state 携带的载荷。 */
export interface DetailNavState {
  title?: string;
}

/** player 路由随 history.state 携带的载荷（大字段不进 URL）。 */
export type PlayerNavState = PlayTarget;

/** 从 `View.player` 取出会话身份（去掉 `name`），单一映射点。 */
export function toPlayTarget(view: { name: "player" } & PlayTarget): PlayTarget {
  const { siteKey, vodId, vodName, playUrl, episodeName, playFrom, failoverKey } = view;
  return { siteKey, vodId, vodName, playUrl, episodeName, playFrom, failoverKey };
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
      return {
        pathname: `/player/${encodeURIComponent(view.siteKey)}/${encodeURIComponent(view.vodId)}`,
        search: "",
        state: toPlayTarget(view),
      };
    }
  }
}

/**
 * 原地换集 / 换源 / 换线落地后，刷新要能重建到**新**会话，所以当前历史条目的
 * URL 与 state 必须跟上真源。但这里只能 `replaceState`，不能 `navigate`：
 * 后者会让 `PlayerPageRoute` 重跑 → `openPlaySession` → `PlayerHost` 的 key 变化
 * → 整页重挂载 = 黑屏重播，恰好毁掉「原地切流」的意义。
 *
 * 只改 `usr`（router 刷新时从这里读 state）与 hash 路径；`key` / `idx` 原样保留，
 * 于是栈深与前进后退语义不变，下一次正常 navigate 仍接着当前条目往下压。
 *
 * `playTargetHistoryPatch` 是纯函数，测试直接钉它的输出；`replacePlayTarget`
 * 只负责把输出交给 `window.history`，在 SSR / 无 window 下静默跳过。
 */
export function playTargetHistoryPatch(
  target: PlayTarget,
  currentState: unknown,
): { state: Record<string, unknown>; url: string } {
  const loc = viewToLocation({ name: "player", ...target });
  const base =
    currentState && typeof currentState === "object"
      ? (currentState as Record<string, unknown>)
      : {};
  return {
    state: { ...base, usr: loc.state },
    url: `#${loc.pathname}${loc.search}`,
  };
}

export function replacePlayTarget(target: PlayTarget): void {
  if (typeof window === "undefined") {
    return;
  }
  const patch = playTargetHistoryPatch(target, window.history.state);
  window.history.replaceState(patch.state, "", patch.url);
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

