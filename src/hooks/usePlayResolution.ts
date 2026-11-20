/**
 * 播放地址解析编排（从 PlayerPage 抽出，effect 体与依赖数组保持原样）。
 *
 * TVBox 详情里的 playUrl 常常只是线路 id 或自定义 scheme（weiguan://、PAN1-…、
 * 6105_0_1），必须让 spider 的 playerContent 解析出真实直链再交给本地代理；
 * CMS 未实现该方法时直接回退原始地址。解析池（parses[]）与本机反代各司其职。
 *
 * 只负责「地址 → PlayResolved」这一段，不含播放内核、历史、换源。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { resolveEpisodeTarget } from "../lib/episodeResolve";
import {
  getEpisodePlayCache,
  invalidateEpisodePlayCache,
  setEpisodePlayCache,
} from "../lib/episodePlayCache";
import { api, errorMessage } from "../lib/invoke";
import { log } from "../lib/logger";
import { startTrace } from "../lib/switchTrace";
import type { PlayResolved } from "../types/luma";

export interface UsePlayResolutionArgs {
  siteKey: string;
  playUrl: string;
  playFrom?: string;
  /** 直播源声明的 UA，直接用于播放请求（没有 playerContent 可问）。 */
  liveUa?: string;
  /** 频道级 Referer（m3u 的 `http-referer`），比源级 UA 更精确，优先使用。 */
  liveReferer?: string;
  /** 频道级 Cookie（m3u 的 `http-cookie` / `http-header="Cookie=…"`）。 */
  liveCookie?: string;
  vodId: string;
  /** 解析池命中提示，由播放页统一管理提示条。 */
  setSwitchTip: Dispatch<SetStateAction<string>>;
  /** 播放/解码错误由播放页统一展示。 */
  setVideoError: Dispatch<SetStateAction<string>>;
  /**
   * 换地址时**保留当前播放实例**（直播：换台 / 换线路）。
   *
   * 点播的硬解析会把 `resolved` 清成 null 让内核卸载旧实例——那是刻意的
   * （换集必须掐掉旧流的音频）。但直播的换线按钮就长在播放器控制栏里：
   * 一旦实例被销毁，控制栏、线路 selector、全屏全部消失，用户面对的是一块
   * 只剩「正在连接播放地址…」的黑面板，连换线这个出口都没有了（实测截图）。
   *
   * 传 true 时改为「后台解析 + 落地才换」：解析期间旧实例继续渲染、控制栏
   * 照常可用（调用方用 `switching` 驱动 loading 与按钮态），新地址拿到之后
   * 才替换 `resolved`，内核在这一刻重建。解析失败则保留旧实例与旧 `resolved`。
   */
  keepInstanceWhileSwitching?: boolean;
}

export interface PlayResolution {
  resolved: PlayResolved | null;
  resolving: boolean;
  /**
   * 解析进度阶段，给中间提示用更精确的文案，避免用户把「解析中」误判成卡死：
   * - `"parsing"`   正在问源拿真实直链（playerContent / 解析池）
   * - `"connecting"` 直链已拿到，正在交给本地反代与播放内核建立连接
   * - `null`        未在解析
   */
  stage: "parsing" | "connecting" | null;
  /** 刷新中：与首次解析不同，旧播放器实例与控件必须保持可见可用。 */
  reloading: boolean;
  /**
   * 换地址在途但**保留了旧实例**（`keepInstanceWhileSwitching`，直播换台/换线）。
   * 与 `resolving` 互斥：此刻画面上还有播放器与控制栏，调用方只加「换流中」态。
   */
  switching: boolean;
  resolveError: string;
  /**
   * 这条 `resolveError` **属于哪个 playUrl**。
   *
   * `resolveError` 是 state：用户点新台的那一次渲染里它仍是上一轮的旧错误串，
   * 消费方（直播自动换线 effect）若不加判据就会拿着残留错误把新频道第一条线路
   * 秒判死（实测换台后 169ms 就 skip 到线路 2）。setter 与 `resolveError` 恒在
   * 同一同步块写入，所以两者在任一渲染里天然一致：`errorPlayUrl === playUrl`
   * 才代表「这条错属于当前地址」。空串 = 没有错误归属。
   */
  errorPlayUrl: string;
  /**
   * 解析失败的**原因属于「没定论」**（源侧冷启动 / 忙时超过预算还没答）。
   *
   * 与「源明确说这条线路不能用」严格区分：调用方据此**不得自动换源**——
   * 用户实测过「再等一会儿就能加载」的源，被换线跳走反而丢了能播的线路。
   */
  resolveRetryable: boolean;
  setResolved: Dispatch<SetStateAction<PlayResolved | null>>;
  /**
   * 重新走一遍 playerContent → resolve_play，并把 resolved 换成一个新对象，
   * 让播放内核整体重建（卡死 / 网络异常后恢复播放）。递增的 nonce 是保证
   * 「同一个 playUrl 也能重新解析」的关键：不能把它做进依赖里的布尔开关。
   */
  reload: () => void;
}

