/**
 * 线路健康记录：记住哪些线路最近解不开、哪些能播。
 *
 * 起因是实测「布布追剧 → 走马上任」：`zijianm3u8` 线路的 token 源侧今天解不开，
 * 每次点它都要先干等一次 `playerContent` 超时（8 秒）再换线；而第 3 集自动接
 * 第 4 集时又会重来一遍。连看 30 集就是 30 次无谓等待。
 *
 * 这里用一个很轻的本地记录：
 * - 解不开的线路打「坏」标记（30 分钟有效），期间直接跳过 `playerContent`；
 * - 成功解开的线路打「好」标记，换线时优先探它（老线路常常最稳）；
 * - 打过好标记的线路不会因为后来的偶发失败被立刻判死（坏标记只影响排序与
 *   跳过，成功一次就恢复）。
 *
 * 纯逻辑 + localStorage，存储可注入，便于在 node 下单测。
 */

const STORAGE_KEY = "luma:line:health:v1";

/** 坏标记有效期：半个小时后重新给源侧机会（很多源过一会儿就恢复了）。 */
export const BAD_TTL_MS = 30 * 60 * 1000;

interface LineEntry {
  /** 最近一次成功解码的时间戳。 */
  good?: number;
  /** 最近一次「解不解」的时间戳。 */
  bad?: number;
}

type LineData = Record<string, LineEntry>;

/** 排序用：越小越优先。 */
export const LINE_RANK_GOOD = 0;
export const LINE_RANK_UNKNOWN = 1;
export const LINE_RANK_BAD = 2;

function key(siteKey: string, line: string): string {
  return `${siteKey}\u0001${line}`;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") {
      return null;
    }
    return localStorage;
  } catch {
    return null;
  }
}

function read(store: Storage | null = storage()): LineData {
  if (!store) {
    return {};
  }
  try {
    const raw = store.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as LineData) : {};
  } catch {
    return {};
  }
}

function write(data: LineData, store: Storage | null = storage()): void {
  if (!store) {
    return;
  }
  try {
    // 只保留最近 200 条，避免无限增长。
    const entries = Object.entries(data).slice(-200);
    store.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 存储写满 / 被禁用：健康记录丢了不影响播放。
  }
}

/** 这条线路刚成功解码出地址。 */
export function markLineGood(siteKey: string, line: string, now = Date.now()): void {
  if (!siteKey || !line) {
    return;
  }
  const store = storage();
  const data = read(store);
  data[key(siteKey, line)] = { ...data[key(siteKey, line)], good: now, bad: undefined };
  write(data, store);
}

/** 这条线路刚被判定解不开（token 原样回吐 / 解码超时）。 */
export function markLineBad(siteKey: string, line: string, now = Date.now()): void {
  if (!siteKey || !line) {
    return;
  }
  const store = storage();
  const data = read(store);
  data[key(siteKey, line)] = { ...data[key(siteKey, line)], bad: now };
  write(data, store);
}

/**
 * 是否处于「坏」状态：坏标记在有效期内，且比上一次成功更新。
 *
 * 成功一次就重新信任该线路——播放器最怕的是「明明能播却因为一次超时被永久
 * 跳过」。
 */
export function isLineBad(
  siteKey: string,
  line: string,
  now = Date.now(),
  ttlMs = BAD_TTL_MS,
): boolean {
  const entry = read()[key(siteKey, line)];
  if (!entry?.bad) {
    return false;
  }
  if (entry.good && entry.good >= entry.bad) {
    return false;
  }
  return now - entry.bad < ttlMs;
}

/** 换线排序用：好线路优先，坏线路排到最后。 */
export function lineRank(siteKey: string, line: string, now = Date.now()): number {
  const entry = read()[key(siteKey, line)];
  if (isLineBad(siteKey, line, now)) {
    return LINE_RANK_BAD;
  }
  if (entry?.good && (!entry.bad || entry.good >= entry.bad)) {
    return LINE_RANK_GOOD;
  }
  return LINE_RANK_UNKNOWN;
}

/** 清空（测试 / 重新导入配置时用）。 */
export function resetLineHealth(): void {
  storage()?.removeItem(STORAGE_KEY);
}
