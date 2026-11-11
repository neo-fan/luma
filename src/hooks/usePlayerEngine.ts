/**
 * 播放内核（从 PlayerPage 的 effect(532–829) 原样抽出，逻辑体一字未改）。
 *
 * ArtPlayer 负责控件与交互，解码仍交给 hls.js / mpegts.js；反代地址
 * （127.0.0.1:9978/proxy?…）没有扩展名，必须显式传 type，否则 customType
 * 不命中，m3u8 会被直接塞给 <video> 而失败。
 *
 * ⚠️ 本文件是高频缺陷区，抽出时只把「外部 state / ref / setter」改成参数，
 * 内部时序（倍速静默期、字段隔离、身份校验、stalled watchdog、mpv 兜底、
 * cleanup 顺序）保持逐字一致。CDP 探针 probe_playback_ux 依赖两处源码特征
 * （videoRef 身份校验、倍速字段隔离写入）做 dev 模块新鲜度自检；改动这两处
 * 逻辑时须同步更新探针的 fetch 目标，且不要在注释里复刻同样的字面串，
 * 否则会让自检形同虚设。
 */
import { useEffect } from "react";
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from "react";
import Artplayer from "artplayer";
import artplayerPluginHlsControl from "artplayer-plugin-hls-control";
import Hls from "hls.js";
import { api, errorMessage } from "../lib/invoke";
import { log } from "../lib/logger";
import { readPlayerPrefs, writePlayerPrefs } from "../lib/playerPrefs";
import type { PlayResolved } from "../types/tvbox";

/** 内置播放器能直接解码的 kind；page/share 之类要交给解析池或外部播放。 */
export const BUILTIN_KINDS = ["hls", "flv", "file"];

/**
 * mpegts.js 的最小类型面。
 *
 * 它的 d.ts 用 `export default Mpegts` 导出一个命名空间，`import("mpegts.js")`
 * 的类型查询取不到 default（TS2694），而运行时的 CJS 互操作又确实挂在
 * `default` 上。与其和第三方声明文件较劲，这里只声明真正用到的四个成员。
 */
interface FlvPlayerLike {
  attachMediaElement(element: HTMLMediaElement): void;
  load(): void;
  destroy(): void;
  on(event: string, handler: (type: string, detail: string) => void): void;
}

interface MpegtsLike {
  isSupported(): boolean;
  createPlayer(
    config: { type: string; url: string; isLive?: boolean },
    options?: Record<string, unknown>,
  ): FlvPlayerLike;
  Events: { ERROR: string };
}

export interface UsePlayerEngineArgs {
  /** ArtPlayer 挂载点；实例会在这个容器里生成真正的 <video>。 */
  containerRef: RefObject<HTMLDivElement>;
  /** ArtPlayer 托管的原生 <video>；切集/换源前由调用方置空以失格旧回调。 */
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  /** 卸载时 ArtPlayer 会清掉 src，进度必须独立留一份快照。 */
  lastMediaRef: MutableRefObject<{ positionMs: number; durationMs?: number }>;
  /** 解码失败只自动转 mpv 一次。 */
  mpvTried: MutableRefObject<boolean>;
  /** 跨站换源与 stalled watchdog 的并发闸门。 */
  failoverStarted: MutableRefObject<boolean>;
  lineSwitchStarted: MutableRefObject<boolean>;
  /** 线路切换失败后的兜底（整站找同名影片）；用 ref 转发避免本 effect 因 lines 重挂。 */
  switchOrFailoverRef: MutableRefObject<() => Promise<void>>;
  resolved: PlayResolved | null;
  /** 新一轮地址解析中：此时旧 `resolved` 属于上一个源，不能再建播放实例。 */
  resolving: boolean;
  siteKey: string;
  vodName: string;
  vodId: string;
  setVideoError: Dispatch<SetStateAction<string>>;
}