/**
 * 前端解析硬上限：后端单点超时是 playerContent 30s + level-4 sniff 15s = 45s，
 * 这里再留 5s 余量。任何超出都是「源/网络真挂了」或偶发的无限挂起，必须给
 * 用户一个明确结论（而不是转圈到天荒地老）。刷新/换源都不会超过这个上限。
 */
const RESOLVE_HARD_CAP_MS = 50_000;

/**
 * 直播的解析硬上限。
 *
 * 直播没有 playerContent 那一步（地址就是直链），`resolve_play` 只是交给本机
 * 反代建连 + 嗅探，正常 1s 内返回。用 50s 的通用上限会让一条死线路把界面按在
 * 「正在连接播放地址…」近一分钟——直播频道 20 条线路，用户早该换台了。
 * 15s 足够覆盖临时抖动，又能在死地址上尽快给出结论。
 */
const LIVE_RESOLVE_CAP_MS = 15_000;

/**
 * 用户主动点播时给 playerContent 的预算。
 *
 * 2026-11-14 实测 py_bubuzhuiju 的 zijianm3u8：进程内**首次**调用 18.3 s
 * （源侧解析接口冷启动），第二次起 1.8~2.0 s。原来给 15 s 会在冷启动时判超时，
 * 而超时又被误记成「坏线路」→ 这条完全能播的线路被封印 30 分钟，用户看到
 * 「一直停在正在连接播放地址…」。慢不等于坏，预算必须覆盖冷启动。
 */
const FIRST_PLAY_PLAYER_CONTENT_MS = 30_000;

