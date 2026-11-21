/**
 * 单集播放解析（换集 / 换源共用的一条链）。
 *
 * 「把某一集的 `vod_play_url` 变成能交给反代的 `PlayResolved`」在换集与换源
 * 两条入口上是同一件事，顺序也固定：
 *
 * 1. 命中集级缓存（`episodePlayCache`）且播放类型仍与当前内核一致 → 直接复用，
 *    省掉 playerContent + resolve_play 的 3~18s；
 * 2. 否则先 `resolveEpisodeTarget`（私有 token / 自定义 scheme 要问源自己的
 *    `playerContent`），再 `resolve_play` 拿反代地址与 headers；
 * 3. 落地前校验播放类型没变：`hls → page` 这种变化说明线路换了协议，原地换流
 *    只会白屏，调用方应退回整页重建；
 * 4. 解析成功写回缓存；**失败由调用方作废该集缓存**（坏地址不许被下次点击复用）。
 *
 * 抽成一处的原因：两处各写一份时，一份补了类型校验、另一份漏补，就会出现
 * 「换源能播、换集白屏」这种只在特定入口复现的缺陷；改缓存口径也要改两遍。
 */
import { api } from "../../lib/invoke";
import { log } from "../../lib/logger";
import { resolveEpisodeTarget } from "../../lib/episodeResolve";
import { getEpisodePlayCache, setEpisodePlayCache } from "../../lib/episodePlayCache";
import type { PlayResolved } from "../../types/luma";

/**
 * @param expectedKind 当前内核正在播的播放类型（`resolved.kind`）；换流前后必须一致。
 * @throws 线路不可解析 / 解析失败 / 播放类型变化（由调用方决定退回整页还是换线）。
 */
export async function resolveEpisodePlay(
  siteKey: string,
  playFrom: string | undefined,
  episodeUrl: string,
  expectedKind: string,
): Promise<PlayResolved> {
  const cached = getEpisodePlayCache(siteKey, playFrom, episodeUrl);
  if (cached && cached.kind === expectedKind && cached.kind !== "page") {
    return cached;
  }
  const target = await resolveEpisodeTarget(siteKey, playFrom, episodeUrl);
  if (target.unresolvable) {
    throw new Error("线路不可解析");
  }
  const play = await api.resolvePlay({
    siteKey,
    url: target.url,
    ua: target.ua,
    referer: target.referer,
    cookie: target.cookie,
  });
  if (play.kind !== expectedKind || play.kind === "page") {
    throw new Error(`播放类型变化：${expectedKind} → ${play.kind}`);
  }
  setEpisodePlayCache(siteKey, playFrom, episodeUrl, play);
  return play;
}

/**
 * 预取：把「用户大概率马上要点的那一集」提前解析好写进集级缓存。
 *
 * 与 `resolveEpisodePlay` 的唯一区别是**不知道当前内核的播放类型**，因此不做
 * `expectedKind` 断言——写进缓存的仍是完整 `PlayResolved`，播放页命中后照旧按
 * kind 复核，不一致就当未命中（不会把 page 型地址塞给 hls）。
 *
 * 全部失败静默：真正的错误由用户点击时的正常链路负责报。
 */
export async function prefetchEpisodePlay(
  siteKey: string,
  playFrom: string | undefined,
  episodeUrl: string,
): Promise<void> {
  if (getEpisodePlayCache(siteKey, playFrom, episodeUrl)) {
    return;
  }
  try {
    const target = await resolveEpisodeTarget(siteKey, playFrom, episodeUrl);
    if (target.unresolvable) {
      return;
    }
    const play = await api.resolvePlay({
      siteKey,
      url: target.url,
      ua: target.ua,
      referer: target.referer,
      cookie: target.cookie,
    });
    // 页面型地址还要过嗅探，缓存它对下一次点击没有帮助。
    if (play.kind === "page") {
      return;
    }
    setEpisodePlayCache(siteKey, playFrom, episodeUrl, play);
    log.info("episode play prefetched", { siteKey, playFrom, kind: play.kind });
  } catch {
    /* 预取失败不影响任何用户路径 */
  }
}
