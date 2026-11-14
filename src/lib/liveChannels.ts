/**
 * 直播频道目录的跨页共享。
 *
 * 直播列表由 `LivePage` 拉取（一份 m3u 常有几千行、几百个频道），播放页在
 * 左侧也要展示「同一份频道列表」——如果每进一次播放页就重新 `live_parse`，
 * 一次请求几百 KB 加上解析，切频道会明显变慢。
 *
 * 所以这里做三件事：
 *   1. **进程内缓存**频道分组：`LivePage` 解析成功后 prime，播放页直接读；
 *   2. **in-flight 去重**：播放页在列表还没到时并发请求同一源，只发一次；
 *   3. **源地址记忆**（localStorage）：直接刷新/从历史进播放页时 pageState 已空，
 *      靠记住的 url+ua 重新拉一次，而不是留一个空的空侧栏。
 *
 * `expandChannels` / `normalizeGroups` 也放这里：容器型源（只有 channels 没有
 * url）的展开规则只能有一份，两个页面各写一遍必然漂移。
 */
import { api } from "./invoke";
import type { LiveChannel, LiveGroup, LiveSource } from "../types/tvbox";

/** 源的稳定标识：有 url 用 url，容器型源退回索引（与 LivePage 一致）。 */
export function liveSourceKey(source: LiveSource, index: number): string {
  return source.url || `container:${index}`;
}

/** 分组容器型源（只有 `channels`，没有 `url`）直接展开，无需请求网络。 */
export function expandChannels(source: LiveSource): LiveGroup[] {
  const channels = (source.channels ?? [])
    .map((channel) => {
      // 容器源的 urls 本身就是多线路；同一频道不再拍平成多个 chip。
      const lines = Array.from(
        new Set((channel.urls ?? []).filter((url) => /^https?:\/\//i.test(url))),
      );
      if (lines.length === 0) {
        return null;
      }
      return { name: channel.name || lines[0], url: lines[0], lines };
    })
    .filter((channel): channel is LiveChannel => channel !== null);
  if (channels.length === 0) {
    return [];
  }
  return [{ name: source.group || source.name || "未分组", channels }];
}

/** 确保每条频道都带 `lines`：后端发 `urls`，前端按线路处理前归一化一次。 */
export function normalizeGroups(groups: LiveGroup[]): LiveGroup[] {
  return groups.map((group) => ({
    ...group,
    channels: group.channels.map((channel) => {
      const lines = channel.lines?.length
        ? channel.lines
        : Array.from(new Set((channel.urls ?? []).filter(Boolean)));
      const resolved = lines.length > 0 ? lines : [channel.url];
      return { ...channel, lines: resolved, url: resolved[0] };
    }),
  }));
}

/** 有列表地址，或能从分组容器里展开出至少一个可播放频道。 */
export function isListableSource(source: LiveSource): boolean {
  if (source.url) {
    return true;
  }
  return expandChannels(source).length > 0;
}

const SOURCES_KEY = "luma:live:sources:v1";

interface SourceMemo {
  url: string;
  ua?: string;
  name?: string;
}

const groups = new Map<string, LiveGroup[]>();
const inflight = new Map<string, Promise<LiveGroup[]>>();

function readMemos(): Record<string, SourceMemo> {
  try {
    const raw = window.localStorage.getItem(SOURCES_KEY);
    return raw ? (JSON.parse(raw) as Record<string, SourceMemo>) : {};
  } catch {
    return {};
  }
}

/** 记住「这个 sourceKey 对应哪个 url/ua」，播放页独立打开时靠它自取列表。 */
export function rememberLiveSource(sourceKey: string, source: LiveSource): void {
  if (!source.url) {
    return;
  }
  const memos = readMemos();
  memos[sourceKey] = { url: source.url, ua: source.ua, name: source.name };
  try {
    window.localStorage.setItem(SOURCES_KEY, JSON.stringify(memos));
  } catch {
    /* 写入失败只影响「刷新后能否自取列表」，不影响本次播放。 */
  }
}

export function readLiveSource(sourceKey: string): SourceMemo | null {
  const memo = readMemos()[sourceKey];
  return memo && memo.url ? memo : null;
}

/** 列表已在内存里就不要重复下载；切源/重新导入时由 clearLiveGroups 清空。 */
export function primeLiveGroups(sourceKey: string, next: LiveGroup[]): void {
  if (!sourceKey) {
    return;
  }
  groups.set(sourceKey, next);
}

export function peekLiveGroups(sourceKey: string): LiveGroup[] | null {
  const hit = groups.get(sourceKey);
  return hit && hit.length > 0 ? hit : null;
}

/** 供播放页侧栏使用：命中缓存、展开容器，或按记住的地址重新拉一次。 */
export async function loadLiveGroups(sourceKey: string): Promise<LiveGroup[]> {
  const hit = peekLiveGroups(sourceKey);
  if (hit) {
    return hit;
  }
  const pending = inflight.get(sourceKey);
  if (pending) {
    return pending;
  }
  const memo = readLiveSource(sourceKey);
  if (!memo) {
    throw new Error("找不到该直播源的地址，请回到直播页重新选择频道");
  }
  const task = (async () => {
    const result = await api.liveParse(memo.url, memo.ua, false);
    const next = normalizeGroups(result.groups ?? []);
    primeLiveGroups(sourceKey, next);
    return next;
  })().finally(() => {
    inflight.delete(sourceKey);
  });
  inflight.set(sourceKey, task);
  return task;
}

/** 切换 active 配置后旧源的频道列表不再适用。 */
export function clearLiveGroups(): void {
  groups.clear();
  inflight.clear();
}
