/**
 * 长剧集的分段。
 *
 * 200+ 集的合集平铺成一整片格子，想找「第 180 集」只能盲滚；按固定集数切段、
 * 只展开一段，单屏内就能从段头直达目标区间。分段只决定「哪些格子同屏」，
 * 每格的 `index` 仍是原始剧集数组里的位置。
 */

/** 每段集数。一屏大约铺 40 格，50 是一屏多一点，选中一段基本不用二次滚动。 */
export const EPISODE_GROUP_SIZE = 50;

export interface EpisodeGroup<T> {
  /** 段的稳定标识，取首末集号，倒序/筛选后仍唯一。 */
  key: string;
  /** 段首末集在原始剧集表中的集号（1 起）。倒序展示时仍按由小到大描述。 */
  first: number;
  last: number;
  /** 段标题：「第 12 集」/「第 1–50 集」。 */
  label: string;
  /** 按展示顺序切出来的条目。 */
  items: T[];
}

/**
 * 把展示序列切成连续段。
 *
 * 传入的是**已经过滤、排好序**的列表：段内顺序即展示顺序，段标题按原始集号
 * 取区间，所以倒序时第一段是「第 172–221 集」而不是「第 1–50 集」。
 */
export function groupEpisodes<T extends { index: number }>(
  visible: T[],
  size: number = EPISODE_GROUP_SIZE,
): EpisodeGroup<T>[] {
  const step = Math.max(1, Math.floor(size));
  const groups: EpisodeGroup<T>[] = [];
  for (let offset = 0; offset < visible.length; offset += step) {
    const items = visible.slice(offset, offset + step);
    const first = Math.min(...items.map((item) => item.index + 1));
    const last = Math.max(...items.map((item) => item.index + 1));
    groups.push({
      key: `${first}-${last}`,
      first,
      last,
      label: first === last ? `第 ${first} 集` : `第 ${first}–${last} 集`,
      items,
    });
  }
  return groups;
}
