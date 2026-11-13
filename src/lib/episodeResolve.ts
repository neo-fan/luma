/**
 * TVBox 播放地址前置解析：`vod_play_url` 里的地址 → 真正能交给反代的 URL。
 *
 * 详情里的 playUrl 常常不是 URL，而是「线路名-私有 token」或自定义 scheme：
 * `PAN1-7vpup…`、`weiguan://…`、`6105_0_1`。真实地址只能由 spider 的
 * `playerContent(from, url, [])` 给出（FongMi 侧同样是先问播放器、拿到
 * `url` 才建解码器）。把这些串直接丢给 `resolve_play` 只会得到
 * `INVALID_ARGUMENT: play url is invalid`。
 *
 * 本模块把这条编排抽成一处，供播放页的首次解析与「换线路 / 换源」探测共用：
 * 三处如果各写一份，探测链路就会漏掉 playerContent（实测一次换源刷 11 条
 * invalid 日志，且真正可播的线路被跳过）。
 */
import { api } from "./invoke";
import { normalizeHeaders } from "./playHeaders";

export interface EpisodeTarget {
  /** 交给 `resolve_play` 的地址；playerContent 不可用时原样回退。 */
  url: string;
  ua?: string;
  referer?: string;
  cookie?: string;
  /** 解析池命中的解析器名，调用方自行决定是否提示（探测链路不该弹提示）。 */
  parser?: string;
  /**
   * 这条线路内置播放器**确定播不了**：`vod_play_url` 是私有 token，而源自己的
   * `playerContent` 也把它原样吐回来（网盘 / 专用插件类线路，如 `CO4K_…`、
   * `qsvip-…`、`jjkk-…`）。调用方应直接换线路，而不是把 token 丢给
   * `resolve_play` 换一句 `play url is invalid`。
   */
  unresolvable?: boolean;
}

interface PlayerContentResult {
  playUrl?: string;
  url?: string;
  parse?: number;
  jx?: number;
  /** 多数源给对象，部分源（pianku 系）给 JSON 字符串。 */
  header?: Record<string, string> | string;
}

/** `127.0.0.1:9978/proxy?do=py…` 由宿主实现，`resolve_play` 会原样透传。 */
const LOCAL_PROXY = /^https?:\/\/127\.0\.0\.1:\d+\/(proxy|proxy2)\b/i;
const HTTP_URL = /^https?:\/\//i;

/**
 * 解析一条剧集地址。
 *
 * `playFrom`（线路名）为空时跳过 playerContent —— 直播、历史直进、以及
 * 部分 CMS 没有该方法，此时保持原有「直接当 URL 用」的行为。
 * 任何异常都回退到原地址，让 `resolve_play` 的嗅探 / 报错兜底。
 */
export async function resolveEpisodeTarget(
  siteKey: string,
  playFrom: string | undefined,
  playUrl: string,
): Promise<EpisodeTarget> {
  if (!playFrom) {
    return { url: playUrl };
  }
  let played: PlayerContentResult | null = null;
  try {
    played = (await api.spiderInvoke({
      siteKey,
      method: "playerContent",
      args: [playFrom, playUrl, []],
      timeoutMs: 15_000,
    })) as PlayerContentResult | null;
  } catch {
    // CMS / 未实现 playerContent 的源：沿用原始地址。
    return { url: playUrl };
  }

  const candidate = String(played?.playUrl || played?.url || "");
  const parseFlag = Number(played?.parse ?? 0);
  const jxFlag = Number(played?.jx ?? 0);
  const header = normalizeHeaders(played?.header);
  const target: EpisodeTarget = {
    url: playUrl,
    ua: header["User-Agent"] || header["user-agent"],
    referer: header["Referer"] || header["referer"],
    cookie: header["Cookie"] || header["cookie"],
  };

  if (!HTTP_URL.test(candidate)) {
    // playerContent 没给出可用地址（空串 / 仍是私有 scheme）：保持原地址，
    // 但记下「这条线路内置链路救不了」——原地址本身也不是 URL 时，交给
    // resolve_play 只会得到 INVALID_ARGUMENT，对用户毫无信息量。
    if (!HTTP_URL.test(playUrl)) {
      target.unresolvable = true;
    }
    return target;
  }
  if (LOCAL_PROXY.test(candidate)) {
    target.url = candidate;
    return target;
  }
  if (parseFlag === 0 && jxFlag === 0) {
    target.url = candidate;
    return target;
  }

  // TVBox 语义：parse=1 / jx=1 表示该地址还要过 parses[] 解析池
  // （type 0 嗅探 / type 1 JSON 接口 / type 4 并行竞速）。
  try {
    const hit = await api.parseResolve({
      siteKey,
      url: candidate,
      flag: playFrom,
      headers: header,
    });
    if (hit?.url) {
      target.url = hit.url;
      target.parser = hit.parser;
      for (const [name, value] of hit.headers ?? []) {
        const lower = name.toLowerCase();
        if (lower === "user-agent") {
          target.ua = value;
        } else if (lower === "referer") {
          target.referer = value;
        } else if (lower === "cookie") {
          target.cookie = value;
        }
      }
    }
  } catch {
    // 解析池全失败：保留原地址，由 resolve_play 的嗅探兜底。
    target.url = candidate;
  }
  return target;
}
