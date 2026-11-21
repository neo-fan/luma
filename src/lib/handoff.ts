/**
 * 一跳数据交接：上一页把「已经握在手里」的实体交给下一页，落地首帧直接渲染，
 * 网络只负责补差。
 *
 * 为什么不用 `history.state`：它的职责是「刷新 / 深链还能重开」，只该放重建所需
 * 的最小身份；整份详情塞进去既不参与恢复，又要担心体积与序列化。
 * 为什么不用数据缓存：缓存回答的是「回到同一页还能不能复用」，用它当页面间总线，
 * 等于让跳转依赖「缓存里恰好有什么」——缓存过期或被 scope 清掉，链路就退化成
 * 网络等待（详情页空屏、播放页面板晚到，都是这个形状）。
 *
 * 三条约束（都是踩过的）：
 * 1. **只能 peek，不能在 `useState` 初始化器里消费**：dev StrictMode 会把初始化器
 *    跑两次，消费式读取第二次就是空（`DetailPage` 的 `pendingRecoveryNotice` 踩过）。
 *    清除放在 `useEffect` 里。
 * 2. 每种一跳只保留最后一份：导航是线性的，更早那份只会是脏数据。另有保质期，
 *    隔了几分钟再回来时按「没有」处理，避免复活过时的东西。
 * 3. 载荷是**实体本身**（`VodInfo`），派生数据（线路、集定位）由消费方用既有纯
 *    函数算（`seedFromCachedDetail`），不在交接层复制一份派生结果。
 */
import type { VodInfo } from "../types/luma";

/** 一次跳转的类型。新增一跳：这里加一项 + 下面 `HandoffPayload` 加一项。 */
export type HandoffKind = "detail" | "play";

/** 各类跳转携带的载荷（当前都是详情实体，将来可以是别的形状）。 */
interface HandoffPayload {
  detail: VodInfo;
  play: VodInfo;
}

/** 交接只在「点击 → 落地」这几百毫秒内有效，超过就当作没有。 */
const MAX_AGE_MS = 2 * 60_000;

interface Slot {
  key: string;
  vod: VodInfo;
  at: number;
}

const slots = new Map<HandoffKind, Slot>();

/** 身份 key：末尾多带一段（如播放地址）时，换集不会被当成同一次交接。 */
function keyOf(...parts: string[]): string {
  return parts.join("|");
}

export function putHandoff<K extends HandoffKind>(
  kind: K,
  key: string,
  vod: HandoffPayload[K],
): void {
  slots.set(kind, { key, vod, at: Date.now() });
}

/** 只读不消费：StrictMode 双跑初始化器时两次都能拿到同一份。 */
export function peekHandoff<K extends HandoffKind>(
  kind: K,
  key: string,
): HandoffPayload[K] | null {
  const slot = slots.get(kind);
  if (!slot || slot.key !== key) {
    return null;
  }
  if (Date.now() - slot.at > MAX_AGE_MS) {
    slots.delete(kind);
    return null;
  }
  return slot.vod;
}

/** 落地页在 effect 里清；`key` 省略时无条件清掉该类。 */
export function clearHandoff(kind: HandoffKind, key?: string): void {
  if (key === undefined || slots.get(kind)?.key === key) {
    slots.delete(kind);
  }
}

/** 配置切换 / 会话重建时整体清空（与其它缓存同一个清场点）。 */
export function clearAllHandoffs(): void {
  slots.clear();
}

/* ---- 当前在用的两跳（key 由身份字段统一拼，调用方不会拼错） ---- */

export function putDetailSeed(siteKey: string, vod: VodInfo): void {
  putHandoff("detail", keyOf(siteKey, vod.vod_id), vod);
}

export function peekDetailSeed(siteKey: string, vodId: string): VodInfo | null {
  return peekHandoff("detail", keyOf(siteKey, vodId));
}

/** 落地页在 effect 里清；按 key 清，避免把隔壁那次导航刚写入的交接一起清掉。 */
export function clearDetailSeed(siteKey: string, vodId: string): void {
  clearHandoff("detail", keyOf(siteKey, vodId));
}

export function putPlaySeed(siteKey: string, vod: VodInfo, playUrl: string): void {
  putHandoff("play", keyOf(siteKey, vod.vod_id, playUrl), vod);
}

export function peekPlaySeed(siteKey: string, vodId: string, playUrl: string): VodInfo | null {
  return peekHandoff("play", keyOf(siteKey, vodId, playUrl));
}

export function clearPlaySeed(siteKey: string, vodId: string, playUrl: string): void {
  clearHandoff("play", keyOf(siteKey, vodId, playUrl));
}