export function usePlayResolution({
  siteKey,
  playUrl,
  playFrom,
  liveUa,
  liveReferer,
  liveCookie,
  vodId,
  setSwitchTip,
  setVideoError,
  keepInstanceWhileSwitching = false,
}: UsePlayResolutionArgs): PlayResolution {
  const [resolved, setResolved] = useState<PlayResolved | null>(null);
  // Entering the player always starts a resolve; defaulting to true avoids a
  // first frame that flashes the "unplayable address" fallback before the effect
  // flips the flag (and matches the always-mounted, hidden-while-resolving
  // stage, so no overlay content swaps mid-frame).
  const [resolving, setResolving] = useState(true);
  const [stage, setStage] = useState<"parsing" | "connecting" | null>(null);
  const [resolveError, setResolveError] = useState("");
  /** 与 `resolveError` 配对提交：见接口注释（错误归属地址）。 */
  const [errorPlayUrl, setErrorPlayUrl] = useState("");
  const [resolveRetryable, setResolveRetryable] = useState(false);
  const [reloading, setReloading] = useState(false);
  /** 保留实例的换地址在途（直播换台/换线）：解析期间控制栏照常可用。 */
  const [switching, setSwitching] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  /**
   * 刷新必须绕过按集缓存：用户点刷新就是「这个地址可能坏了，重新要一个」，
   * 若命中缓存会把同一个坏地址再喂一遍。直接作废当前 key，软/硬解析都重走。
   * 依赖里的三个值在一次挂载内不变（PlayerHost 按它们换 key），reload 引用稳定。
   */
  const reload = useCallback(() => {
    invalidateEpisodePlayCache(siteKey, playFrom, playUrl);
    setReloadNonce((value) => value + 1);
  }, [siteKey, playFrom, playUrl]);
  /** 上一次解析的地址组合：相同地址再次触发只可能是用户点了「刷新」。 */
  const lastSource = useRef("");
  /** 最近一次已落地的结果，用来区分「软刷新」与「effect 被重跑」。 */
  const resolvedRef = useRef<PlayResolved | null>(null);
  resolvedRef.current = resolved;

  useEffect(() => {
    const source = `${siteKey}|${playUrl}|${playFrom ?? ""}|${liveUa ?? ""}|${liveReferer ?? ""}|${liveCookie ?? ""}`;
    // 软刷新：保留当前 resolved 与播放实例，控件全程可见可点；只有解析成功
    // 后才替换 resolved 重建解码器。首次进入 / 换集换源仍走硬解析。
    //
    // ⚠️ 必须加上「已有结果」这个条件。dev 的 StrictMode 会把挂载 effect 跑
    // 两遍：第一遍写 lastSource 后立刻被 cleanup（alive=false，状态没落地），
    // 第二遍看到 source 相同就误判成软刷新，于是既不走 setResolving(true)、
    // finally 里也只清 reloading —— `resolving` 永远停在 true，播放内核因此
    // 不建实例，界面永远卡在「正在连接播放地址…」（2026-11-14 实测：
    // resolve_play 97 秒前就返回了，播放器还是空的）。
    const soft = lastSource.current === source && resolvedRef.current !== null;
    /**
     * 保留实例的换地址（直播换台/换线）：已有实例时不清 resolved、不置
     * resolving，等于「控制栏原地不动，后台换流」。首次进入（还没有实例）
     * 仍走硬解析，否则连第一帧都建不出来。
     */
    const keepInstance = keepInstanceWhileSwitching && !soft && resolvedRef.current !== null;
    lastSource.current = source;
    // 埋点：一次解析 = 一个 trace（阶段见各 mark）。日志里搜 "trace" 就能把
    // 「点下去 → 直链 → 反代建连 → 出画/失败」的耗时与结局一次拉出来。
    const trace = startTrace("resolve", {
      site: siteKey,
      live: siteKey === "live",
      soft,
      keepInstance,
    });

    // 恢复出来的播放页（路由只有 siteKey+vodId，没有 playUrl）根本无法解析：
    // 直接给明确错误并结束 resolving，避免一直转「正在解析播放地址…」。
    // 从影片详情重新进入即可带上地址。注意 playUrl 在依赖里，变化会重跑。
    if (!playUrl) {
      if (siteKey === "live") {
        // 直播的空地址是选台前的瞬态（冷启动 / 切源清空 pick），不是「恢复
        // 播放页缺地址」：不写错误结论，否则 m3u 返回、loading 翻 false 的
        // 那一帧会先于选台 effect 把「播放失败」闪上屏（2026-11-15 实测）。
        // 顺手清掉上一源/上一轮可能残留的错误。
        setResolveError("");
      } else {
        setResolveError("缺少播放地址，请从影片详情重新进入播放页");
      }
      setStage(null);
      setResolving(false);
      // 归属地址与错误配对：此刻 playUrl 为空，错误不属于任何可播放地址。
      setErrorPlayUrl(playUrl);
      // 换台/切源会把地址清空：这一轮没有「换流中」可言，否则控制栏会被
      // 永久钉在 loading 态（switching 只在解析 finally 里复位）。
      setSwitching(false);
      trace.end("aborted", { reason: "no-url" });
      return;
    }

    let alive = true;
    let capReject: ((err: Error) => void) | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    /** 本次失败是否只是「源还没答完」——决定上层能不能自动换源。 */
    let slowTimeout = false;
    const run = async () => {
      // 按集缓存：换线探活（probeCandidate）/ 下一集预解析 / 上一轮播放都可能
      // 已经把这条地址解析过。remount 后的新页面命中即直接落地，跳过整条
      // playerContent → resolve_play 网络链。只在硬解析查：软刷新（用户点
      // 刷新）在 reload 里已作废缓存，且必须重走网络。直播地址可能带时效
      // token，不读不写（siteKey === "live"）。
      //
      // StrictMode 双跑安全：两遍都命中同一份缓存、写同一组 state，幂等；
      // 不触碰 lastSource / soft 的判定时序（见上方注释）。
      if (!soft && siteKey !== "live") {
        const cached = getEpisodePlayCache(siteKey, playFrom, playUrl);
        if (cached) {
          setResolveError("");
          setErrorPlayUrl("");
          setResolveRetryable(false);
          setVideoError("");
          setResolved(cached);
          setResolving(false);
          setStage(null);
          trace.end("ok", { cached: true, kind: cached.kind });
          return;
        }
      }
      if (soft) {
        setReloading(true);
        // 软刷新意味着已有 resolved，绝不该停在「解析中」——多这一行是给
        // 上面的 StrictMode 场景兜底，避免再出现「永远转圈」。
        setResolving(false);
      } else if (keepInstance) {
        // 直播换台/换线：实例、控制栏、全屏状态全部原地保留，只进「换流中」。
        // 解析落地后才替换 resolved（内核在那一刻重建，换台耗时落在后台），
        // 失败则旧实例照旧可用——用户随时还能点线路 selector 换一条。
        setSwitching(true);
        setResolving(false);
        setStage("connecting");
      } else {
        setResolving(true);
        setStage("parsing");
        // 换成一个全新的 null -> 新对象的时序：内核 effect 会因 resolving 先
        // 卸载旧实例，解析完成后再按新 resolved 重建，不会两个解码器叠着播。
        setResolved(null);
      }
      setResolveError("");
      setErrorPlayUrl("");
      setResolveRetryable(false);
      setVideoError("");
      try {
        // 硬上限兜底：单点超时是 playerContent 15s + sniff 15s，35s 已是余量，
        // 任何更久都是源/网络真挂了或偶发无限挂起，必须给明确结论。
        const hardCap = new Promise<never>((_, reject) => {
          capReject = reject;
        });
        capTimer = setTimeout(
          () =>
            capReject?.(
              new Error("播放地址解析超时（源可能不可用或网络异常），可点刷新按钮重试"),
            ),
          siteKey === "live" ? LIVE_RESOLVE_CAP_MS : RESOLVE_HARD_CAP_MS,
        );
        // TVBox 链路：详情里的 playUrl 常常只是线路 id 或自定义 scheme
        // （weiguan://、PAN1-…、6105_0_1），必须让 spider 的 playerContent
        // 解析出真实直链再交给本地代理。编排细节收在 lib/episodeResolve，
        // 与播放页的换线路 / 换源探测共用同一份规则。用户手选的线路给
        // 15s 超时：慢源（多多影院实测 4~5s，忙时更久）不该在首次解析
        // 就被判死跳走；探测/换线链路保持 8s 不变。
        const target = await Promise.race([
          resolveEpisodeTarget(siteKey, playFrom, playUrl, {
            playerContentTimeoutMs: FIRST_PLAY_PLAYER_CONTENT_MS,
            // 首次解析是用户主动点播：坏线路标记只代表「源曾经忙时超时」，
            // 不能拦住用户重新点播（否则被误封的线路 30 分钟内点不开）。
            ignoreBadLineMark: true,
          }),
          hardCap,
        ]);
        if (!alive) {
          // 这一轮已被新地址取代（换台 / 换集 / 刷新）：旧结果一个字段都不许再写，
          // 否则会把新一轮的「解析中」覆盖成「连接中」，界面就此卡住。
          trace.end("aborted", { at: "target" });
          return;
        }
        // 直链已拿到，进入「交给反代 + 播放内核建连」阶段。
        trace.mark("target", {
          parser: target.parser ?? "",
          // 直播没有 playerContent，这一段的耗时应当接近 0；明显高就说明
          // 「源侧解析」被误用到了直播链路上。
          timedOut: Boolean(target.timedOut),
          privateUrl: Boolean(target.unresolvable),
        });
        setStage("connecting");
        if (target.timedOut) {
          // 慢失败必须先说清楚：这不是「网盘 token」，重试就能好。
          // 同时标记成「无定论」：上层不许因为这一条自动换源（用户实测：
          // 再等十几秒就能出画，换走了反而把能播的线路丢掉）。
          slowTimeout = true;
          throw new Error(
            "源响应超时（首次加载源侧冷启动较慢），已保留当前线路，点刷新可重试",
          );
        }
        if (target.unresolvable) {
          // 源给的 token 连它自己的 playerContent 都不认（网盘 / 专用插件线路）。
          // 说清原因，别把 INVALID_ARGUMENT 的原文抛给用户。fail-fast，不进 resolvePlay。
          // 「源明确拒绝」与「源没答完」要分开说：前者是线路停用 / 要源侧账号，
          // 过一阵可能恢复，文案必须留「重试」这条路，不能写成没救。
          throw new Error(
            target.rejected
              ? "源站没有解析这条线路（可能暂时停用或需要源侧账号），可换一条线路，或稍后点刷新重试"
              : "该线路需要源侧插件解析（网盘 token），内置播放器无法直接播放",
          );
        }
        // 直播没有 playerContent 可问，UA 只能来自 lives[].ua。
        if (target.parser && alive) {
          setSwitchTip(`解析来自「${target.parser}」`);
        }
        const result = await Promise.race([
          api.resolvePlay({
            siteKey,
            url: target.url,
            ua: target.ua ?? liveUa,
            referer: target.referer ?? liveReferer,
            cookie: target.cookie ?? liveCookie,
          }),
          hardCap,
        ]);
        if (alive) {
          setResolved(result);
          // 写入按集缓存：换集 / 换线 / 换源 remount 回来时直接命中。
          // kind 过滤在 setEpisodePlayCache 内（page/share 不入缓存）。
          if (siteKey !== "live") {
            setEpisodePlayCache(siteKey, playFrom, playUrl, result);
          }
          trace.end("ok", { kind: result.kind });
        } else {
          trace.end("aborted", { at: "proxy" });
        }
      } catch (err) {
        if (alive) {
          setResolveRetryable(slowTimeout);
          setResolveError(errorMessage(err));
          setErrorPlayUrl(playUrl);
          log.warn("resolve failed", {
            siteKey,
            vodId,
            message: errorMessage(err),
          });
          trace.end("fail", {
            slow: slowTimeout,
            reason: errorMessage(err).slice(0, 120),
          });
        } else {
          trace.end("aborted", { at: "error" });
        }
      } finally {
        if (capTimer) {
          clearTimeout(capTimer);
        }
        capReject = null;
        if (alive) {
          if (soft) {
            setReloading(false);
          } else if (keepInstance) {
            setSwitching(false);
            setStage(null);
          } else {
            setResolving(false);
            setStage(null);
          }
        }
      }
    };
    void run();
    return () => {
      alive = false;
      // 被新一轮取代：trace 收口成 aborted，日志里才看得出「这一轮没跑完
      // 是因为又点了别的」。end 幂等，正常收口过的不会再写一条。
      trace.end("aborted", { reason: "superseded" });
      // 硬上限定时器必须一起收掉：只置 alive 的话，旧一轮的 50s 计时器会在
      // 下一轮解析途中触发，把一条过期错误塞进 Promise.race（表现为「刚换台
      // 就报超时」）。
      if (capTimer) {
        clearTimeout(capTimer);
        capTimer = null;
      }
      capReject = null;
    };
    // setter 引用稳定，vodId 仅用于日志；reloadNonce 只由用户点刷新时递增。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, playUrl, playFrom, liveUa, liveReferer, liveCookie, reloadNonce]);

  return {
    resolved,
    resolving,
    stage,
    reloading,
    switching,
    resolveError,
    errorPlayUrl,
    resolveRetryable,
    setResolved,
    reload,
  };
}
