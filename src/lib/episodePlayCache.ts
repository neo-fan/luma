/**
 * 按集播放解析缓存（进程级单例，跨播放页重挂载存活）。
 *
 * 换集 / 换线路 / 换源有三条重复解析链：
 * 1. 同一集反复点击，每次都重跑 playerContent → resolve_play（慢源 3~18s）；
 * 2. probeCandidate 探活已经把整条链解析过一遍，navigate 重挂载后新页面
 *    又从零解析同一个地址；
 * 3. 看完自动接下一集时，下一集往往刚被预解析过，却还要再等一轮。
 *
 * 这里把「解析完成的 PlayResolved」按集缓存 3 分钟：直链与反代地址短期内
 * 稳定，命中即跳过整条解析链。播放 fatal（hls fatal / 解码失败 / 看门狗判死）
 * 时由调用方 invalidate 对应 key——坏地址绝不能被缓存住；用户点刷新同样
 * 绕过（reload 时 invalidate）。
 *
 * 纯内存模块，不依赖 IPC / DOM，`now` 可注入，便于 node 下单测。
 */
import type { PlayResolved } from "../types/luma";

/** 解析结论的有效期：源站直链 / token 大多分钟级有效，3 分钟是保守值。 */
export const EPISODE_PLAY_TTL_MS = 3 * 60_000;
/** 容量上限：一次连看几十集 + 换线探活预热，64 条足够覆盖最近的操作窗口。 */
export const EPISODE_PLAY_CACHE_MAX = 64;

interface EpisodePlayEntry {
  resolved: PlayResolved;
  storedAt: number;
}

/** Map 的插入序即 FIFO 序；重复 set 先 delete 再插，刷新到队尾。 */
const entries = new Map<string, EpisodePlayEntry>();

/**
 * key 必须带线路名：同一集在不同线路下是不同的 token / 直链，
 * 只按 siteKey+episodeUrl 缓存会把 A 线路的地址错给 B 线路。
 */
function key(siteKey: string, playFrom: string | undefined, episodeUrl: string): string {
  return `${siteKey}|${playFrom ?? ""}|${episodeUrl}`;
}

/** 命中且未过期才返回；过期顺手清掉，不留僵尸条目。 */
export function getEpisodePlayCache(
  siteKey: string,
  playFrom: string | undefined,
  episodeUrl: string,
  now = Date.now(),
): PlayResolved | null {
  const hit = entries.get(key(siteKey, playFrom, episodeUrl));
  if (!hit) {
    return null;
  }
  if (now - hit.storedAt > EPISODE_PLAY_TTL_MS) {
    entries.delete(key(siteKey, playFrom, episodeUrl));
    return null;
  }
  return hit.resolved;
}

export function setEpisodePlayCache(
  siteKey: string,
  playFrom: string | undefined,
  episodeUrl: string,
  resolved: PlayResolved,
  now = Date.now(),
): void {
  if (!episodeUrl) {
    return;
  }
  // 只缓存内置播放器能解码的 kind（与 usePlayerEngine.BUILTIN_KINDS 同口径；
  // 不 import 它——那会把整个播放内核拖进这个纯模块）。page/share 是「要交给
  // 解析池 / 外部」的结论，缓存住会让后续重试直接命中「不可播」，失去自愈机会。
  if (!["hls", "flv", "file"].includes(resolved.kind)) {
    return;
  }
  const k = key(siteKey, playFrom, episodeUrl);
  entries.delete(k);
  entries.set(k, { resolved, storedAt: now });
  while (entries.size > EPISODE_PLAY_CACHE_MAX) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    entries.delete(oldest);
  }
}

/** 播放 fatal / 用户刷新时作废对应集：坏地址不允许被下一轮命中。 */
export function invalidateEpisodePlayCache(
  siteKey: string,
  playFrom: string | undefined,
  episodeUrl: string,
): void {
  entries.delete(key(siteKey, playFrom, episodeUrl));
}

/** 清空（单测隔离用）。 */
export function clearEpisodePlayCache(): void {
  entries.clear();
}