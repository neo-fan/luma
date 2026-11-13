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
import { api, errorMessage } from "../lib/invoke";
import { log } from "../lib/logger";
import { normalizeHeaders } from "../lib/playHeaders";
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
        // 解析出真实直链再交给本地代理。CMS 未实现该方法时直接回退。
        let targetUrl = playUrl;
        // 直播没有 playerContent 可问，UA 只能来自 lives[].ua。
        let ua: string | undefined = liveUa;
        let referer: string | undefined;
        let cookie: string | undefined;
        if (playFrom) {
          try {
            const played = (await api.spiderInvoke({
              siteKey,
              method: "playerContent",
              args: [playFrom, playUrl, []],
              timeoutMs: 15_000,
            })) as {
              playUrl?: string;
              url?: string;
              parse?: number;
              jx?: number;
              /** 多数源给对象，部分源（pianku 系）给 JSON 字符串。 */
              header?: Record<string, string> | string;
            } | null;
            const candidate = String(played?.playUrl || played?.url || "");
            const parseFlag = Number(played?.parse ?? 0);
            const jxFlag = Number(played?.jx ?? 0);
            const header = normalizeHeaders(played?.header);
            ua = header["User-Agent"] || header["user-agent"];
            referer = header["Referer"] || header["referer"];
            cookie = header["Cookie"] || header["cookie"];

            if (/^https?:\/\//i.test(candidate)) {
              // `127.0.0.1:9978/proxy?do=py…` 由宿主实现（spider.proxy 转发），
              // `resolve_play` 会识别本机代理地址并原样透传。
              const isLocalProxy =
                /^https?:\/\/127\.0\.0\.1:\d+\/(proxy|proxy2)\b/i.test(candidate);
              if (isLocalProxy) {
                targetUrl = candidate;
              } else if (parseFlag !== 0 || jxFlag !== 0) {
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
                    targetUrl = hit.url;
                    for (const [name, value] of hit.headers ?? []) {
                      const lower = name.toLowerCase();
                      if (lower === "user-agent") {
                        ua = value;
                      } else if (lower === "referer") {
                        referer = value;
                      } else if (lower === "cookie") {
                        cookie = value;
                      }
                    }
                    setSwitchTip(`解析来自「${hit.parser}」`);
                  }
                } catch {
                  // 解析池全失败：保留原地址，由 resolve_play 的嗅探兜底。
                  targetUrl = candidate;
                }
              } else {
                targetUrl = candidate;
              }
            }
          } catch {
            // CMS / 未实现 playerContent 的源：沿用原始地址。
          }
        }
        const result = await api.resolvePlay({ siteKey, url: targetUrl, ua, referer, cookie });
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
