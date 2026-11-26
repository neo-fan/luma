/**
 * 解码器挂载（hls.js / mpegts.js）。
 *
 * 从 `usePlayerEngine` 搬出来：这两段是「把代理后的地址接到 <video> 上」的完整
 * 生命周期，与实例装配一样属于播放内核的外围，不该混在同一个 effect 里。
 *
 * 边界说明：ArtPlayer 的 `customType` 在实例构造时同步调用，因此这里的
 * `host.instance` 就是那个 ArtPlayer 实例的窄化视图（只用到 hls/plugins/
 * controls/setting/on）。清晰度控件的摘除、码率角标、海报退场、判死交棒都通过
 * host 回调回给内核 —— 那些状态本来就归内核。
 */
import Hls from "hls.js";
import type { BufferCodecsData } from "hls.js";
import { describeHlsError, isTimingFailure } from "../lib/playErrors";
import { hlsLoadBudget } from "../lib/hlsBudget";
import { hasMediaStopped } from "../lib/mediaMeasure";
import { readPlayerPrefs, writePlayerPrefs } from "../lib/playerPrefs";
import { EXTERNAL_PLAY_ENABLED, PLAY_FAILURE_HINT } from "../lib/features";
import { errorMessage } from "../lib/invoke";
import type { FailoverCause } from "../lib/sessionFailover";

/** ArtPlayer 实例上被解码器用到的那几项。 */
export interface DecoderInstance {
  hls?: unknown;
  plugins?: { artplayerPluginHlsControl?: { update?: () => void } };
  controls?: { remove(name: string): void };
  setting?: { remove(name: string): void };
  on(event: "destroy", handler: () => void): void;
  /** once 与 on 同签名：destroy 只需触发一次，避免复用实例上累积处理器。 */
  once(event: "destroy", handler: () => void): void;
}

interface DecoderMediaView {
  video: HTMLVideoElement;
  instance: DecoderInstance;
  isLive: boolean;
  /** 实例身份：切换/卸载后旧解码器的回调不许再动当前 <video>。 */
  isCurrent: () => boolean;
}

export interface DecoderHost {
  media: DecoderMediaView;
  identity: { siteKey: string; vodId: string };
  signals: {
    /** 源在动（清单/分片/缓冲任何一步真实拿到数据）。 */
    alive: () => void;
    /** 重渲染分辨率 / 码率角标。 */
    meta: () => void;
    /** 分片实测码率（kbps），由内核做平滑与是否重渲染的判断。 */
    bitrate: (sampleKbps: number) => void;
    /** 清单声明的高度，真实帧尺寸到达前的兜底。 */
    declaredHeight: (height: number) => void;
  };
  ui: {
    error: (message: string) => void;
    /** 播放器内短提示（ArtPlayer notice）：只用于「正在重连」这类过程态。 */
    notice: (text: string) => void;
    /** 单码率源：摘掉「清晰度：自动」这类假选项（控件与设置项一起）。 */
    disableQuality: () => void;
    /** 失败路径硬撤冻结帧，绝不让静帧盖住后续画面。 */
    dropPoster: () => void;
  };
  session: {
    hasPlayed: () => boolean;
    failover: (cause: FailoverCause, detail: string) => void;
    /**
     * 只作废「这一集解析出来的地址」，不动会话状态。
     *
     * 已经出画之后的致命错误不判线路死（多半只是网络抖），但**地址本身要作废**：
     * 否则三分钟内的下一次点击会命中同一条坏地址，表现成「刚点开就失败」。
     */
    invalidateAddress: () => void;
  };
  lifecycle: {
    /** 内核用它保证「先停旧解码器再挂新的」，也供卸载时兜底。 */
    setTeardown: (fn: () => void) => void;
    /** 观察窗这类定时器交给切换句柄回收器，新一轮切换与卸载各收一次。 */
    trackDisposer: (dispose: () => void) => void;
  };
  log: (stage: string, context: Record<string, unknown>) => void;
}

/** mpegts.js 的结构面（只用到这几个方法，避免依赖它的完整类型）。 */
interface MpegtsLike {
  isSupported: () => boolean;
  Events: { ERROR: string };
  createPlayer: (
    media: { type: string; url: string; isLive: boolean },
    config: Record<string, unknown>,
  ) => FlvPlayerLike;
}

interface FlvPlayerLike {
  attachMediaElement: (el: HTMLVideoElement) => void;
  load: () => void;
  destroy: () => void;
  on: (event: string, handler: (...args: string[]) => void) => void;
}

