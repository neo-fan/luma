/**
 * 播放页首帧的剧集定位与「缓存直出」种子（纯函数，便于单测）。
 *
 * 为什么单独抽出来：换集会重挂载整页（播放实例必须重建），若首帧拿不到
 * 详情，播放器下方的信息卡会先闪成「无封面 / 无简介」、选集面板整个消失，
 * 等 `detailContent` 回来再长出来——用户看到的就是「点下一集，底下全刷新了」。
 * 详情本来就在 `数据缓存` 里（10 分钟 TTL、零 IPC），所以首帧可以同步取到：
 * 本模块只做「从缓存值算出 lines + 当前线路/集」，不碰 React 也不发请求。
 */
import { parsePlayLines } from "./format";
import type { PlayLine } from "./format";
import type { VodInfo } from "../types/luma";

export interface EpisodeLocus {
  line: number;
  episode: number;
}

export interface EpisodeSeed {
  vod: VodInfo | null;
  lines: PlayLine[];
  locus: EpisodeLocus;
}

/**
 * 按地址精确定位当前线路/集；地址对不上（源轮换了 CDN，很常见）再按
 * 「同线路名 + 同集名」兜底，线路名优先取路由里的 playFrom（用户点的那条）。
 * 都找不到就回到第 1 集第 1 条线路——与旧实现的兜底一致。
 */
export function locateEpisode(
  lines: readonly PlayLine[],
  playUrl: string,
  episodeName = "",
  playFrom = "",
): EpisodeLocus {
  for (let line = 0; line < lines.length; line += 1) {
    const index = lines[line].episodes.findIndex((item) => item.url === playUrl);
    if (index >= 0) {
      return { line, episode: index };
    }
  }
  if (episodeName) {
    const preferred = playFrom ? lines.findIndex((item) => item.name === playFrom) : -1;
    const order =
      preferred >= 0
        ? [preferred, ...lines.map((_, i) => i).filter((i) => i !== preferred)]
        : lines.map((_, i) => i);
    for (const line of order) {
      const index = lines[line].episodes.findIndex((item) => item.name === episodeName);
      if (index >= 0) {
        return { line, episode: index };
      }
    }
  }
  return { line: 0, episode: 0 };
}

/**
 * 用缓存里的详情条目算首帧状态；`cached` 为空（未命中 / 直播 / 空详情）时
 * 返回 null，调用方照旧走异步拉取。
 */
export function seedFromCachedDetail(
  cached: readonly VodInfo[] | undefined,
  playUrl: string,
  episodeName = "",
  playFrom = "",
): EpisodeSeed | null {
  const first = cached && cached.length > 0 ? cached[0] : null;
  if (!first) {
    return null;
  }
  const lines = parsePlayLines(first.vod_play_from, first.vod_play_url);
  if (lines.length === 0) {
    // 详情在、但一条线路都没解析出来（空 vod_play_url）：种子没有价值，
    // 交给异步路径处理，避免把「有详情无剧集」误判成命中。
    return null;
  }
  return {
    vod: first,
    lines,
    locus: locateEpisode(lines, playUrl, episodeName, playFrom),
  };
}
