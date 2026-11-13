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
import { api, errorMessage } from "../lib/invoke";
import { log } from "../lib/logger";
import type { PlayResolved } from "../types/tvbox";

export interface UsePlayResolutionArgs {
  siteKey: string;
  playUrl: string;
  playFrom?: string;
  /** 直播源声明的 UA，直接用于播放请求（没有 playerContent 可问）。 */
  liveUa?: string;
  vodId: string;
  /** 解析池命中提示，由播放页统一管理提示条。 */
  setSwitchTip: Dispatch<SetStateAction<string>>;
  /** 播放/解码错误由播放页统一展示。 */
  setVideoError: Dispatch<SetStateAction<string>>;
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
  resolveError: string;
  setResolved: Dispatch<SetStateAction<PlayResolved | null>>;
  /**
   * 重新走一遍 playerContent → resolve_play，并把 resolved 换成一个新对象，
   * 让播放内核整体重建（卡死 / 网络异常后恢复播放）。递增的 nonce 是保证
   * 「同一个 playUrl 也能重新解析」的关键：不能把它做进依赖里的布尔开关。
   */
  reload: () => void;
}

/**
 * 前端解析硬上限：后端单点超时是 playerContent 15s + level-4 sniff 15s = 30s，
 * 这里再留 5s 余量。任何超出都是「源/网络真挂了」或偶发的无限挂起，必须给
 * 用户一个明确结论（而不是转圈到天荒地老）。刷新/换源都不会超过这个上限。
 */
const RESOLVE_HARD_CAP_MS = 35_000;

export function usePlayResolution({
  siteKey,
  playUrl,
  playFrom,
  liveUa,
  vodId,
  setSwitchTip,
  setVideoError,
}: UsePlayResolutionArgs): PlayResolution {
  const [resolved, setResolved] = useState<PlayResolved | null>(null);
  // Entering the player always starts a resolve; defaulting to true avoids a
  // first frame that flashes the "unplayable address" fallback before the effect
  // flips the flag (and matches the always-mounted, hidden-while-resolving
  // stage, so no overlay content swaps mid-frame).
  const [resolving, setResolving] = useState(true);
  const [stage, setStage] = useState<"parsing" | "connecting" | null>(null);
  const [resolveError, setResolveError] = useState("");
  const [reloading, setReloading] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const reload = useCallback(() => setReloadNonce((value) => value + 1), []);
  /** 上一次解析的地址组合：相同地址再次触发只可能是用户点了「刷新」。 */
  const lastSource = useRef("");

  useEffect(() => {
    const source = `${siteKey}|${playUrl}|${playFrom ?? ""}|${liveUa ?? ""}`;
    // 软刷新：保留当前 resolved 与播放实例，控件全程可见可点；只有解析成功
    // 后才替换 resolved 重建解码器。首次进入 / 换集换源仍走硬解析。
    const soft = lastSource.current === source;
    lastSource.current = source;

    // 恢复出来的播放页（路由只有 siteKey+vodId，没有 playUrl）根本无法解析：
    // 直接给明确错误并结束 resolving，避免一直转「正在解析播放地址…」。
    // 从影片详情重新进入即可带上地址。注意 playUrl 在依赖里，变化会重跑。
    if (!playUrl) {
      setResolveError("缺少播放地址，请从影片详情重新进入播放页");
      setStage(null);
      setResolving(false);
      return;
    }

    let alive = true;
    let capReject: ((err: Error) => void) | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const run = async () => {
      if (soft) {
        setReloading(true);
      } else {
        setResolving(true);
        setStage("parsing");
        // 换成一个全新的 null -> 新对象的时序：内核 effect 会因 resolving 先
        // 卸载旧实例，解析完成后再按新 resolved 重建，不会两个解码器叠着播。
        setResolved(null);
      }
      setResolveError("");
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
          RESOLVE_HARD_CAP_MS,
        );
        // TVBox 链路：详情里的 playUrl 常常只是线路 id 或自定义 scheme
        // （weiguan://、PAN1-…、6105_0_1），必须让 spider 的 playerContent
        // 解析出真实直链再交给本地代理。编排细节收在 lib/episodeResolve，
        // 与播放页的换线路 / 换源探测共用同一份规则。用户手选的线路给
        // 15s 超时：慢源（多多影院实测 4~5s，忙时更久）不该在首次解析
        // 就被判死跳走；探测/换线链路保持 8s 不变。
        const target = await Promise.race([
          resolveEpisodeTarget(siteKey, playFrom, playUrl, {
            playerContentTimeoutMs: 15_000,
          }),
          hardCap,
        ]);
        if (alive) {
          // 直链已拿到，进入「交给反代 + 播放内核建连」阶段。
          setStage("connecting");
        }
        if (target.unresolvable) {
          // 源给的 token 连它自己的 playerContent 都不认（网盘 / 专用插件线路）。
          // 说清原因，别把 INVALID_ARGUMENT 的原文抛给用户。fail-fast，不进 resolvePlay。
          throw new Error("该线路需要源侧插件解析（网盘 token），内置播放器无法直接播放");
        }
        // 直播没有 playerContent 可问，UA 只能来自 lives[].ua。
        if (target.parser) {
          setSwitchTip(`解析来自「${target.parser}」`);
        }
        const result = await Promise.race([
          api.resolvePlay({
            siteKey,
            url: target.url,
            ua: target.ua ?? liveUa,
            referer: target.referer,
            cookie: target.cookie,
          }),
          hardCap,
        ]);
        if (alive) {
          setResolved(result);
        }
      } catch (err) {
        if (alive) {
          setResolveError(errorMessage(err));
          log.warn("resolve failed", {
            siteKey,
            vodId,
            message: errorMessage(err),
          });
        }
      } finally {
        if (capTimer) {
          clearTimeout(capTimer);
        }
        capReject = null;
        if (alive) {
          if (soft) {
            setReloading(false);
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
    };
    // setter 引用稳定，vodId 仅用于日志；reloadNonce 只由用户点刷新时递增。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, playUrl, playFrom, liveUa, reloadNonce]);

  return {
    resolved,
    resolving,
    stage,
    reloading,
    resolveError,
    setResolved,
    reload,
  };
}