/**
 * 就地重连的退避表（毫秒）。数组长度即「一次连续故障最多重连几次」。
 *
 * 为什么要有这一步：hls.js 报 fatal 后**已经停止拉流**。对「上游一个字节都不回」
 * 这类失败，看门狗只能得出 `unknown`（证据不足，不判死），画面于是永久停在转圈；
 * 刷新页面能好，说明地址没坏、断的是这一次请求，所以按退避就地重连。
 *
 * 重连只碰解码器自己：不换地址、不换线路、不动上层状态，所以与「切换只由 UI
 * 发起」不冲突；预算用完才把失败交上去。
 */
const RETRY_DELAYS_MS = [800, 1_600, 3_200, 6_400] as const;

/**
 * 纯音频线路的确认窗：只等「视频轨会不会随后出现」这个外部信号，
 * 不是用时间猜自己的 effect 有没有跑完。TS 源可能先报音轨、后报视频轨
 * （独立音轨尤其常见），仅凭第一次 `BUFFER_CODECS` 就下结论会误杀正常流。
 */
const AUDIO_ONLY_CONFIRM_MS = 5_000;

/**
 * HLS：清单/层级/分片三级超时都按「首个分片可能要下 20 秒」设定（见 hlsBudget）。
 *
 * WebView2 的 canPlayType 对 mpegurl 返回 "maybe"，但真把 m3u8 塞给 <video> 会以
 * MEDIA_ERR_SRC_NOT_SUPPORTED 失败，所以只在 hls.js 不可用时才退回原生。
 */
