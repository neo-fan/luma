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
import { isLineBad, markLineBad, markLineGood } from "./lineHealth";
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
  /**
   * 源**明确拒绝了这次解析**（不是超时）：`playerContent` 把 token 原样吐回、
   * 或返回空串，而原地址本身也不是 URL。布布追剧的 `zijianm3u8` 实测就是站点
   * 回了「线路暂时停用 / 当前账户无可用套餐」——这类原因可能过一会儿恢复，
   * 所以要给用户「重试 / 换线路」的出口，而不是当成永久坏线路。
   */
  rejected?: boolean;
  /**
   * `playerContent` 没在超时内返回，但**不能据此判定线路坏**。
   *
   * 2026-11-14 实测 py_bubuzhuiju 的 zijianm3u8：进程内首次调用 18.3s（源侧
   * 解析接口冷启动 + 重试），第二次起 1.8~2.0s。按「超时就 markLineBad」处理
   * 会把一条完全能播的线路封 30 分钟，用户看到的就是「点了没反应 / 一直停在
   * 正在连接」。慢 ≠ 坏，只有源**明确回了一个不能用**的结果才算坏。
   */
  timedOut?: boolean;
  /**
   * 这一次调用失败了，但源**没有给出「不能播」的确定结论**。
   *
   * 成因是连接重置、脚本抛错、上游 5xx、响应不是 JSON 这一类瞬时故障。与
   * `rejected` 严格区分：`rejected` 是「源明确说不」，`transient` 是「源这次
   * 没答好」。后者不许写坏线路标记（否则一次偶发失败会让整条线路在 30 分钟
   * 内被换集/换源路径 fail-fast），文案也必须留「重试」而不是「换线路」。
   */
  transient?: boolean;
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

export interface EpisodeResolveOptions {
  /**
   * `playerContent` 的超时。探测/换线链路用缺省 8s（失败就换下一条，快是
   * 第一位的）；用户手选线路的首次解析应传 15s——慢源（如多多影院的上游
   * API）典型耗时 4~5s，忙时会越过 8s，被判超时后回退拿原始 token 只会
   * 得到 `play url is invalid` 然后白白跳走（实测日志）。
   */
  playerContentTimeoutMs?: number;
  /**
   * 用户**主动**点播时忽略「坏线路」标记（2026-11-14 实测根因）：源偶发超时
   * 会被 lineHealth 记 bad 并盖过几秒前的 good，此后 30 分钟内所有走本模块
   * 的解析（包括用户重新点播）都直接 fail-fast 报「网盘 token」——布布追剧
   * zijianm3u8 就是这样被误封的。探测/自动换线仍按默认 fail-fast（快是第一位）；
   * 手动播放给一次重试机会，成功即 markLineGood 解封。
   */
  ignoreBadLineMark?: boolean;
}

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
  options: EpisodeResolveOptions = {},
): Promise<EpisodeTarget> {
  const playerContentTimeoutMs = options.playerContentTimeoutMs ?? 8_000;
  if (!playFrom) {
    return { url: playUrl };
  }
  // 最近判过「解不开」的线路直接跳过 playerContent：源侧那种「token 原样回吐」
  // 的毛病不会自己好，等一次超时只会让用户以为卡住了。
  // 用户主动点播（ignoreBadLineMark）例外：给重试机会，成功即解封。
  if (isLineBad(siteKey, playFrom) && !options.ignoreBadLineMark) {
    // 坏标记现在只由「源明确拒绝」写入（见 markLineBad 的约定），所以这里可以
    // 理直气壮地告诉用户「源站没解析这条线路」，并允许他稍后重试。
    return { url: playUrl, unresolvable: !HTTP_URL.test(playUrl), rejected: true };
  }
  let played: PlayerContentResult | null = null;
  // 慢 ≠ 坏：耗时接近超时的失败是「源还没答完」，不能当成「源说不能播」。
  const startedAt = Date.now();
  try {
    played = (await api.spiderInvoke({
      siteKey,
      method: "playerContent",
      args: [playFrom, playUrl, []],
      // 探测链路 8s：成功的解码实测都在 5 秒内（PAN1 约 1.9 s、zijian 成功时
      // 约 4.2 s），而网盘 token 线路在源侧忙时会一直挂到超时——多等的那 7 秒
      // 只会推迟「换下一条线路」，用户看到的就是「点了没反应」。用户手选线路
      // 的首播由调用方放宽（见 EpisodeResolveOptions）。
      timeoutMs: playerContentTimeoutMs,
    })) as PlayerContentResult | null;
  } catch {
    // 调用失败只说明「这一次没答好」——连接重置、脚本抛错、上游 5xx、响应不是
    // JSON 都属于这一类，**不等于源明确说这条线路不能播**。早先这里把「快失败」
    // 一律判成 `rejected` 并写 30 分钟坏标记，于是源侧一次偶发异常就让整条线路
    // 在换集 / 换源路径上被 fail-fast：用户看到「无法解析播放地址」，点刷新
    // 又好了（刷新走 `ignoreBadLineMark` 的冷路径）。现在统一记为 transient：
    // 不写坏标记、不谎称「源拒绝」，文案留给「重试」。
    const elapsed = Date.now() - startedAt;
    const slow = elapsed >= playerContentTimeoutMs * 0.7;
    return {
      url: playUrl,
      unresolvable: !HTTP_URL.test(playUrl),
      transient: true,
      // 慢失败同时是超时：上层据 timedOut 给「源较慢」的文案（仍不自动换源）。
      ...(slow ? { timedOut: true } : {}),
    };
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
      // 源把 token 原样吐回 / 给空串：这是「源明确拒绝」，不是超时。站点通常
      // 会带一句原因（线路停用、无可用套餐），过一阵可能恢复，所以文案要留重试。
      target.rejected = true;
      // 源自己都不认这个 token，记下来，下次（含自动接下一集）直接换线。
      markLineBad(siteKey, playFrom);
    }
    return target;
  }
  if (LOCAL_PROXY.test(candidate)) {
    target.url = candidate;
    return target;
  }
  // 解码成功：这条线路是「好线路」，换线时优先用它。
  markLineGood(siteKey, playFrom);
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
