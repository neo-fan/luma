/**
 * 播放目标的**单一真源**：只有一份 `PlaybackTarget`，两个槽位——
 * - `committed`：已经真正落到画面上的目标（历史、收藏、导航基线都以它为准）；
 * - `intent`：用户最新一次选择、还没落地的目标（乐观显示）。
 *
 * **显示恒为 `intent ?? committed`**，没有第三层覆盖。换集 / 换源 / 换线都只是
 * 「产生一个新的 intent」，落地时整体替换 committed——线路索引本身就是 target
 * 的字段，选集面板因此天然跟随，不需要事后打补丁。
 *
 * 面板的线路高亮也走这条原则：它是**从 target 派生**的，而非另一个独立 state
 * （见 `resolvePanelLine`）。
 *
 * 真源必须收成一份 reducer 状态，而不是「当前播哪一集」散在路由参数 / 组件索引 /
 * 手动选中 / 换源结果多处各自覆盖——分散时显示只能靠优先级链缝合，每加一个异步
 * 动作都要再叠一层「谁覆盖谁」，竞争点随功能数量组合爆炸。
 */
import type { PlayLine } from "../../lib/format";

export interface PlaybackTarget {
  siteKey: string;
  siteName: string;
  vodId: string;
  vodName: string;
  /** 该源当前的完整剧集表。换集不变；换源整体替换。 */
  lines: PlayLine[];
  lineIndex: number;
  episodeIndex: number;
}

export interface PlaybackState {
  /** 已落地：唯一可以写历史 / 收藏 / 作为「下一集」基线的目标。 */
  committed: PlaybackTarget;
  /** 用户最新意图：乐观显示；落地或作废后回到 null。 */
  intent: PlaybackTarget | null;
}

export type PlaybackAction =
  /** 详情到达：只更新当前源（committed）的剧集表并钳制索引；跨源 intent 不受影响。 */
  | { type: "catalog"; lines: PlayLine[] }
  /** 用户选择：立即乐观显示。 */
  | { type: "intent"; target: PlaybackTarget }
  /** 落地：整体替换 committed 并清掉 intent。 */
  | { type: "commit"; target: PlaybackTarget }
  /** 作废乐观意图（换源发起、路由接管）。 */
  | { type: "cancel" }
  /** 路由身份变化：重建 committed。 */
  | { type: "reset"; target: PlaybackTarget };

/** 显示真源：乐观意图优先，否则已落地。 */
export function displayTarget(state: PlaybackState): PlaybackTarget {
  return state.intent ?? state.committed;
}

/**
 * 选集面板的「浏览态」：用户点了线路 chip，只想看那条线路的剧集表，不动播放。
 *
 * 它**不是第二份真源**，只是一个相对播放目标的覆盖，并带上发起时的目标线路
 * 作为锚（`anchor`）。播放目标线路一变（换线 / 换集跨线 / 换源 / 目录重建），
 * 锚就对不上，覆盖自动失效。
 *
 * 这样「面板必须跟着播放线路走」不需要任何 effect、也不需要四处在切换动作里
 * 补 `setPanelLine(...)`——谁改了播放目标，面板自己就跟过去。
 */
export interface PanelBrowse {
  /** 用户正在浏览的线路索引。 */
  line: number;
  /** 发起浏览时播放目标所在的线路；与当前目标不一致即视为过期。 */
  anchor: number;
}

/**
 * 面板当前显示的线路：有效浏览覆盖优先，否则跟随播放目标。
 *
 * 有效期判定纯靠锚对比，没有时钟、没有 effect：
 * - 无浏览 / 锚过期（目标线路已换）→ 跟随 `target.lineIndex`；
 * - 浏览到播放线路本身 / 越界（换源后剧集表变短）→ 同样跟随目标。
 */
export function resolvePanelLine(
  browse: PanelBrowse | null,
  target: PlaybackTarget,
): number {
  if (!browse || browse.anchor !== target.lineIndex) {
    return target.lineIndex;
  }
  if (browse.line === target.lineIndex || !target.lines[browse.line]) {
    return target.lineIndex;
  }
  return browse.line;
}

/** 索引钳制到合法范围：lines / episodes 异步到达或换源后长度变化都靠它收口。 */
export function clampTarget(target: PlaybackTarget): PlaybackTarget {
  if (target.lines.length === 0) {
    if (target.lineIndex === 0 && target.episodeIndex === 0) {
      return target;
    }
    return { ...target, lineIndex: 0, episodeIndex: 0 };
  }
  const lineIndex = Math.min(Math.max(target.lineIndex, 0), target.lines.length - 1);
  const episodes = target.lines[lineIndex]?.episodes ?? [];
  const episodeIndex =
    episodes.length === 0
      ? 0
      : Math.min(Math.max(target.episodeIndex, 0), episodes.length - 1);
  if (lineIndex === target.lineIndex && episodeIndex === target.episodeIndex) {
    return target;
  }
  return { ...target, lineIndex, episodeIndex };
}

export function playbackReducer(
  state: PlaybackState,
  action: PlaybackAction,
): PlaybackState {
  switch (action.type) {
    case "catalog": {
      const committed = clampTarget({ ...state.committed, lines: action.lines });
      // 只有「同一个源」的 intent 才该跟着换剧集表；换源在途的 intent 属于别的
      // 站点，它的 lines 由换源自己写入，不能被当前源的目录覆盖。
      const intent =
        state.intent &&
        state.intent.siteKey === state.committed.siteKey &&
        state.intent.vodId === state.committed.vodId
          ? clampTarget({ ...state.intent, lines: action.lines })
          : state.intent;
      return { committed, intent };
    }
    case "intent":
      return { ...state, intent: action.target };
    case "commit":
      return { committed: action.target, intent: null };
    case "cancel":
      return state.intent ? { ...state, intent: null } : state;
    case "reset":
      return { committed: action.target, intent: null };
    default:
      return state;
  }
}