export function attachHlsDecoder(host: DecoderHost, url: string): void {
  const { video, instance, isLive } = host.media;
  if (!Hls.isSupported()) {
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
    } else {
      host.ui.error(`当前环境不支持 HLS 内置播放，${PLAY_FAILURE_HINT}。`);
    }
    return;
  }
  const hls = new Hls(hlsLoadBudget(isLive));
  hls.loadSource(url);
  hls.attachMedia(video);
  // hls-control 插件约定从 art.hls 读 levels / currentLevel。
  instance.hls = hls;
  let disposed = false;
  /**
   * 单次连续故障里已经重连过几次。分片真下来了就清零：预算衡量的是
   * 「这一轮连续失败」，不是「这一集累计失败」——播了十分钟再抖一次，
   * 应该重新拥有完整预算。
   */
  let retryCount = 0;
  let retryTimer: number | null = null;
  const cancelRetry = () => {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
  /** 纯音频判定用的轨道观察：等得到视频轨就撤销，等不到才报结论。 */
  const seenTracks = new Set<"audio" | "video">();
  let audioOnlyTimer: number | null = null;
  let audioOnlyReported = false;
  const cancelAudioOnlyCheck = () => {
    if (audioOnlyTimer !== null) {
      window.clearTimeout(audioOnlyTimer);
      audioOnlyTimer = null;
    }
  };
  const destroy = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    cancelRetry();
    cancelAudioOnlyCheck();
    hls.destroy();
  };
  host.lifecycle.setTeardown(destroy);
  // `once`：原地换集/换线会复用同一个 ArtPlayer 实例并重新走这里，用 `on`
  // 会在实例上累积一串 destroy 处理器（每集 +1 个闭包，钉住已销毁的 Hls）。
  instance.once("destroy", destroy);
  // 生命信号：清单、子清单、分片任何一步真实拿到数据都算「源在动」，
  // 即便此刻还没凑够一帧解码（冷启大分片就是这个状态）。
  const noteAlive = () => {
    if (!disposed) {
      host.signals.alive();
    }
  };
  hls.on(Hls.Events.MANIFEST_LOADING, noteAlive);
  hls.on(Hls.Events.MANIFEST_LOADED, noteAlive);
  hls.on(Hls.Events.LEVEL_LOADED, noteAlive);
  hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
    noteAlive();
    // 有分片真下来了 = 上一轮断流已经结束，重连预算重新给满。
    retryCount = 0;
    cancelRetry();
    // 实测码率：分片真实字节 / 该分片覆盖的媒体时长。
    const bytes = data.frag?.stats?.total;
    const seconds = data.frag?.duration;
    if (!bytes || !seconds || seconds <= 0) {
      return;
    }
    host.signals.bitrate((bytes * 8) / seconds / 1000);
  });
  hls.on(Hls.Events.FRAG_BUFFERED, noteAlive);
  /**
   * 直播纯音频线路：hls.js 不会报错（音轨正常在走），<video> 也只是
   * `videoWidth=0`，用户看到的就是「有声音、一直黑屏」。这里按实际解出的
   * 编码轨道判定，不按 URL 关键字猜——否则每换一份带 `/audio/` 路径的
   * 订阅都要改代码。观察窗只用来等「视频轨是否随后出现」这个外部信号。
   */
  hls.on(Hls.Events.BUFFER_CODECS, (_event, data: BufferCodecsData) => {
    if (disposed || audioOnlyReported || !host.media.isLive) {
      return;
    }
    if (data.video || data.audiovideo) {
      seenTracks.add("video");
      cancelAudioOnlyCheck();
      return;
    }
    if (!data.audio || seenTracks.has("video")) {
      return;
    }
    seenTracks.add("audio");
    if (audioOnlyTimer !== null) {
      return;
    }
    audioOnlyTimer = window.setTimeout(() => {
      audioOnlyTimer = null;
      if (disposed || seenTracks.has("video") || !seenTracks.has("audio")) {
        return;
      }
      audioOnlyReported = true;
      host.log("hls audio-only line", {
        siteKey: host.identity.siteKey,
        vodId: host.identity.vodId,
      });
      // 明确交给用户换线：线路本身是纯音频，刷新 / 重连都救不回画面。
      host.ui.error("该线路是纯音频流，没有视频画面");
      host.ui.notice("这条线路只有声音，请切换线路");
    }, AUDIO_ONLY_CONFIRM_MS);
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    if (disposed) {
      return;
    }
    // 插件默认只在 ready / restart 读 levels；manifest 解析完再刷一次，
    // 避免首次播放时清晰度列表还是空的。
    instance.plugins?.artplayerPluginHlsControl?.update?.();
    // 单码率的源不该出现「清晰度：自动」这种假选项：插件只要看到 levels 非空
    // 就会挂控件，而 TVBox 源绝大多数只有一档。
    const levels = new Set(
      hls.levels.map((level) => `${level.height ?? 0}|${level.bitrate ?? 0}|${level.name ?? ""}`),
    );
    if (levels.size <= 1) {
      host.ui.disableQuality();
    }
    // 清单里的 RESOLUTION 只有这一时刻拿得到；没有声明值（多数源）就保持 0。
    const heights = hls.levels
      .map((level) => Math.round(level.height ?? 0))
      .filter((height) => height > 0);
    if (heights.length > 0) {
      host.signals.declaredHeight(Math.max(...heights));
    }
    host.signals.meta();
    // 上次选过清晰度且这一集仍有同档位时才套用，否则保持自动。
    const wanted = readPlayerPrefs().height;
    if (wanted) {
      const index = hls.levels.findIndex((level) => Math.round(level.height ?? 0) === wanted);
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
    // 换档后画面尺寸会变；`resize` 事件本身也会到，这里补一枪避免某些
    // 编码尺寸相同（只变码率）时角标读到旧值。
    host.signals.meta();
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
  /**
   * 就地重连同一条流（不换地址、不换线路）。返回 false 表示这一轮预算用完。
   *
   * `reloadManifest` 决定用哪个动作恢复——hls.js 里两者不等价：
   * `startLoad()` 在 `levels` 为空时直接 `return`（清单压根没拿到，它无事可做），
   * 这时必须 `loadSource(url)` 重新走一遍 MANIFEST_LOADING。
   *
   * 刻意不记生命信号：重连只是「再试一次」，不是「有数据在流动」，记成生命
   * 信号会让反复断流的死线永远逃过看门狗。
   */
  const retryInPlace = (reloadManifest: boolean): boolean => {
    if (retryCount >= RETRY_DELAYS_MS.length) {
      return false;
    }
    const delay = RETRY_DELAYS_MS[retryCount];
    retryCount += 1;
    cancelRetry();
    host.ui.notice(
      retryCount === 1
        ? "网络波动，正在重连…"
        : `网络波动，正在重连（第 ${retryCount} 次）…`,
    );
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      if (disposed) {
        return;
      }
      if (reloadManifest) {
        hls.loadSource(url);
        return;
      }
      // `startLoad()` 会让 stream-controller 丢掉失败分片的状态重新拉，
      // 这正是 hls.js 官方给的 network-error 恢复动作。
      hls.startLoad();
    }, delay);
    return true;
  };
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (disposed || !data.fatal) {
      return;
    }
    // `manifestParsingError` 这类枚举名对用户没有意义：它八成意味着
    // 「源返回的不是 m3u8」（网盘解析接口 200 + JSON），文案要指向换源。
    const reason = describeHlsError(data.details);
    const timing = isTimingFailure(data.details);
    host.log("hls fatal", {
      siteKey: host.identity.siteKey,
      vodId: host.identity.vodId,
      details: String(data.details ?? ""),
      type: String(data.type ?? ""),
    });
    // 网络/超时这一族：hls 已经放弃拉流，但地址本身多半没坏——先就地重连，
    // 预算内成功就不用惊动用户，更不会把正在看的线路切走。
    // 内容型致命错误（清单不是 m3u8、编码不支持）重连没有意义，直接上报。
    if (timing && retryInPlace(String(data.details ?? "").startsWith("manifest"))) {
      return;
    }
    host.ui.dropPoster();
    if (host.session.hasPlayed()) {
      // 已经在播的流突然致命：网络抖一下的概率远高于线路真坏了，
      // 自动跳走会把用户正在看的内容切没。只提示，由用户决定。
      // 这一条地址作废掉，但会话与线路都不判死。
      host.session.invalidateAddress();
      host.ui.error(
        `网络波动导致播放中断：${reason}，已重连 ${RETRY_DELAYS_MS.length} 次仍未恢复`,
      );
      return;
    }
    // hls 自己报致命 = 有明确证据，交给状态机判死；文案、撤海报与交棒
    // 由内核唯一的交棒实现统一做一次。
    host.session.failover("hlsFatal", reason);
  });
}

