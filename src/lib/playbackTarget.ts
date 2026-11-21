import { sameTitle } from "./format";
import type { VodInfo } from "../types/luma";

/**
 * 播放数据单源解析（收藏 / 历史两个入口共用的真相）。
 *
 * 一部剧的「在哪个源、哪条线路、看到第几集、进度、倍速、片头片尾」这件事，权威
 * 记录是**历史行**（它按剧名跨源合并、承载 last-watched 的 siteKey/vodId/线路/进度）。
 * 收藏只是「想看」的书签，记的是当初收藏那个源的 siteKey/vodId——若之后换了源看，
 * 收藏记的源就落后于历史记的源。于是从收藏进、从历史进会落到不同源，线路/进度也对不上。
 *
 * 本模块把「进哪条源」收敛成一个解析：给定入口条目（收藏或历史）+ 历史列表，按剧名
 * （用与收藏同一套 `sameTitle` 规则，跨源容错）找到那条历史记录，导航到**它的**源。
 * 命中不到历史（从没看过）就用条目自身。两个入口走同一函数 → 同一剧无论从哪进都落到
 * 同一份播放数据。
 */
export interface PlayIdentity {
  siteKey: string;
  vodId: string;
  name: string;
}

/** 详情页导航目标（沿用 detail 路由参数形状，可直接喂 `navigate`）。 */
export interface DetailTarget {
  name: "detail";
  siteKey: string;
  vodId: string;
  title: string;
}

/**
 * 返回这部剧当前应使用的历史记录（承载播放数据的那条）；没有就返回条目自身。
 * `entry` 与命中行是同一引用时（从历史页进入）自然回自身，行为不变。
 */
export function resolvePlayRecord<T extends PlayIdentity>(
  entry: T,
  history: readonly PlayIdentity[],
): PlayIdentity {
  const title = (entry.name ?? "").trim();
  if (!title) {
    return entry;
  }
  return history.find((item) => sameTitle(item.name, title)) ?? entry;
}

export function detailTargetFor<T extends PlayIdentity>(
  entry: T,
  history: readonly PlayIdentity[],
): DetailTarget {
  const record = resolvePlayRecord(entry, history);
  return { name: "detail", siteKey: record.siteKey, vodId: record.vodId, title: record.name };
}

/**
 * 收藏 / 历史行 → 详情实体（用于进详情前的一次性数据交接）。
 *
 * 行里本来就有片名、封面、备注，足够让详情页首帧出画面；`vod_id` 用**目标**那条
 * （`resolvePlayRecord` 可能把入口换到另一条源上）。播放串没有，派生不出线路——
 * 那部分仍由详情请求补。
 */
export function vodSeedFromRef(
  ref: { name: string; pic?: string; remarks?: string },
  target: DetailTarget,
): VodInfo {
  return {
    vod_id: target.vodId,
    vod_name: target.title || ref.name,
    vod_pic: ref.pic ?? "",
    vod_remarks: ref.remarks,
    // 收藏/历史行没有播放串：空串 = 「还没有目录」，详情请求到达后补。
    vod_play_from: "",
    vod_play_url: "",
  };
}
