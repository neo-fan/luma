/**
 * 最近搜索词。
 *
 * 只记用户实际提交过的关键词（不是每次输入），最新在前、最多 10 条，
 * 重复词提到最前而不是再占一格。落在 localStorage，重启后仍在；
 * 存储被禁用 / 内容损坏时一律降级为空列表，绝不影响搜索主链路。
 *
 * 与 usePageState 的区别：那个是「本次运行内的页面快照」，切配置会清空；
 * 搜索历史是用户资产，应该跨配置、跨重启保留。
 */

import { SEARCH_HISTORY_KEY } from "./storageKeys";

export { SEARCH_HISTORY_KEY };
export const MAX_SEARCH_HISTORY = 10;
/** 与搜索日志的截断口径一致，避免一条超长输入占满整行。 */
const MAX_WORD_LENGTH = 60;

function storageOf(storage?: Storage): Storage | null {
  if (storage) {
    return storage;
  }
  try {
    return window.localStorage;
  } catch {
    // 隐私模式 / 沙箱下访问 localStorage 会抛异常。
    return null;
  }
}

function normalizeWord(word: string): string {
  return word.trim().slice(0, MAX_WORD_LENGTH);
}

/** 英文大小写视为同一个词，中文不受影响。 */
function sameWord(a: string, b: string): boolean {
  return a.toLocaleLowerCase() === b.toLocaleLowerCase();
}

/** 清洗外部数据：非数组、非字符串、空词、重复词、超长词、超出 10 条。
 *  数组首位 = 最新，因此超量时保留前 10 条（丢尾部最旧的）。
 */
export function sanitizeSearchHistory(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const word = normalizeWord(item);
    if (!word || out.some((kept) => sameWord(kept, word))) {
      continue;
    }
    out.push(word);
    if (out.length === MAX_SEARCH_HISTORY) {
      break;
    }
  }
  return out;
}

export function readSearchHistory(storage?: Storage): string[] {
  const store = storageOf(storage);
  if (!store) {
    return [];
  }
  try {
    const raw = store.getItem(SEARCH_HISTORY_KEY);
    return raw ? sanitizeSearchHistory(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function persist(history: string[], storage?: Storage): string[] {
  const store = storageOf(storage);
  if (!store) {
    return history;
  }
  try {
    store.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // 配额满 / 被禁用时静默忽略，内存态仍然可用。
  }
  return history;
}

/** 记一次搜索；返回更新后的列表，供页面直接 setState。 */
export function pushSearchHistory(word: string, storage?: Storage): string[] {
  const clean = normalizeWord(word);
  if (!clean) {
    return readSearchHistory(storage);
  }
  const current = readSearchHistory(storage);
  const next = [clean, ...current.filter((item) => !sameWord(item, clean))].slice(
    0,
    MAX_SEARCH_HISTORY,
  );
  return persist(next, storage);
}

export function removeSearchHistory(word: string, storage?: Storage): string[] {
  const clean = normalizeWord(word);
  return persist(
    readSearchHistory(storage).filter((item) => !sameWord(item, clean)),
    storage,
  );
}

export function clearSearchHistory(storage?: Storage): string[] {
  return persist([], storage);
}