/**
 * FLV：WebView2 没有内置 FLV 解码（<video> 直接吃 flv 会 SRC_NOT_SUPPORTED），
 * 必须用 mpegts.js 走 MSE 分包。按需 import：只有真播 FLV 时才加载，
 * 不拖累 HLS / 直链的播放页体积。
 */
export function attachFlvDecoder(host: DecoderHost, url: string): void {
  const { video, instance, isLive } = host.media;
  let player: FlvPlayerLike | null = null;
  let disposed = false;
  const destroy = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    player?.destroy();
    player = null;
  };
  host.lifecycle.setTeardown(destroy);
  // 同 HLS 分支：`once` 避免原地换台时在复用实例上累积 destroy 处理器。
  instance.once("destroy", destroy);
  void (async () => {
    try {
      const mod = (await import("mpegts.js")) as unknown as { default?: MpegtsLike } & MpegtsLike;
      // mpegts.js 的 d.ts 用 `export default Mpegts` 导出一个命名空间，
      // `import("mpegts.js").default` 取不到类型；运行时 CJS 互操作后
      // default 才是本体，这里两个都兜一下。
      const mpegts = mod.default ?? mod;
      if (disposed) {
        return;
      }
      if (!mpegts.isSupported()) {
        host.ui.error(
          EXTERNAL_PLAY_ENABLED
            ? "当前环境不支持 FLV 内置播放，已改用外部播放。"
            : "当前环境不支持 FLV 内置播放，请换一条线路或换个源后重试。",
        );
        return;
      }
      player = mpegts.createPlayer(
        { type: "flv", url, isLive },
        {
          enableWorker: true,
          // 直播要低延迟；点播留一点缓冲避免卡顿。
          enableStashBuffer: !isLive,
          lazyLoad: !isLive,
          stashInitialSize: 128,
        },
      );
      player.attachMediaElement(video);
      player.load();
      // 生命信号：FLV 的加载完成事件，避免「分片在灌但缓冲还没长」被误判。
      player.on("LOADING_COMPLETE", () => {
        if (!disposed) {
          host.signals.alive();
        }
      });
      player.on(mpegts.Events.ERROR, (_type: string, detail: string) => {
        if (disposed) {
          return;
        }
        host.log("flv error", { siteKey: host.identity.siteKey, vodId: host.identity.vodId, detail });
        // 直播 FLV 断流几乎总是「先 EOF 再重连」：抛 `UnrecoverableEarlyEof` 那一刻，
        // 缓冲里往往还有几秒画面在正常解码。此时直接挂「播放失败」与用户看到的
        // 事实相反，所以给一个观察窗：还在走就交给看门狗按证据判死。
        if (isLive) {
          const startedAt = video.currentTime;
          const observe = window.setTimeout(() => {
            if (disposed || !host.media.isCurrent()) {
              return;
            }
            if (
              !hasMediaStopped({
                paused: video.paused,
                readyState: video.readyState,
                currentTime: video.currentTime,
                startedAt,
              })
            ) {
              return;
            }
            host.session.failover("flvInterrupted", detail);
          }, 4_000);
          host.lifecycle.trackDisposer(() => window.clearTimeout(observe));
          return;
        }
        // 撤海报 / 文案 / 交棒统一在内核唯一的交棒实现里。
        host.session.failover("flvFatal", detail);
      });
      void video.play().catch(() => {
        // 自动播放被拦截时保留控件，用户点一下即可。
      });
    } catch (err) {
      host.ui.error(`FLV 解码组件加载失败：${errorMessage(err)}`);
    }
  })();
}
