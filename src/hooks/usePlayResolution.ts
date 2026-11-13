/**
 * 播放地址解析编排（从 PlayerPage 抽出，effect 体与依赖数组保持原样）。
 *
 * TVBox 详情里的 playUrl 常常只是线路 id 或自定义 scheme（weiguan://、PAN1-…、
 * 6105_0_1），必须让 spider 的 playerContent 解析出真实直链再交给本地代理；
 * CMS 未实现该方法时直接回退原始地址。解析池（parses[]）与本机反代各司其职。
 *
 * 只负责「地址 → PlayResolved」这一段，不含播放内核、历史、换源。
 */
import { useEffect, useState } from "react";
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
  resolveError: string;
  timeMs: number;
  durationMs: number;
  setResolved: Dispatch<SetStateAction<PlayResolved | null>>;
  setTimeMs: Dispatch<SetStateAction<number>>;
  setDurationMs: Dispatch<SetStateAction<number>>;
}

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
  const [resolveError, setResolveError] = useState("");
  const [timeMs, setTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setResolving(true);
      setResolveError("");
      setVideoError("");
      setResolved(null);
      setTimeMs(0);
      setDurationMs(0);
      try {
        // TVBox 链路：详情里的 playUrl 常常只是线路 id 或自定义 scheme
        // （weiguan://、PAN1-…、6105_0_1），必须让 spider 的 playerContent
        // 解析出真实直链再交给本地代理。编排细节收在 lib/episodeResolve，
        // 与播放页的换线路 / 换源探测共用同一份规则。用户手选的线路给
        // 15s 超时：慢源（多多影院实测 4~5s，忙时更久）不该在首次解析
        // 就被判死跳走；探测/换线链路保持 8s 不变。
        const target = await resolveEpisodeTarget(siteKey, playFrom, playUrl, {
          playerContentTimeoutMs: 15_000,
        });
        if (target.unresolvable) {
          // 源给的 token 连它自己的 playerContent 都不认（网盘 / 专用插件线路）。
          // 说清原因，别把 INVALID_ARGUMENT 的原文抛给用户。
          throw new Error("该线路需要源侧插件解析（网盘 token），内置播放器无法直接播放");
        }
        // 直播没有 playerContent 可问，UA 只能来自 lives[].ua。
        if (target.parser) {
          setSwitchTip(`解析来自「${target.parser}」`);
        }
        const result = await api.resolvePlay({
          siteKey,
          url: target.url,
          ua: target.ua ?? liveUa,
          referer: target.referer,
          cookie: target.cookie,
        });
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
        if (alive) {
          setResolving(false);
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
    // 依赖数组与抽出前逐字一致：setter 引用稳定，vodId 仅用于日志，
    // 不参与「何时重新解析」的判定（保持Zero 行为差异）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, playUrl, playFrom, liveUa]);

  return {
    resolved,
    resolving,
    resolveError,
    timeMs,
    durationMs,
    setResolved,
    setTimeMs,
    setDurationMs,
  };
}