/** 挂载 / 销毁播放内核。纯 effect hook，无返回值。 */
export function usePlayerEngine({
  containerRef,
  videoRef,
  lastMediaRef,
  mpvTried,
  failoverStarted,
  lineSwitchStarted,
  switchOrFailoverRef,
  resolved,
  resolving,
  siteKey,
  vodName,
  vodId,
  setVideoError,
}: UsePlayerEngineArgs): void {
  useEffect(() => {
    const container = containerRef.current;
    // 换源时 props 先变、`usePlayResolution` 的 setResolving(true) 要到 effect
    // 阶段才生效；若不显式拦住，本 effect 会用「上一个源的 resolved」再建一个
    // 播放器，与随后解析完成的新实例叠成双流双声。非内置 kind（page/share）
    // 也在这里挡掉，避免容器常驻后把网页地址塞给 <video>。
    if (
      !container ||
      !resolved ||
      resolving ||
      !BUILTIN_KINDS.includes(resolved.kind)
    ) {
      return;
    }

    mpvTried.current = false;
    lastMediaRef.current = { positionMs: 0 };
    // 音量 / 倍速跨集沿用：连看 36 集不该每集重新调一次。
    const prefs = readPlayerPrefs();
    /**
     * 解码器（hls.js / mpegts.js）的直接销毁句柄。
     *
     * 不能只依赖 ArtPlayer 的 `instance.on("destroy")`：换源时容器若已被摘掉，
     * ArtPlayer 的 destroy 链可能提前中断，hls 继续拉流并输出音频，与新实例
     * 叠成「两个声音」。cleanup 里先手动停流、再调这里、最后才 art.destroy()，
     * 用 `disposed` 保证幂等（ArtPlayer 的 destroy 事件仍会兜底触发一次）。
     */
    let teardownDecoders: (() => void) | null = null;
    const art = new Artplayer({
      container,
      url: resolved.proxyUrl,
      type: resolved.kind === "hls" ? "m3u8" : resolved.kind,
      lang: "zh-cn",
      theme: "#e50914",
      volume: prefs.volume,
      isLive: siteKey === "live",
      autoPlayback: false,
      screenshot: false,
      hotkey: true,
      playbackRate: true,
      aspectRatio: true,
      setting: true,
      pip: true,
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      moreVideoAttr: { playsInline: true },
      plugins:
        resolved.kind === "hls"
          ? [
              artplayerPluginHlsControl({
                quality: {
                  control: true,
                  setting: true,
                  title: "清晰度",
                  auto: "自动",
                  // 多数 TVBox 源是单码率且不带 RESOLUTION，插件默认会显示
                  // "0P"；无分辨率时退回码率 / 片源自定义名 / 原画。
                  getName: (level) => {
                    const item = level as { name?: string; height?: number; bitrate?: number };
                    if (item.height && item.height > 0) {
                      return `${item.height}P`;
                    }
                    if (item.bitrate && item.bitrate > 0) {
                      return `${Math.round(item.bitrate / 1000)}kbps`;
                    }
                    return item.name || "原画";
                  },
                },
                audio: { control: false, setting: true, title: "音轨", auto: "自动" },
              }),
            ]
          : [],
      customType: {
        m3u8: (video, url, instance) => {
          // WebView2 的 canPlayType 会对 mpegurl 返回 "maybe"，但真正把
          // m3u8 塞给 <video> 会以 MEDIA_ERR_SRC_NOT_SUPPORTED 失败。
          if (!Hls.isSupported()) {
            if (video.canPlayType("application/vnd.apple.mpegurl")) {
              video.src = url;
            } else {
              setVideoError("当前环境不支持 HLS 内置播放，请使用外部播放。");
            }
            return;
          }
          const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
          hls.loadSource(url);
          hls.attachMedia(video);
          // hls-control 插件约定从 art.hls 读 levels / currentLevel。
          instance.hls = hls;
          let disposed = false;
          teardownDecoders = () => {
            if (disposed) {
              return;
            }
            disposed = true;
            hls.destroy();
          };
          instance.on("destroy", () => teardownDecoders?.());
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (disposed) {
              return;
            }
            // 插件默认只在 ready / restart 读 levels；manifest 解析完再刷一次，
            // 避免首次播放时清晰度列表还是空的。
            const control = instance.plugins.artplayerPluginHlsControl as
              | { update?: () => void }
              | undefined;
            control?.update?.();
            // 上次选过清晰度且这一集仍有同档位时才套用，否则保持自动。
            const wanted = readPlayerPrefs().height;
            if (wanted) {
              const index = hls.levels.findIndex(
                (level) => Math.round(level.height ?? 0) === wanted,
              );
              if (index >= 0) {
                hls.currentLevel = index;
              }
            }
            void video.play().catch(() => {
              // 自动播放被拦截时保留控件，用户点一下即可。
            });
          });
          hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
            if (disposed) {
              return;
            }
            // 只在用户手动选档时记住；自动档每次切换都是不同码率，
            // 记下来会让下次错误地固定到某一档。
            if (hls.autoLevelEnabled) {
              return;
            }
            const level = hls.levels[data.level];
            if (level?.height) {
              writePlayerPrefs({ height: level.height });
            }
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (disposed || !data.fatal) {
              return;
            }
            const reason = data.details ? String(data.details) : "未知错误";
            setVideoError(`HLS 播放失败：${reason}`);
            void switchOrFailoverRef.current();
          });
        },
        flv: (video, url, instance) => {
          // WebView2 没有内置 FLV 解码（<video> 直接吃 flv 会 SRC_NOT_SUPPORTED），
          // 必须用 mpegts.js 走 MSE 分包。按需 import：只有真播 FLV 时才加载，
          // 不拖累 HLS / 直链的播放页体积。
          let player: FlvPlayerLike | null = null;
          let disposed = false;
          teardownDecoders = () => {
            if (disposed) {
              return;
            }
            disposed = true;
            player?.destroy();
            player = null;
          };
          instance.on("destroy", () => teardownDecoders?.());
          void (async () => {
            try {
              const mod = (await import("mpegts.js")) as unknown as {
                default?: MpegtsLike;
              } & MpegtsLike;
              // mpegts.js 的 d.ts 用 `export default Mpegts` 导出一个命名空间，
              // `import("mpegts.js").default` 取不到类型；运行时 CJS 互操作后
              // default 才是本体，这里两个都兜一下。
              const mpegts = mod.default ?? mod;
              if (disposed) {
                return;
              }
              if (!mpegts.isSupported()) {
                setVideoError("当前环境不支持 FLV 内置播放，已改用外部播放。");
                return;
              }
              player = mpegts.createPlayer(
                { type: "flv", url, isLive: siteKey === "live" },
                {
                  enableWorker: true,
                  // 直播要低延迟；点播留一点缓冲避免卡顿。
                  enableStashBuffer: siteKey !== "live",
                  lazyLoad: siteKey !== "live",
                  stashInitialSize: 128,
                },
              );
              player.attachMediaElement(video);
              player.load();
              player.on(mpegts.Events.ERROR, (_type: string, detail: string) => {
                if (disposed) {
                  return;
                }
                setVideoError(`FLV 播放失败：${detail}`);
                void switchOrFailoverRef.current();
              });
              void video.play().catch(() => {
                // 自动播放被拦截时保留控件，用户点一下即可。
              });
            } catch (err) {
              setVideoError(`FLV 解码组件加载失败：${errorMessage(err)}`);
            }
          })();
        },
      },
    });

    const video = art.video;
    videoRef.current = video;
    video.playbackRate = prefs.rate;
    /**
     * 倍速初始化静默期。
     *
     * 我们在 ArtPlayer 构造之后才手动设 playbackRate（构造参数没有倍速项），
     * 但 ArtPlayer 自身的倍速设置初始化是异步的、晚于这一步，会把新 <video>
     * 的 playbackRate 覆盖回默认 1 并触发 ratechange。若照单记录，就会把系统
     * 默认值 1 当成用户偏好写进 storage，导致跨集倍速丢失（实测）。
     *
     * 处理：挂载后 2 秒内不接受 ratechange 写入（这期间的变更都属于初始化
     * 噪声）；并在 1.2 秒时把记忆的倍速重放回 video——重放自身触发的
     * ratechange 仍在静默期内被忽略，只纠正 video 实际值、不污染 storage。
     * 静默期之后用户手动点倍速，才正常落盘。
     */
    const rateReadyAt = Date.now() + 2000;
    const rateReplay = window.setTimeout(() => {
      if (videoRef.current !== video) {
        return;
      }
      const wanted = readPlayerPrefs().rate;
      if (Math.abs(video.playbackRate - wanted) > 0.01) {
        video.playbackRate = wanted;
      }
    }, 1200);
    // 音量拖动会连发 volumechange，做 500ms 前缘节流；被跳过的最后一次变更
    // 用 trailing 定时器补写，否则「拖完音量马上切集」会丢最终值。倍速是手动
    // 点档的低频事件，立即落盘。两者各写各的字段：音量事件绝不碰 rate、倍速
    // 事件绝不碰 volume——否则拖音量时若 playbackRate 尚未就绪就会把 rate 写坏。
    //
    // 回调都校验 `videoRef.current === video`：切集/换源前置空引用后，旧
    // <video> 销毁触发的变更（已失格）不会覆盖当前偏好。
    let volumeWrittenAt = 0;
    let volumeTrailing: number | null = null;
    const persistVolume = () => {
      if (videoRef.current !== video) {
        return;
      }
      const now = Date.now();
      if (now - volumeWrittenAt < 500) {
        if (volumeTrailing !== null) {
          window.clearTimeout(volumeTrailing);
        }
        volumeTrailing = window.setTimeout(() => {
          volumeTrailing = null;
          if (videoRef.current !== video) {
            return;
          }
          volumeWrittenAt = Date.now();
          writePlayerPrefs({ volume: video.volume });
        }, 500);
        return;
      }
      volumeWrittenAt = now;
      writePlayerPrefs({ volume: video.volume });
    };
    const persistRate = () => {
      if (videoRef.current !== video) {
        return;
      }
      // 静默期内 ArtPlayer 会把 playbackRate 覆盖成默认 1：那不是用户选择，
      // 不记录，并即时纠正回记忆值，避免「切集后前 1.2s 是 1 倍速、随后突然
      // 加速」的抖变。设回后再次触发 ratechange，但值已相等，递归自然终止。
      if (Date.now() < rateReadyAt) {
        const wanted = readPlayerPrefs().rate;
        if (Math.abs(video.playbackRate - wanted) > 0.01) {
          video.playbackRate = wanted;
        }
        return;
      }
      writePlayerPrefs({ rate: video.playbackRate });
    };
    video.addEventListener("volumechange", persistVolume);
    video.addEventListener("ratechange", persistRate);

    const onError = () => {
      const mediaError = video.error;
      // 3 = MEDIA_ERR_DECODE, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED. WebView2 常见于
      // HEVC：换源也救不了同一编码，直接交给随包 mpv（规格 T-30 自动兜底）。
      if (mediaError && (mediaError.code === 3 || mediaError.code === 4) && !mpvTried.current) {
        mpvTried.current = true;
        log.warn("mpv fallback", { siteKey, vodId, mediaCode: mediaError.code });
        setVideoError("浏览器无法解码该视频，已自动交给 mpv 播放…");
        void api
          .mpvPlay(resolved.url, vodName, resolved.headers)
          .catch((err) => {
            setVideoError(`mpv 启动失败：${errorMessage(err)}`);
            void switchOrFailoverRef.current();
          });
        return;
      }
      setVideoError("播放器加载失败，可尝试外部播放。");
      void switchOrFailoverRef.current();
    };
    video.addEventListener("error", onError);

    // 死 CDN 会让 hls.js 无限重试却不触发 fatal，画面永远停在 00:00。
    // 12 秒仍没拿到首帧就视作线路不可用，主动切线路 / 换源。
    const stallTimer = window.setTimeout(() => {
      if (!BUILTIN_KINDS.includes(resolved.kind)) {
        return;
      }
      if (video.readyState >= 2 || failoverStarted.current || lineSwitchStarted.current) {
        return;
      }
      setVideoError("当前线路长时间无法加载，正在尝试其它线路…");
      void switchOrFailoverRef.current();
    }, 12_000);

    return () => {
      window.clearTimeout(stallTimer);
      window.clearTimeout(rateReplay);
      if (volumeTrailing !== null) {
        window.clearTimeout(volumeTrailing);
      }
      video.removeEventListener("error", onError);
      video.removeEventListener("volumechange", persistVolume);
      video.removeEventListener("ratechange", persistRate);
      // 只补写音量：拖动可能被节流/定时器延后，卸载时补一次最终值。
      // 倍速绝不能在这里覆盖——ended 触发卸载那一刻 video.playbackRate 可能已被
      // 播放内核重置为 1（实测），写回会抹掉用户刚选的倍速。倍速由 persistRate
      // 在变更时立即落盘，无需、也不允许在卸载时再写。
      writePlayerPrefs({ volume: video.volume });
      // 先置空引用，避免 destroy 过程中的 video:error 再触发换源。
      videoRef.current = null;
      // 换源 / 切集时的硬停流：ArtPlayer.destroy() 只保证自己的模板被移除，
      // 而 hls.js / mpegts.js 是独立 attach 到 <video> 的 MSE 源。若容器已被
      // React 摘掉或 destroy 链中断，旧解码器会继续灌数据 → 「两个声音」。
      // 顺序：先停 <video>（pause + 清 src + load 冲掉缓冲），再销毁解码器，
      // 最后销毁 ArtPlayer（它的 destroy 事件会幂等兜底再调一次 teardown）。
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // 已 detach 的 <video> 可能抛 InvalidStateError，忽略即可。
      }
      teardownDecoders?.();
      art.destroy();
    };
    // `resolving` 必须进依赖：新一轮解析开始时要立刻卸载旧内核，不能等
    // `setResolved(null)` 落地（两者都是 effect 阶段的 setState，晚一帧）。
    // 其余都是稳定引用（ref / setter），或仅用于日志与回调闭包（vodId）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, resolving, siteKey, vodName]);
}
