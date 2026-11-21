/**
 * 线路健康记录：哪些线路最近解不开、哪些能播。
 *
 * 用途是避开已知解不开的线路，省掉每次先等一次 `playerContent` 超时（8s）再换线
 * 的开销，连续换集时最明显。
 *
 * 规则：
 * - 只有源**明确拒绝**（token 原样回吐 / 空串）才打「坏」标记，30 分钟有效，
 *   期间跳过 `playerContent`；超时、连接重置、脚本报错都不写标记。
 * - 成功解开的线路打「好」标记，换线时优先探它。
 * - 好标记比坏标记新时，坏标记失效：成功一次即恢复信任。
 *
 * 纯逻辑 + localStorage，存储可注入，便于在 node 下单测。
 */

import { LINE_HEALTH_KEY } from "./storageKeys";

const STORAGE_KEY = LINE_HEALTH_KEY;

/** 坏标记有效期：半个小时后重新给源侧机会（很多源过一会儿就恢复了）。 */
export const BAD_TTL_MS = 30 * 60 * 1000;

interface LineEntry {
  /** 最近一次成功解码的时间戳。 */
  good?: number;
  /** 最近一次「解不解」的时间戳。 */
  bad?: number;
  /**
   * 坏标记的成因，目前只有 `rejected`（源明确拒绝：token 原样回吐 / 空串）。
   *
   * 缺这个字段的记录按无效处理：只有「源说不播」能封线路 30 分钟，一次调用
   * 异常不能。
   */
  badReason?: "rejected";
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

/**
 * 这条线路刚被**明确判定**解不开（token 原样回吐 / 返回空串）。
 *
 * 只允许「源给出了确定结论」的调用点写它。调用抛异常（超时、连接重置、脚本
 * 报错）不构成拒绝——那种情况不写标记，交给下一次重试。
 */
export function markLineBad(siteKey: string, line: string, now = Date.now()): void {
  if (!siteKey || !line) {
    return;
  }
  const store = storage();
  const data = read(store);
  data[key(siteKey, line)] = {
    ...data[key(siteKey, line)],
    bad: now,
    badReason: "rejected",
  };
  write(data, store);
}

/**
 * 是否处于「坏」状态：坏标记在有效期内、成因是明确拒绝，且比上一次成功更新。
 *
 * 成功一次就重新信任该线路——播放器最怕的是「明明能播却因为一次失败被永久跳过」。
 */
export function isLineBad(
  siteKey: string,
  line: string,
  now = Date.now(),
  ttlMs = BAD_TTL_MS,
): boolean {
  const entry = read()[key(siteKey, line)];
  if (!entry?.bad || entry.badReason !== "rejected") {
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
