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
import type { View } from "../../lib/nav";

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
  const { siteKey, vodId, vodName, playUrl, episodeName, playFrom, failoverKey } = input;
  return {
    name: "player",
    siteKey,
    vodId,
    vodName,
    playUrl,
    episodeName,
    ...(playFrom ? { playFrom } : {}),
    ...(failoverKey ? { failoverKey } : {}),
  };
}
