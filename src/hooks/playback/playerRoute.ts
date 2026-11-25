/**
 * `player` 路由的唯一构造点。
 *
 * 播放页有四条出口会产生这条路由：页内换集失败退回整页、换源失败退回整页、
 * 自动换线跳转、跨站换源跳转。它们必须带同一组字段——少一个 `playFrom`，
 * 新页面就不知道线路名、`playerContent` 拿不到 headers；少一个 `failoverKey`，
 * 自动换线的记账本就在跳转后断链、又从头试已经死掉的源。
 *
 * 四条出口各写一份对象字面量时，这类「漏字段」在类型上完全合法（都是可选），
 * 只能靠实测发现。收敛到一个带注释的构造器后，新增字段只需改这里，
 * 每个出口传什么也一目了然。
 */
import type { PlayTarget, View } from "../../lib/nav";
import type { PlaybackTarget } from "./playbackTarget";

export type PlayerRoute = Extract<View, { name: "player" }>;

export interface PlayerRouteInput {
  siteKey: string;
  vodId: string;
  vodName: string;
  playUrl: string;
  episodeName: string;
  /** TVBox 线路名（`vod_play_from`）；空串等价于没有线路。 */
  playFrom?: string;
  /** 自动换线记账本 key：只有跨页自动跳转要透传，页内手动切换不带。 */
  failoverKey?: string;
}

export function playerRoute(input: PlayerRouteInput): PlayerRoute {
  return { name: "player", ...playTarget(input) };
}

/**
 * 从「已落地的播放目标」构造刷新所需的会话身份。
 *
 * 原地切换（换集 / 换源 / 换线）与 fallback 的整页跳转都必须带同一组字段，
 * 否则刷新时 `PlayerPageRoute` 重建出的会话会回落到旧源。这里和 `playerRoute`
 * 共用一份字段映射，新增字段只改一处。
 *
 * - `playUrl` 用 identity.url（原始集地址，非 proxyUrl）：重建后要走
 *   `usePlayResolution` 重新解析，不能把反代地址当会话身份。
 * - `episodeName` 从落地 target 的剧集表取：换源后集表已整体替换，用旧 prop
 *   会把新源的集标成旧名字。
 * - `failoverKey` 不携带：原地切换与 fallback 都不透传，账本按新 vodName 记。
 */
export interface PlayTargetInput extends PlayerRouteInput {}

export function playTarget(input: PlayerRouteInput): PlayTarget {
  const { siteKey, vodId, vodName, playUrl, episodeName, playFrom, failoverKey } = input;
  return {
    siteKey,
    vodId,
    vodName,
    playUrl,
    episodeName,
    ...(playFrom ? { playFrom } : {}),
    ...(failoverKey ? { failoverKey } : {}),
  };
}

/** 从切换落地结果直接生成刷新载荷：所有原地切换的路由同步只走这里。 */
export function playTargetFromSwitch(
  target: PlaybackTarget,
  playUrl: string,
  playFrom: string,
): PlayTarget {
  return playTarget({
    siteKey: target.siteKey,
    vodId: target.vodId,
    vodName: target.vodName,
    playUrl,
    episodeName: target.lines[target.lineIndex]?.episodes[target.episodeIndex]?.name ?? "",
    playFrom,
  });
}
