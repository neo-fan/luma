/**
 * 长列表与页面快照的保留上限。
 *
 * 搜索结果与首页分类是 renderer 里最容易无限增长的两类数据：前者一次聚合
 * 可回几百到几千条，后者无限滚动会一直追加。这里把「截断 + 是否截断」和
 * 「按最近使用保留 N 份快照」做成纯函数，页面只负责调用，便于单测钉口径。
 */

export interface CappedList<T> {
  /** 允许保留的条目（原数组的浅拷贝，不共享引用）。 */
  items: T[];
  /** 原始条目数超过上限。统计仍按原始结果算，不受显示截断影响。 */
  truncated: boolean;
  /** 截断前的条目总数。 */
  total: number;
}

/** 保留前 `limit` 条；`limit <= 0` 视为不保留。 */
export function capItems<T>(items: readonly T[], limit: number): CappedList<T> {
  const total = items.length;
  if (limit <= 0) {
    return { items: [], truncated: total > 0, total };
  }
  if (total <= limit) {
    return { items: [...items], truncated: false, total };
  }
  return { items: items.slice(0, limit), truncated: true, total };
}

/** 把「已加载页数」夹到合法区间；非法输入回落到第 1 页。 */
export function clampLoadedPages(page: number, maxPages: number): number {
  if (!Number.isFinite(page) || page < 1) {
    return 1;
  }
  const ceiling = Number.isFinite(maxPages) && maxPages >= 1 ? Math.floor(maxPages) : 1;
  return Math.min(Math.floor(page), ceiling);
}

/** 最近使用优先的页面快照表：order[0] 最新，超出上限的尾巴直接丢弃。 */
export interface LruStore<T> {
  values: Record<string, T>;
  order: string[];
}

/** 写入一份快照并提到队首；超限时淘汰最久未用的条目。 */
export function putLru<T>(
  store: LruStore<T>,
  key: string,
  value: T,
  max: number,
): LruStore<T> {
  if (max <= 0) {
    return { values: {}, order: [] };
  }
  const values: Record<string, T> = { ...store.values, [key]: value };
  const order = [key, ...store.order.filter((item) => item !== key)];
  while (order.length > max) {
    const oldest = order.pop();
    if (oldest !== undefined) {
      delete values[oldest];
    }
  }
  return { values, order };
}

/** 删除一份快照；不存在时返回互不相同的空壳，避免无谓写回。 */
export function dropLru<T>(store: LruStore<T>, key: string): LruStore<T> {
  if (!(key in store.values) && !store.order.includes(key)) {
    return store;
  }
  const values: Record<string, T> = { ...store.values };
  delete values[key];
  return { values, order: store.order.filter((item) => item !== key) };
}
