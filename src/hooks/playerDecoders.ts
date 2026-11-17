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
    /** 单码率源：摘掉「清晰度：自动」这类假选项（控件与设置项一起）。 */
    disableQuality: () => void;
    /** 失败路径硬撤冻结帧，绝不让静帧盖住后续画面。 */
    dropPoster: () => void;
  };
  session: {
    hasPlayed: () => boolean;
    failover: (cause: FailoverCause, detail: string) => void;
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
  const destroy = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    hls.destroy();
  };
  host.lifecycle.setTeardown(destroy);
  instance.on("destroy", destroy);
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
    // 实测码率：分片真实字节 / 该分片覆盖的媒体时长。
    const bytes = data.frag?.stats?.total;
    const seconds = data.frag?.duration;
    if (!bytes || !seconds || seconds <= 0) {
      return;
    }
    host.signals.bitrate((bytes * 8) / seconds / 1000);
  });
  hls.on(Hls.Events.FRAG_BUFFERED, noteAlive);
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
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (disposed || !data.fatal) {
      return;
    }
    // `manifestParsingError` 这类枚举名对用户没有意义：它八成意味着
    // 「源返回的不是 m3u8」（网盘解析接口 200 + JSON），文案要指向换源。
    const reason = describeHlsError(data.details);
    host.log("hls fatal", {
      siteKey: host.identity.siteKey,
      vodId: host.identity.vodId,
      details: String(data.details ?? ""),
      type: String(data.type ?? ""),
    });
    if (isTimingFailure(data.details)) {
      // 只是「等太久」：不换源、不报红条，交给看门狗复核。
      // 刻意不记生命信号：这只是「没等到」，不是「有数据在流动」，
      // 记成生命信号会让反复超时的死线永远逃过看门狗。
      return;
    }
    host.ui.dropPoster();
    if (host.session.hasPlayed()) {
      // 已经在播的流突然致命：网络抖一下的概率远高于线路真坏了，
      // 自动跳走会把用户正在看的内容切没。只提示，由用户决定。
      host.ui.error(`网络波动导致播放中断：${reason}，可点刷新重试`);
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
  instance.on("destroy", destroy);
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
