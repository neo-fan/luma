/**
 * 播放内核（从 PlayerPage 的 effect(532–829) 原样抽出，逻辑体一字未改）。
 *
 * ArtPlayer 负责控件与交互，解码仍交给 hls.js / mpegts.js；反代地址
 * （127.0.0.1:9978/proxy?…）没有扩展名，必须显式传 type，否则 customType
 * 不命中，m3u8 会被直接塞给 <video> 而失败。
 *
 * ⚠️ 本文件是高频缺陷区，抽出时只把「外部 state / ref / setter」改成参数，
 * 内部时序（倍速静默期、字段隔离、身份校验、stalled watchdog、解码失败换源、
 * cleanup 顺序）保持逐字一致。CDP 探针 probe_playback_ux 依赖两处源码特征
 * （videoRef 身份校验、倍速字段隔离写入）做 dev 模块新鲜度自检；改动这两处
 * 逻辑时须同步更新探针的 fetch 目标，且不要在注释里复刻同样的字面串，
 * 否则会让自检形同虚设。
 */
import { useEffect, useRef, useState } from "react";
import type {
  Dispatch,
  MutableRefObject,
  RefObject,
  SetStateAction,
} from "react";
import Artplayer from "artplayer";
import type { Option } from "artplayer";
import artplayerPluginHlsControl from "artplayer-plugin-hls-control";
import Hls from "hls.js";
import { PLAYER_NEXT_ICON, PLAYER_RELOAD_ICON } from "../components/icons";
import { EXTERNAL_PLAY_ENABLED, PLAY_FAILURE_HINT } from "../lib/features";
import { registerPlayer, stopActivePlayer } from "../lib/playerRegistry";
import { api, errorMessage } from "../lib/invoke";
import { formatBytesPerSec } from "../lib/bytes";
import { createPosterHold } from "./playerPosterHold";
import { createStallWatchdog } from "./playerStallWatchdog";
import { createThroughputMeter } from "./playerThroughputMeter";
import type { MeterReading } from "./playerThroughputMeter";
import { createPrefsWriter } from "./playerPrefsWriter";
import { createVolumeFader } from "./playerVolumeFade";
import { log } from "../lib/logger";
import { mediaIsAdvancing } from "../lib/mediaAlive";
import { describeHlsError, isTimingFailure } from "../lib/playErrors";
import { probeLineVerdict } from "../lib/playProbe";
import { failoverCopy } from "../lib/sessionFailover";
import type { FailoverCause } from "../lib/sessionFailover";
import { readPlayerPrefs, writePlayerPrefs } from "../lib/playerPrefs";
import { createActor } from "xstate";
import { vodSessionMachine } from "../lib/vodSessionMachine";
import { liveSessionMachine } from "../lib/liveSessionMachine";
import type { VideoMeta } from "../lib/resolution";
import type { PosterElement } from "./playerPosterHold";
import type { PlayResolved } from "../types/luma";

/** 内置播放器能直接解码的 kind；page/share 之类要交给解析池或外部播放。 */
export const BUILTIN_KINDS = ["hls", "flv", "file"];

/**
 * 会话 actor 的实例序号（仅 dev 观测用）：每次创建 actor 自增。换集若退回整页
 * 重建，会得到一个新序号；原地换集则是同一序号下 `sessionId` 自增。CDP 探针
 * 用这个区分两条路径，不参与任何产品逻辑。
 */
let sessionInstanceSeq = 0;

/**
 * 机器发起的副作用在这里落地：由主 effect 在实例挂载期间提供实现。
 *
 * 这四个动作原先散在 5 个交棒点里各写一遍（撤海报 / 挂红条 / `switchOrFailoverRef`
 * 的顺序全靠人记），现在「什么时候做」只由转换表决定一次。
 */
type SessionEffects = {
  /** 判死交棒：撤掉冻结帧、报出人话、把这一线交还给换线 / 换源链路。 */
  failover: (cause: FailoverCause, detail: string) => void;
  /**
   * 续播（原地换集后）：立即试一次 + `canplay` 兜底；期间用户主动暂停则放弃，
   * 别跟用户抢控制权。由机器在进入 `switching` 后收到 `SWITCH_ATTACHED` 时发起。
   */
  resumePlayback: () => void;
  /** 放弃续播：撤掉挂起的重试监听（机器在 `AUTOPLAY_BLOCKED` 时发起）。 */
  cancelResume: () => void;
};

/**
 * 「下一集」控制栏按钮的禁用态。
 *
 * 控件由 ArtPlayer 在实例创建时一次性生成，之后剧集列表异步到达、切到最后一集
 * 都不会重建实例，所以禁用状态不能写死在 `controls[].disable` 里，只能改 DOM。
 * click 里仍会再读一次 ref，双保险（DOM 状态与真实 canNext 万一有一帧不同步）。
 */
function syncNextButton(el: HTMLElement | null, enabled: boolean, switching = false): void {
  if (!el) {
    return;
  }
  el.classList.toggle("is-disabled", !enabled);
  el.setAttribute("aria-disabled", String(!enabled));
  el.classList.toggle("is-switching", switching);
  el.setAttribute("aria-busy", String(switching));
}

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

/**
 * 直播多线路切换：交给 ArtPlayer 控制栏渲染成「线路 1/3」按钮 + 下拉列表，
 * 交互与清晰度按钮一致（同一套 selector 组件），全屏时同样可用。
 */
export interface LiveLineControl {
  /** 该频道全部可播放地址；只有多于 1 条时调用方才传，单线路不必占位置。 */
  lines: string[];
  /** 当前线路序号（已钳制），用于按钮文案与下拉默认勾选。 */
  index: number;
  onPick: (index: number) => void;
}

/**
 * 点播「下一集」控制栏按钮。
 *
 * 用 ref 转发而不是直接传回调：剧集列表是异步到达的，`canNext` / `onNext`
 * 每次渲染都可能变，若进播放内核 effect 的依赖就会把正在播的实例整个重建。
 * 与直播线路按钮同一套路——实例创建时只读一次 ref，点击时再取最新值。
 */
export interface EpisodeNavControl {
  canNext: boolean;
  onNext: () => void;
  /** 原地换集进行中：按钮图标叠转圈、吞掉重复点击（反馈 + 防连点竞态）。 */
  switching?: boolean;
}

export interface UsePlayerEngineArgs {
  /** ArtPlayer 挂载点；实例会在这个容器里生成真正的 <video>。 */
  containerRef: RefObject<HTMLDivElement>;
  /** ArtPlayer 托管的原生 <video>；切集/换源前由调用方置空以失格旧回调。 */
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  /** 卸载时 ArtPlayer 会清掉 src，进度必须独立留一份快照。 */
  lastMediaRef: MutableRefObject<{ positionMs: number; durationMs?: number }>;
  /** 跨站换源与 stalled watchdog 的并发闸门。 */
  failoverStarted: MutableRefObject<boolean>;
  lineSwitchStarted: MutableRefObject<boolean>;
  /** 线路切换失败后的兜底（整站找同名影片）；用 ref 转发避免本 effect 因 lines 重挂。 */
  switchOrFailoverRef: MutableRefObject<() => Promise<void>>;
  /**
   * 直播多线路切换控件。用 ref 转发（而非直接传数组/回调）：
   * 这两个值随每次切线路而变，进依赖数组会让播放内核整个重建。
   */
  liveLineRef?: MutableRefObject<LiveLineControl | null>;
  /**
   * 点播下一集按钮。直播 / 没有剧集列表时传 null，控制栏不渲染该按钮。
   * 必须是 ref：`canNext` 随异步详情变化，不能进内核 effect 的依赖。
   */
  episodeNavRef?: MutableRefObject<EpisodeNavControl | null>;
  /** 是否还有下一集；只驱动控制栏按钮的禁用态，不进播放内核的依赖数组。 */
  canNext?: boolean;
  /**
   * 原地换集进行中；只驱动按钮转圈态。同步走下面的独立 effect——
   * **不能进内核 effect 的依赖**，否则每次换集都会重建播放器实例。
   */
  switching?: boolean;
  /** 控制栏「刷新」：重新解析地址并重建实例。ref 转发，避免内核重建。 */
  reloadRef?: MutableRefObject<(() => void) | null>;
  /**
   * 再次打开同一影片时的续播起点（毫秒）。只在新建实例的 loadedmetadata
   * 消费一次；刷新重建时不重复跳（由调用方在刷新时清零）。
   */
  resumeMsRef?: MutableRefObject<number>;
  resolved: PlayResolved | null;
  /** 新一轮地址解析中：此时旧 `resolved` 属于上一个源，不能再建播放实例。 */
  resolving: boolean;
  siteKey: string;
  vodName: string;
  vodId: string;
  /**
   * 首帧前的海报（影片封面，调用方已过 /image 代理）。remount 路径解析完成后
   * 实例创建时铺上，避免「黑屏 + 转圈」直到 canplay；直播没有海报可不传。
   * 用 ref 承接、不进内核 effect 依赖：封面异步到达绝不能重建正在播的实例。
   */
  poster?: string;
  /** 画面尺寸 / 清单声明分辨率变化时回调；角标由调用方渲染进 `playerRoot`。 */
  onVideoMeta?: (meta: VideoMeta) => void;
  /**
   * 播放器模板根节点（`.art-video-player`）就绪 / 销毁。
   *
   * 全屏请求的对象是它，不是外层 `.player-stage`，所以任何要「跟着画面走」
   * 的浮层都必须挂进这个节点。
   */
  onPlayerRoot?: (root: HTMLDivElement | null) => void;
  /**
   * 「还没出画但确实在加载」的软提示（null = 撤掉）。
   *
   * 与 `setVideoError` 严格分开：错误条是红底、语义是「坏了」；慢源只是慢，
   * 不该出现红色错误条，更不该触发换线。文案由内核按实际等待秒数生成。
   */
  onSlowNotice?: (text: string | null) => void;
  setVideoError: Dispatch<SetStateAction<string>>;
}

export interface UsePlayerEngineHandle {
  /**
   * 原地换集：复用同一个 ArtPlayer 实例（控制栏、全屏、音量都不重建），
   * 只更换播放源。跨协议（hls → mp4）或播放器未就绪时 reject，由调用方
   * 决定是否退回整页重建。
   */
  switchSource: (url: string) => Promise<void>;
  /**
   * 播放器内的短提示（换集/换源进度、源侧慢）。走 ArtPlayer 自带的 notice 层：
   * 提示出现在画面里而不是页面顶部，全屏时也看得见；样式与播放器一致。
   */
  notice: (text: string | null) => void;
  /**
   * 「切换中」真源（机器 matches("switching")，带 15s 兜底超时）。PlayerStage 用它
   * 钉住控制栏；与按钮转环同源，避免 prop/lock 与机器两处来源不一致。
   */
  switching: boolean;
}

/** 挂载 / 销毁播放内核。纯 effect hook，无返回值。 */
export function usePlayerEngine({
  containerRef,
  videoRef,
  lastMediaRef,
  failoverStarted,
  lineSwitchStarted,
  switchOrFailoverRef,
  liveLineRef,
  episodeNavRef,
  canNext,
  reloadRef,
  resumeMsRef,
  resolved,
  resolving,
  siteKey,
  vodName,
  vodId,
  poster,
  onVideoMeta,
  onPlayerRoot,
  onSlowNotice,
  setVideoError,
}: UsePlayerEngineArgs): UsePlayerEngineHandle {
  /** 控制栏「下一集」按钮的 DOM：mounted 时拿到，供禁用态同步用。 */
  const nextButtonRef = useRef<HTMLElement | null>(null);
  /** 「切换中」真源：机器 matches("switching")，由 actor 订阅更新（带兜底超时）。 */
  const [machineSwitching, setMachineSwitching] = useState(false);
  /** 软提示回调放 ref：它的身份每次渲染都会变，不能进内核 effect 的依赖。 */
  const slowNoticeRef = useRef(onSlowNotice);
  slowNoticeRef.current = onSlowNotice;
  /** 海报同理：封面晚于实例创建到达时不重建实例，只在下次建实例时生效。 */
  const posterRef = useRef(poster);
  posterRef.current = poster;
  /** 原地换集的命令句柄：实例在 effect 里创建，ref 负责把命令送到它手上。 */
  const switchRef = useRef<((url: string) => Promise<void>) | null>(null);
  /** 播放器内提示通道：同样由 effect 里创建实例时挂上。 */
  const noticeRef = useRef<((text: string | null) => void) | null>(null);

  /**
   * 会话状态机（2.0.0 内核解释器化）。直播与点播生命周期不同，按 `siteKey` 各选
   * 一台机器；引擎喂事件、机器决定**何时**发生什么，副作用在这里给出实现。
   *
   * 实现走 `sessionEffectsRef` 间接引用：机器 effect 比主 effect 先跑，而副作用
   * （撤海报 / 挂红条 / 交棒换线 / 复位静默计时）全都依赖某个具体 `<video>` 闭包，
   * 只能由主 effect 在挂载时填、卸载时清空。实现缺席 = 实例已销毁，此时是 no-op，
   * 绝不会对着已释放的播放器动手。与 `switchRef` / `noticeRef` 是同一套路数。
   */
  const sessionActorRef = useRef<ReturnType<typeof createActor<typeof vodSessionMachine>> | null>(null);
  const sessionEffectsRef = useRef<SessionEffects | null>(null);
  useEffect(() => {
    // dev 观测：actor 实例身份。`sessionId` 只在一台 ArtPlayer 实例的生命周期内
    // 唯一（换集退回整页重建时会新建 actor，序号重新从 1 开始），CDP 探针要靠
    // 这个序号区分「同一实例内原地换集（USER_SWITCH，sessionId 自增）」与
    // 「整页重建（instance 变化）」。
    const instance = ++sessionInstanceSeq;
    /** 判死交棒：原因由机器写在 context 上，动作由当前实例的实现执行。 */
    const runFailover = (context: {
      failoverCause: FailoverCause | null;
      failoverDetail: string;
    }) =>
      sessionEffectsRef.current?.failover(
        // context 里为 null 只可能出现在直接进 recovering 的极端路径，按「没
        // 线路可用」处理，保证交棒一定有文案、不会静默。
        context.failoverCause ?? "linesExhausted",
        context.failoverDetail,
      );
    const resumeNotes = {
      resumePlayback: () => sessionEffectsRef.current?.resumePlayback(),
      cancelResume: () => sessionEffectsRef.current?.cancelResume(),
    };
    // live 演员按 vod 演员类型收口：引擎只发两台机器共有的事件，且两台都有
    // sessionId / hasPlayed / failover* 这几个上下文字段。
    // 副作用实现通过 `machine.provide({ actions })` 注入（v5 的实现覆盖点，
    // `createActor` 的 options 里没有 actions 这一项）。
    const actor =
      siteKey === "live"
        ? (createActor(
            liveSessionMachine.provide({
              actions: {
                requestLineSwitch: ({ context }) => runFailover(context),
              },
            }),
          ) as unknown as ReturnType<typeof createActor<typeof vodSessionMachine>>)
        : createActor(
            vodSessionMachine.provide({
              actions: {
                navigateFailover: ({ context }) => runFailover(context),
                ...resumeNotes,
              },
            }),
          );
    sessionActorRef.current = actor;
    actor.subscribe((snap) => {
      if (import.meta.env.DEV) {
        (window as unknown as { __lumaPlayerSession?: unknown }).__lumaPlayerSession = {
          instance,
          value: snap.value,
          context: snap.context,
        };
      }
      // 解释器化：按钮「切换中」转环改由机器的 switching 状态驱动（带 15s 兜底超时，
      // 见 vodSessionMachine），不再依赖外部传入的 switching prop。
      setMachineSwitching(snap.matches("switching"));
    });
    actor.start();
    return () => {
      sessionActorRef.current = null;
      actor.stop();
    };
  }, [siteKey]);
  /**
   * 会话代数真源：actor 的 sessionId（每次 LOAD/USER_SWITCH 自增）。取代原先手搓
   * 的 `switchGeneration` 计数器——在途探活/换集回调回来时比对它，判断结论是否属于
   * 已被新一轮切换取代的旧集。影子阶段已验证它与真实切换时序一致（dcc7a12）。
   */
  const sessionGen = () => sessionActorRef.current?.getSnapshot().context.sessionId ?? 0;
  /** 首帧真源：actor.hasPlayed（MEDIA_ALIVE 置位、bumpSession 复位），取代本地 hasPlayed。 */
  const sessionHasPlayed = () => sessionActorRef.current?.getSnapshot().context.hasPlayed ?? false;
  /**
   * 「连续无响应」计数真源：actor.unresponsiveProbes。解释器只在日志里读它，
   * 不再持副本——阈值与「累计到几次判死」全在机器转换表里（UNRESPONSIVE_LIMIT）。
   */
  const sessionUnresponsiveProbes = () =>
    sessionActorRef.current?.getSnapshot().context.unresponsiveProbes ?? 0;

  /**
   * 剧集列表是异步到的：播放器实例创建时 lines 可能还是空的，到达 / 切到最后一集
   * 时都不能重建 ArtPlayer（会造成双流双声），所以把「禁用态」单独同步到 DOM。
   * 这个 effect 故意放在内核 effect 之前且不带 cleanup——内核的依赖数组与
   * cleanup 顺序是回归探针的固定契约，不能被状态同步污染。
   */
  useEffect(() => {
    syncNextButton(nextButtonRef.current, Boolean(canNext), machineSwitching);
  }, [canNext, resolved, machineSwitching]);

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

    lastMediaRef.current = { positionMs: 0 };
    // 全局唯一实例：创建前先硬停上一个（含 HMR 后丢失 cleanup 的游离实例）。
    // 实测这一步是「两个声音」的根治点：React 自己卸载时也会漏掉已 detach
    // 却仍在播的 <video>，只有模块外的登记表能跨挂载 / 跨 HMR 收回它们。
    stopActivePlayer(container);
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
    /**
     * 直播线路按钮：挂到控制栏右侧（设置 / 画中画 / 全屏之前）。
     *
     * 用 ArtPlayer 内置的 selector 组件（清晰度按钮用的同一套），而不是自绘弹层，
     * 这样按钮的间距、hover、下拉列表样式都跟播放器自带控件一致，全屏时同样可用；
     * 下方也就不必再单独占一行 chip 了。
     */
    const live = liveLineRef?.current;
    const controls: NonNullable<Option["controls"]> = [];
    if (live && live.lines.length > 1) {
      controls.push({
        name: "live-line",
        position: "right",
        index: 10,
        html: `线路 ${live.index + 1}/${live.lines.length}`,
        // 不设 tooltip：ArtPlayer 的 hint 浮层正好落在 selector 下拉的位置上，
        // 会把菜单盖住（清晰度按钮同样不设）。文案本身已经说明用途。
        selector: live.lines.map((_url, i) => ({
          html: `线路 ${i + 1}`,
          value: i,
          default: i === live.index,
        })),
        onSelect(selector) {
          // 点击后再读 ref：切线路途中 ref 可能已被新一轮渲染更新。
          const now = liveLineRef?.current;
          const idx = Number(selector.value);
          const label = `线路 ${idx + 1}/${now?.lines.length ?? "?"}`;
          if (!now || !Number.isInteger(idx) || idx < 0) {
            return label;
          }
          // 选中当前线路不重载页面；真正切换由调用方 navigate 完成。
          if (idx !== now.index) {
            now.onPick(idx);
          }
          // ArtPlayer 会把返回值写进按钮（`art-selector-value` 的 innerHTML），
          // 返回 undefined 会直接把按钮文案变成 "undefined"，所以必须回字符串。
          return label;
        },
      });
    }

    /**
     * 缓存速度：挂在 ArtPlayer 控制栏右侧，和直播线路 / 清晰度同一排。
     *
     * 缓冲进度已经由进度条本身画出来，这里只报「从源站下了多快」。数值取自
     * 反代 `/meter`：hls.js 读的是 127.0.0.1，它自己的带宽估算没有意义。
     */
    let speedEl: HTMLElement | null = null;
    controls.push({
      name: "net-speed",
      position: "right",
      index: 12,
      html: `<span class="player-net-speed">--</span>`,
      style: {
        padding: "0 8px",
        fontSize: "12px",
        color: "var(--muted)",
        fontVariantNumeric: "tabular-nums",
      },
      mounted(el) {
        speedEl = el.querySelector<HTMLElement>(".player-net-speed") ?? el;
      },
    });

    /**
     * 点播「下一集」：走 ArtPlayer 原生 controls，不用贴在画面上的自绘浮层。
     *
     * `index: 15` 是刻意的：内置 playAndPause=10、volume=20，自定义控件按
     * `data-index` 排序插入，15 恰好让它紧挨在播放/暂停按钮右侧。回调一律
     * 从 ref 取最新值，避免剧集列表异步到达后把播放实例整个重建。
     */
    if (episodeNavRef?.current) {
      controls.push({
        name: "next-episode",
        position: "left",
        index: 15,
        html: PLAYER_NEXT_ICON,
        tooltip: "下一集",
        click: () => {
          const nav = episodeNavRef.current;
          // 换集进行中再点一次会叠出第二个切换协程：新旧两路 switchUrl 竞态，
          // 后完成的覆盖先完成的——用户看到的就是「点了没反应 / 画面切回旧集」。
          if (nav?.canNext && !nav.switching) {
            nav.onNext();
          }
        },
        mounted: (el) => {
          nextButtonRef.current = el;
          // tooltip 在桌面端会顺手写上 aria-label，移动端不会；显式补一次，
          // 让读屏与窗口探针在两种环境下都有稳定定位点。
          el.setAttribute("aria-label", "下一集");
          syncNextButton(el, episodeNavRef.current?.canNext ?? false, episodeNavRef.current?.switching ?? false);
        },
      });
    }

    /**
     * 「刷新」：重新走 playerContent → resolve_play 并重建播放实例。
     * 卡死 / 网络异常导致缓冲停滞时，用户不必返回详情页再点一次。
     * index 16 紧跟「下一集」；直播没有剧集按钮，它就成了暂停右边第一枚。
     */
    if (reloadRef) {
      controls.push({
        name: "reload",
        position: "left",
        index: 16,
        html: PLAYER_RELOAD_ICON,
        tooltip: "刷新（重新获取播放地址）",
        click: () => reloadRef.current?.(),
        mounted: (el) => {
          el.setAttribute("aria-label", "刷新播放");
        },
      });
    }
    /**
     * HLS 清单 `#EXT-X-STREAM-INF:RESOLUTION` 声明的短边高度。
     *
     * 只是兜底：多数 TVBox 源单码率且不写 RESOLUTION，值一直是 0。真实的
     * 分辨率以 `<video>` 解码出来的 `videoWidth/videoHeight` 为准。
     */
    let declaredHeight = 0;
    /**
     * 看门狗探活用的「当前真实地址」。原地换集不重建本 effect，`resolved`
     * 仍是进页面时那一集——探活若照旧读 resolved.proxyUrl，会拿旧集的地址
     * 给新一集判生死。switchRef 换源时同步更新它。
     */
    let activeProxyUrl = resolved.proxyUrl;
    // 原地换集代数已收敛到 actor.sessionId（见 sessionGen）；不再本地维护计数器。
    /**
     * 切换类 timer / listener 的显式回收登记。
     *
     * 此前这些句柄只靠 `videoRef.current !== video` 身份校验兜底——一旦后续
     * 改动放松校验就会「卸载后继续向已销毁的 video 写音量 / 触发换线」。
     * 现在改成生命周期闭环：每轮切换开始前 `disposeSwitchCycle()` 收上一轮，
     * effect cleanup 再收最后一轮。集合规模由「单轮登记的句柄数」封顶
     * （上一轮条目在新一轮开始时统一清空并回收），连看几千集也不会增长。
     */
    const switchDisposers = new Set<() => void>();
    const trackSwitchDisposer = (dispose: () => void): void => {
      switchDisposers.add(dispose);
    };
    const disposeSwitchCycle = (): void => {
      for (const dispose of switchDisposers) {
        dispose();
      }
      switchDisposers.clear();
    };
    // 首帧标志真源 = actor.hasPlayed（见 sessionHasPlayed）：出过画后所有卡顿按
    // 「网络抖动」处理、换线交给用户手动决定。不再本地维护 hasPlayed。
    /** 实测视频码率（kbps）：按分片字节 ÷ 分片时长做指数平滑。 */
    let measuredKbps = 0;
    /**
     * 最近一次「确认源还在动」的时刻。
     *
     * 停顿判定不能只看 `<video>` 的 `progress`：hls.js 走 MSE，数据是 JS 推
     * 进去的，首个大分片（9MB+ 的 AES-128 源）下载期缓冲毫无变化，`progress`
     * 一次都不发——旧实现 12 秒一到就判死跳走，而实测这类源 18 秒能正常出画。
     * 因此把 hls 自己的加载事件（清单 / 子清单 / 分片 / 缓冲）也当作生命信号。
     */
    let lastAliveAt = Date.now();
    /**
     * 软提示只在「显示中」才发撤除信号：`timeupdate` 每秒会来好几次，每条都
     * 调一次上层 setState 虽然会被 React 合并，但白跑一遍 render 没必要。
     */
    let slowNoticeShown = false;
    const showSlowNotice = (text: string) => {
      slowNoticeShown = true;
      slowNoticeRef.current?.(text);
    };
    const clearSlowNotice = () => {
      if (slowNoticeShown) {
        slowNoticeShown = false;
        slowNoticeRef.current?.(null);
      }
    };
    /** 距最近一次「确认源还在动」多久了（看门狗与日志共用一个口径）。 */
    const quietMs = () => Date.now() - lastAliveAt;
    const noteAlive = () => {
      lastAliveAt = Date.now();
    };
    // 插件在 art 的 ready / restart 事件里会再调一次 update，只摘一次控件会被它
    // 重新挂回来；把开关做实到配置对象上，单码率时后续事件也不再添加「清晰度：
    // 自动」这种假选项。
    const qualityOption = {
      control: true,
      setting: true,
      title: "清晰度",
      auto: "自动",
      // 多数 TVBox 源是单码率且不带 RESOLUTION，插件默认会显示 "0P"；
      // 无分辨率时退回码率 / 片源自定义名 / 原画。
      getName: (level: unknown) => {
        const item = level as { name?: string; height?: number; bitrate?: number };
        if (item.height && item.height > 0) {
          return `${item.height}P`;
        }
        if (item.bitrate && item.bitrate > 0) {
          return `${Math.round(item.bitrate / 1000)}kbps`;
        }
        return item.name || "原画";
      },
    };

    const art = new Artplayer({
      container,
      url: resolved.proxyUrl,
      type: resolved.kind === "hls" ? "m3u8" : resolved.kind,
      // remount 路径的首帧前画面：没有海报时 ArtPlayer 默认黑底 + 转圈直到
      // canplay（慢源 1~10s+）。铺上影片封面，出画后由 poster hold 渐隐接管。
      // 只在有海报时才传这个选项：ArtPlayer 对每个选项做类型校验，显式传
      // undefined 会抛 TypeError 直接崩掉实例（2026-11-15 实测）。
      ...(posterRef.current ? { poster: posterRef.current } : {}),
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
      controls,
      plugins:
        resolved.kind === "hls"
          ? [
              artplayerPluginHlsControl({
                quality: qualityOption,
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
              setVideoError(`当前环境不支持 HLS 内置播放，${PLAY_FAILURE_HINT}。`);
            }
            return;
          }
          // 时间预算按「首个分片可能要下 20 秒」设定（AES-128 大分片实测
          // 11.8s，慢时更久），fatal 型超时改由看门狗复核——默认 10s 的
          // manifestLoadingTimeOut 会把能播的慢源直接判成 fatal。
          const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            manifestLoadingTimeOut: 20_000,
            manifestLoadingMaxRetry: 3,
            manifestLoadingRetryDelay: 1_000,
            levelLoadingTimeOut: 20_000,
            levelLoadingMaxRetry: 3,
            fragLoadingTimeOut: siteKey === "live" ? 20_000 : 45_000,
            fragLoadingMaxRetry: 4,
            fragLoadingRetryDelay: 1_000,
          });
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
          // 生命信号：清单、子清单、分片任何一步真实拿到数据都算「源在动」，
          // 即便此刻还没凑够一帧解码（冷启大分片就是这个状态）。
          const noteHlsAlive = () => {
            if (!disposed) {
              noteAlive();
            }
          };
          hls.on(Hls.Events.MANIFEST_LOADING, noteHlsAlive);
          hls.on(Hls.Events.MANIFEST_LOADED, noteHlsAlive);
          hls.on(Hls.Events.LEVEL_LOADED, noteHlsAlive);
          hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
            noteHlsAlive();
            // 实测码率：分片真实字节 / 该分片覆盖的媒体时长。声明值常缺失或
            // 偏小，这个数才反映「当前这一集到底多大码率」。按 0.7/0.3 平滑，
            // 避免单个小分片（片头）把读数带飞。
            const bytes = data.frag?.stats?.total;
            const seconds = data.frag?.duration;
            if (!bytes || !seconds || seconds <= 0) {
              return;
            }
            const kbps = (bytes * 8) / seconds / 1000;
            measuredKbps = measuredKbps > 0 ? measuredKbps * 0.7 + kbps * 0.3 : kbps;
            // 抖动小于 10% 不必重渲染；换档时那一跳能立刻反映出来。
            const previous = Math.round(measuredKbps);
            if (Math.abs(kbps - previous) / Math.max(previous, 1) > 0.1) {
              reportMeta();
            }
          });
          hls.on(Hls.Events.FRAG_BUFFERED, noteHlsAlive);
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
            // 单码率的源不该出现「清晰度：自动」这种假选项：插件只要看到
            // levels 非空就会挂控件，而 TVBox 源绝大多数只有一档。按 高度/码率/
            // 名称 去重后只剩一档时，把控件与设置项一起摘掉。
            const levels = new Set(
              hls.levels.map(
                (level) => `${level.height ?? 0}|${level.bitrate ?? 0}|${level.name ?? ""}`,
              ),
            );
            if (levels.size <= 1) {
              qualityOption.control = false;
              qualityOption.setting = false;
              instance.controls.remove("hls-quality");
              instance.setting.remove("hls-quality");
            }
            // 清单里的 RESOLUTION 只有这一时刻拿得到，留作真实帧尺寸到达前的
            // 兜底；没有声明值（多数源）就保持 0，角标等解码后再出现。
            const heights = hls.levels
              .map((level) => Math.round(level.height ?? 0))
              .filter((height) => height > 0);
            if (heights.length > 0) {
              declaredHeight = Math.max(...heights);
            }
            reportMeta();
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
            // 换档后画面尺寸会变；`resize` 事件本身也会到，这里补一枪避免某些
            // 编码尺寸相同（只变码率）时角标读到旧值。
            reportMeta();
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
            log.warn("hls fatal", {
              siteKey,
              vodId,
              details: String(data.details ?? ""),
              type: String(data.type ?? ""),
            });
            if (isTimingFailure(data.details)) {
              // 只是「等太久」：不换源、不报红条，交给看门狗复核。
              // 复核拿到明确失败（HTTP 错误 / 内容不是 m3u8）才跳。
              // 刻意**不** noteAlive：这只是「没等到」，不是「有数据在流动」，
              // 记成生命信号会让反复超时的死线永远逃过看门狗。
              return;
            }
            // 实际链路是「先换同源线路，再跨源」，文案不能写成直接换源，
            // 否则用户看到跳到别的源会以为是逻辑错了。
            // 失败路径必须撤掉首帧前的冻结帧 / 海报：接下来要么报错要么换线，
            // 绝不允许一张静帧永久盖住画面（超时复核路径除外——那还在等）。
            posterHold.finish(false);
            if (sessionHasPlayed()) {
              // 已经在播的流突然致命：网络上抖一下的概率远高于线路真的坏了，
              // 自动跳走会把用户正在看的内容切没。只提示，由用户决定。
              setVideoError(`网络波动导致播放中断：${reason}，可点刷新重试`);
              return;
            }
            // hls 自己报致命 = 有明确证据，报 FAILED 交给机器；文案、撤海报与交棒
            // 由 handOverLine 统一做一次。出画后那条分支不报：红线是「已能播放就不
            // 自动跳」，机器侧同样由 notPlayed guard 兜住，两边口径一致。
            sessionActorRef.current?.send({
              type: "FAILED",
              cause: "hlsFatal",
              detail: reason,
            });
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
                setVideoError(
                  EXTERNAL_PLAY_ENABLED
                    ? "当前环境不支持 FLV 内置播放，已改用外部播放。"
                    : "当前环境不支持 FLV 内置播放，请换一条线路或换个源后重试。",
                );
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
              // 生命信号：FLV 的加载完成事件，避免「分片在灌但缓冲还没长」被误判。
              player.on("LOADING_COMPLETE", noteAlive);
              player.on(mpegts.Events.ERROR, (_type: string, detail: string) => {
                if (disposed) {
                  return;
                }
                log.warn("flv error", { siteKey, vodId, detail });
                /**
                 * 直播 FLV 断流几乎总是「先 EOF 再重连」：mpegts 抛
                 * `UnrecoverableEarlyEof` 的那一刻，缓冲里往往还有几秒画面在正常
                 * 解码（实测 1920×1080 / readyState 4 还在播）。此时直接挂
                 * 「播放失败」与用户看到的事实相反，所以给一个观察窗：画面还在
                 * 走就交给看门狗（它按证据判死），真停住了才报错换线。
                 */
                if (siteKey === "live") {
                  const startedAt = video.currentTime;
                  const observe = window.setTimeout(() => {
                    if (disposed || videoRef.current !== video) {
                      return;
                    }
                    const stopped = video.paused
                      ? video.readyState < 2
                      : video.currentTime <= startedAt + 0.2;
                    if (!stopped) {
                      return;
                    }
                    // 画面确实停住 = 判死证据：交给机器，交棒由 handOverLine 做。
                    sessionActorRef.current?.send({
                      type: "FAILED",
                      cause: "flvInterrupted",
                      detail,
                    });
                  }, 4_000);
                  trackSwitchDisposer(() => window.clearTimeout(observe));
                  return;
                }
                // 同 hls fatal：报 FAILED，撤海报 / 文案 / 交棒统一在 handOverLine。
                sessionActorRef.current?.send({
                  type: "FAILED",
                  cause: "flvFatal",
                  detail,
                });
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

    /**
     * 首帧前海报保持（poster hold）。
     *
     * ArtPlayer 默认在 `video:play` 就把 poster 设成 display:none——而 play
     * 事件在 HLS 清单解析完调 play() 的那一刻就触发，首帧根本还没解码出来，
     * 画面随即掉进「黑屏 + 转圈」。这里接管 poster 的退场时机：一直盖到
     * 新源真正出画（playing，或 readyState>=3 的 timeupdate），再 250ms 渐隐。
     *
     * 失败路径（video error / hls fatal / 看门狗判死）必须能立刻撤掉它：
     * 冻结帧只是过渡，绝不允许永久盖住画面。posterHold.finish(false) 即硬撤。
     */
    /**
     * 首帧前的海报 / 冻结帧保持。为什么要接管 ArtPlayer 的退场时机、失败路径
     * 为什么必须硬撤，都写在 `playerPosterHold.ts`；这里只接线。
     */
    const posterHold = createPosterHold({
      poster: art.template.$poster as unknown as PosterElement,
      video,
      onPlay: (callback) => {
        art.on("video:play", callback);
        return () => art.off("video:play", callback);
      },
    });
    if (posterRef.current) {
      posterHold.hold();
    }

    /**
     * 起播音频淡入（2026-11-15 用户反馈「直播频道切换时候 有个声音」）。
     *
     * 两处噪声源：
     * 1. ArtPlayer 初始化时会把音量恢复成它自己缓存的 100%，比我们的偏好早
     *    若干帧生效——首帧就是满音量，换台听起来像「突然响一声」；
     * 2. MSE / HLS 起播首帧本身带一声爆音（解码器灌入时的采样跳变）。
     *
     * 处理：新实例先静音（muted=true）并从 0 起播，等真正 `playing` 后再用
     * 200ms 淡入到记忆音量。淡入期间的 volumechange 不落盘（见 volumeFadeUntil），
     * 否则「0」会被写成用户偏好。
     */
    /**
     * 起播音量淡入。为什么必须先立静默窗再动 `muted`、为什么要 `canplay` /
     * 1.5s 兜底、换集为什么不能复用冷启动目标——那些顺序与历史都写在
     * `playerVolumeFade.ts`，这里只负责接线与偏好读写。
     */
    const fader = createVolumeFader({
      target: video,
      isCurrent: () => videoRef.current === video,
      readStored: readPlayerPrefs,
      writePrefs: (prefs) => writePlayerPrefs(prefs),
    });
    fader.armColdStart();

    /**
     * 幂等硬停：既由本 effect 的 cleanup 调用，也登记到全局唯一实例登记表，
     * 供下一个实例创建前 / HMR 丢失 cleanup 时收回。顺序必须是先停 <video>
     * 再销毁解码器、最后 art.destroy()，否则 MSE 源会脱离 DOM 继续出声。
     */
    let stopped = false;
    const hardStop = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        // 先静音再 pause：拖着一小段缓冲直接掐断时，音频设备会留下一声
        // 「咔」的爆音（换台时最明显）。静音后再停，输出端先归零。
        video.muted = true;
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // 已 detach 的 <video> 可能抛 InvalidStateError，忽略即可。
      }
      // 海报保持的监听与渐隐定时器随实例一起收，不留残留回调。
      posterHold.dispose();
      teardownDecoders?.();
      art.destroy();
    };
    const unregister = registerPlayer(hardStop);

    /**
     * 续播：再次打开同一影片时从历史记录里的 positionMs 直接跳过去。
     *
     * 只在 `loadedmetadata` 消费一次；太靠近片头（< 3s）或接近片尾（剩余
     * < 5s）不跳，避免「刚看完又打开」时卡在结尾反复触发 ended 自动下一集。
     * 直播没有进度可续，跳过。
     */
    const resumeMs = resumeMsRef?.current ?? 0;
    if (resumeMsRef) {
      resumeMsRef.current = 0;
    }
    const applyResume = () => {
      if (siteKey === "live" || resumeMs <= 3000 || !Number.isFinite(video.duration)) {
        return;
      }
      if (resumeMs >= (video.duration - 5) * 1000) {
        return;
      }
      try {
        video.currentTime = resumeMs / 1000;
      } catch {
        // 某些 HLS 在首分片到达前 seek 会抛 InvalidStateError，忽略即可。
      }
    };
    video.addEventListener("loadedmetadata", applyResume, { once: true });

    // 全屏元素是 `.art-video-player` 本身（ArtPlayer 的 `$player`），所以角标
    // 这类要跟着画面走的浮层由调用方 portal 进这个节点，而不是排在 stage 里。
    onPlayerRoot?.(art.template.$player);
    /**
     * 上报当前分辨率。`videoWidth/videoHeight` 是解码后的真实尺寸，HLS 换档、
     * 自适应切码率都会触发 `resize`，因此不需要信清单里的声明值；清单一律
     * 只作兜底（`declaredHeight`）。
     */
    const reportMeta = () => {
      onVideoMeta?.({
        width: video.videoWidth || 0,
        height: video.videoHeight || 0,
        declaredHeight,
        bitrateKbps: measuredKbps > 0 ? Math.round(measuredKbps) : undefined,
      });
    };
    video.addEventListener("loadedmetadata", reportMeta);
    video.addEventListener("resize", reportMeta);
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
    /**
     * 偏好写入：实例静默期的噪声纠正、音量节流 + trailing、字段隔离，
     * 全部在 `playerPrefsWriter.ts`（那里有 9 条行为测试）。
     */
    const prefsWriter = createPrefsWriter({
      video,
      isCurrent: () => videoRef.current === video,
      fader,
      read: readPlayerPrefs,
      write: (patch) => writePlayerPrefs(patch),
    });
    video.addEventListener("volumechange", prefsWriter.onVolumeChange);
    video.addEventListener("ratechange", prefsWriter.onRateChange);

    const onError = () => {
      const mediaError = video.error;
      // 3 = MEDIA_ERR_DECODE, 4 = MEDIA_ERR_SRC_NOT_SUPPORTED。WebView2 常见于
      // HEVC：同一编码换源也救不了，只能交给换线路 / 换源流程。
      // 解码器直接报错比任何复核都硬：只报 FAILED 把证据交给机器，撤海报 / 文案 /
      // 交棒由机器进入 recovering 后回调 handOverLine 一次完成（mediaCode 随 detail
      // 进同一条日志，不再分两处写）。
      sessionActorRef.current?.send({
        type: "FAILED",
        cause: "mediaDecode",
        detail: `code=${mediaError?.code ?? 0}`,
      });
    };
    video.addEventListener("error", onError);

    // 死 CDN 会让 hls.js 无限重试却不触发 fatal，画面永远停在 00:00。
    // 但「慢」不等于「死」：单分片 9MB+ 的 AES-128 源冷启拉首个分片实测
    // 11.8s（多多影院 ZJ4K），固定 12s 一刀切会把能播的线判死跳走——用户
    // 看到「后台在下载、有声音没画面」却被换线。
    //
    // 2026-11-14 再收紧一轮判决标准：**时间不是证据**。上一版把 12s 静默当
    // 判死条件，结果用户碰到的是「再等十几秒就出画」的源，被误杀跳走。现在
    // 静默只用来触发一次**独立复核**（直接探清单 + 首个分片），只有复核给出
    // 明确失败（HTTP 错误 / 内容不是 m3u8 / 分片是占位图）才换线；
    // 超时或说不出所以然（unknown）一律继续等，把决定权留给用户。
    /**
     * 连续多少次「复核也拿不到任何响应」才算确认失效，以及 unknown 的累计与判死
     * 转移，都在会话状态机里（`UNRESPONSIVE_LIMIT` / `vodSessionMachine.probing`）。
     * 这里不复制阈值，也不另有判决模块：解释器只负责取证据（下面的计时闸门 +
     * `probeLineVerdict`），把三态结论喂给机器，由转换表决定「继续等 / 累计 / 交棒」。
     */
    /**
     * 交棒换线的**唯一**执行点：机器进入 `recovering`（点播）/ `recovering`（直播，
     * 动作名 `requestLineSwitch`）时调到这里。文案与日志 stage 由 `failoverCopy`
     * 给出，原因（判死依据）由机器写在 context 上。
     *
     * 取代原先 5 处各写一遍的「finishPoster + setVideoError + switchOrFailover」：
     * 那里头任何一处漏了撤海报，就会有一张静帧永久盖住画面。
     */
    const handOverLine = (cause: FailoverCause, detail: string) => {
      const { message, stage } = failoverCopy(cause, detail);
      // 已经交棒：本轮不必再看（真源在 watchdog 里，见 playerStallWatchdog）。
      watchdog.stop();
      log.warn(stage, {
        siteKey,
        vodId,
        quietMs: quietMs(),
        unresponsiveProbes: sessionUnresponsiveProbes(),
        detail,
      });
      // 线路已判死：冻结帧的使命结束，撤掉后交给换线链路，绝不让静帧盖住后续画面。
      posterHold.finish(false);
      setVideoError(message);
      void switchOrFailoverRef.current();
    };
    /**
     * 挂起的续播重试（`canplay` / `pause` 两个 once 监听 + play()）。
     * 用户在这轮里主动暂停时由机器的 `cancelResume` 撤掉，不跟用户抢控制权。
     */
    let pendingResumeUndo: (() => void) | null = null;
    // 把这一轮实例的副作用实现挂给机器（机器 effect 先跑，只认这个 ref）。
    sessionEffectsRef.current = {
      failover: handOverLine,
      resumePlayback: () => {
        // switchUrl 返回时新解码器可能还没把 src 挂上（HLS 清单异步），此刻 play()
        // 会被拒且不再重试，画面就停在暂停态 —— 所以立即试一次 + canplay 兜底。
        const cancel = () => {
          sessionActorRef.current?.send({ type: "AUTOPLAY_BLOCKED" });
        };
        const resumePlay = () => {
          video.removeEventListener("pause", cancel);
          if (
            !(sessionActorRef.current?.getSnapshot().context.resumeAborted ?? false) &&
            videoRef.current === video &&
            video.paused
          ) {
            void video.play().catch(() => {});
          }
        };
        video.addEventListener("pause", cancel, { once: true });
        video.addEventListener("canplay", resumePlay, { once: true });
        const undo = () => {
          video.removeEventListener("pause", cancel);
          video.removeEventListener("canplay", resumePlay);
          pendingResumeUndo = null;
        };
        pendingResumeUndo = undo;
        // 新一轮切换 / 卸载也要收：与淡入的 disposer 各自登记，Set 幂等。
        trackSwitchDisposer(undo);
        void video.play().catch(() => {});
      },
      cancelResume: () => {
        pendingResumeUndo?.();
      },
    };
    /**
     * 卡顿看门狗：只取证据，判决在状态机。为什么「时间不是证据」、三条早退
     * 各对应哪次回归，都写在 `playerStallWatchdog.ts`（那里有 12 条行为测试）。
     */
    const watchdog = createStallWatchdog({
      video,
      isAdvancing: () => mediaIsAdvancing(video),
      quietMs,
      markAlive: noteAlive,
      clearSlowNotice,
      generation: sessionGen,
      hasPlayed: sessionHasPlayed,
      unresponsiveProbes: sessionUnresponsiveProbes,
      send: (event) => sessionActorRef.current?.send(event),
      // 探「当前真实地址」而不是 resolved.proxyUrl：原地换集后 resolved 不变，
      // 照旧探旧地址会拿旧集的生死结论误杀新一集。
      probeTarget: () => ({ url: activeProxyUrl, kind: resolved.kind }),
      probe: probeLineVerdict,
      isYielded: () => failoverStarted.current || lineSwitchStarted.current,
      log: (level, stage, context) => {
        log[level](stage, { siteKey, vodId, ...context });
      },
    });
    const stopWatchdog = watchdog.start();
    // 媒体侧的生命信号：缓冲有增长、元数据到位、开始播放都算活着。
    // `waiting` / `stalled` 不算——它们恰恰是「卡住」的表现，不能重置计时。
    const onMediaAlive = () => {
      if (video.currentTime > 0) {
        sessionActorRef.current?.send({ type: "MEDIA_ALIVE" });
      }
      noteAlive();
    };
    /**
     * 「在动，只是慢」的等待提示：只报事实（等了多久），不参与任何判决。
     *
     * 与看门狗解耦的原因：数据在缓慢流动时（progress 一直在发）看门狗根本不会
     * 触发，但用户仍然面对黑屏；反过来看门狗又绝不能因为「等得久」就换源。
     * 两件事各管一头，8s 起显示，出画即撤。
     */
    let loadStartedAt = Date.now();
    const hintTimer = window.setInterval(() => {
      if (video.readyState >= 2 || mediaIsAdvancing(video)) {
        clearSlowNotice();
        return;
      }
      const waited = Math.round((Date.now() - loadStartedAt) / 1000);
      if (waited >= 8) {
        // 只补「等了多久」：标题由 PlayerStage 统一给「正在加载画面…」，
        // 这里再说一遍会变成两行同义文案。
        //
        // 45s 后封顶：计数器一直往上翻（用户截到过「已等待 906s」）既没有信息量，
        // 还会让人以为应用在傻等。此时改成可操作的建议，是否换线仍由上层决定。
        showSlowNotice(
          waited >= 45
            ? "源侧长时间没有响应，可切换线路或点刷新重试"
            : `源侧响应较慢，已等待 ${waited}s`,
        );
      }
    }, 2_000);
    // 每秒问一次反代吞吐；控件收起时也继续更新，展开控制栏立刻是最新读数。
    /**
     * 反代吞吐轮询：速率读数 + 「字节在涨 = 极慢但活着」的记活。
     * 为什么速率不认 hls.js、为什么取不到数据不能闪 0，见 `playerThroughputMeter.ts`。
     */
    const meter = createThroughputMeter({
      fallbackBase: "http://127.0.0.1:9978",
      status: () => api.proxyStatus(),
      fetchJson: async (url) => {
        const res = await fetch(url, { cache: "no-store" });
        return (await res.json()) as MeterReading;
      },
      onGrowth: () => {
        noteAlive();
        // 字节在涨 = 极慢但活着：交给机器复位 unknown 累计（阈值真源在转换表，
        // 解释器不自己清零计数器）。
        sessionActorRef.current?.send({ type: "FRAG_GROWTH" });
      },
      // 控件收起时也要继续更新，展开控制栏立刻是最新读数；元素还没建好就跳过这一拍。
      render: (label) => {
        if (speedEl) {
          speedEl.textContent = label;
        }
      },
      format: formatBytesPerSec,
    });
    const stopMeter = meter.start();

    /**
     * 原地换集：同一条线路的下一集只是换一个 m3u8 地址，销毁重建会把
     * 控制栏、全屏、音量全部重置，而且重建后没有用户手势、无法再次进入
     * 全屏。这里只停旧解码器、把新地址交给 ArtPlayer 的 switchUrl。
     */
    noticeRef.current = (text: string | null) => {
      art.notice.show = text ?? "";
    };
    switchRef.current = async (url: string) => {
      if (!videoRef.current) {
        throw new Error("player is not ready");
      }
      // 同地址重入（file 直链时 art.url 就是播放地址）：ArtPlayer 的 switchUrl
      // 对同地址是 no-op，若先销毁解码器就没人重建了，画面会死在缓冲耗尽处。
      if (url === art.url) {
        return;
      }
      // 记录切换前的播放意图：teardown 销毁解码器会把 video 打回 paused，
      // ArtPlayer 的 switchUrl 不会替我们续播——新源挂上后必须手动 play()，
      // 否则缓冲完成了却停在暂停态，用户看到的就是「换集后黑屏不动」
      // （2026-11-15 实测）。
      const wasPlaying = !video.paused && !video.ended;
      // 换集 = USER_SWITCH，续播意图如实带入；要不要播由机器的 wantsResume 守卫决定。
      sessionActorRef.current?.send({ type: "USER_SWITCH", url, resumeIntent: wasPlaying });
      /**
       * 偏好沿用（与新建实例同一套纪律）：原地换集同样会被 ArtPlayer 把
       * playbackRate 重置回 1、把 volume 恢复成它缓存的 100%——那不是用户
       * 动作，静默期必须按切换前的有效值重新立起来，否则倍速被冲成 1 还
       * 落进偏好（2026-11-16 探针实测「第 2 集回到 1 倍速」）。音量取「当前
       * 有效值」而不是存储值：本集内刚拖过音量可能还压在节流窗口里没落盘，
       * 丢了它就是把用户的手动调节抹掉。
       */
      const swVolume =
        !fader.fadeDone || video.muted || video.volume <= 0.01 ? fader.lastAudible : video.volume;
      const swMuted = video.muted;
      const swRate = video.playbackRate;
      // 实例静默窗（见 `playerPrefsWriter`）**不在这里续**：那是新建实例的 load 窗口，换集
      // 时续窗会把用户紧随换集的音量调节也吞掉（写入器的纠正分支
      // 按存储值回写）。ArtPlayer 在 switchUrl 后恢复缓存音量/倍速的噪声，
      // 由下面的显式重放 + swFadeIn 的 ramp 窗口负责压住与纠正。
      const swReplay = window.setTimeout(() => {
        if (videoRef.current !== video) {
          return;
        }
        if (Math.abs(video.playbackRate - swRate) > 0.01) {
          video.playbackRate = swRate;
        }
        if (!video.muted && fader.fadeDone && Math.abs(video.volume - swVolume) > 0.01) {
          video.volume = swVolume;
        }
      }, 1250);
      trackSwitchDisposer(() => window.clearTimeout(swReplay));
      // 首帧前保留画面：teardown 销毁 Hls 即清 MSE 缓冲，画面立刻黑。趁缓冲
      // 还在抓当前帧当 poster。MSE blob 同源，drawImage 不会 taint；跨源 native
      // src 会抛 SecurityError——catch 住跳过，退回无海报，不阻塞换集。
      let frozen: string | null = null;
      try {
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            frozen = canvas.toDataURL("image/jpeg", 0.85);
          }
        }
      } catch {
        frozen = null;
      }
      if (wasPlaying) {
        // 掐断旧音频前先静音：拖着一小段缓冲直接 teardown，输出端会留一声
        // 「咔」的爆音（与 hardStop 同一处理）。暂停态切换不出声，不动它。
        video.muted = true;
      }
      disposeSwitchCycle();
      teardownDecoders?.();
      teardownDecoders = null;
      /**
       * 按集重置：原地换集复用同一个 effect 闭包，旧集的「出画 / 探活 /
       * 码率」状态若不归零，新一集就失去看门狗保护（hasPlayed=true 后永不
       * 自动换线）、角标残留旧码率、unknown 计数接着旧值累计。看门狗三态
       * （dead 一次即换 / unknown 累计三次 / 出画后只提示不换）必须从
       * 「未知」重新开始，watchStopped 也要复位。
       */
      // hasPlayed 与 unknown 累计都由 USER_SWITCH→bumpSession 复位（本函数开头已 send）。
      measuredKbps = 0;
      watchdog.reset();
      // 会话代数由 USER_SWITCH 事件驱动 actor.sessionId 自增（本函数开头已 send），
      // 这里不再手动 ++。
      activeProxyUrl = url;
      declaredHeight = 0;
      lastAliveAt = Date.now();
      loadStartedAt = Date.now();
      clearSlowNotice();
      // 角标不残留旧集的分辨率 / 码率：先清零，等新集 loadedmetadata 再上报。
      onVideoMeta?.({ width: 0, height: 0, declaredHeight: 0 });
      if (frozen) {
        art.poster = frozen;
        posterHold.hold();
      }
      await art.switchUrl(url);
      // 倍速先立起来：ratechange 在静默期内只会「纠正回切换前的倍速」，
      // 顺带把 ArtPlayer 稍后恢复的默认 1 也一并压掉。
      if (Math.abs(video.playbackRate - swRate) > 0.01) {
        video.playbackRate = swRate;
      }
      if (wasPlaying) {
        // 新集声音重走一次淡入，**目标 = 切换前的有效音量**（不是存储偏好）——
        // 复用冷启动那条会把音量冲成 ArtPlayer 刚恢复的存储值（2026-11-16 实测
        // 「拖音量后换集丢音量」）。淡入本身、静默窗、完成后的正式落盘都在
        // `fader.armSwitch` 里；撤销函数交给切换句柄回收器，与原来的 disposer 等价。
        trackSwitchDisposer(fader.armSwitch({ volume: swVolume, muted: swMuted }));
        // 续播改由机器发起（实现见下面的 `sessionEffects.resumePlayback`）：倍速复位
        // 与音量淡入都已经在前面上方处理完，这一刻才请求播放——时机与原来的内联
        // 写法逐字一致，区别只是「谁决定要播」从这段代码搬进了转换表。
        sessionActorRef.current?.send({ type: "SWITCH_ATTACHED" });
      }
      /**
       * 等到新集**真正有画面**才算切换完成：调用方（PlayerPage）在这条 promise
       * 上挂着「切换中」状态——按钮转圈、控制栏钉住。若 switchUrl 一返回就结束，
       * 慢源缓冲的十几秒里画面还停在冻结帧、spinner 却已消失，用户读作
       * 「点了没反应」。15s 封顶：出画 / 被更新一轮切换取代 / 超时都收敛，
       * 坏源的善后由看门狗与慢提示接管，按钮不能永远转。
       */
      const gen = sessionGen();
      await new Promise<void>((resolve) => {
        const disposeWaiter = () => {
          video.removeEventListener("loadeddata", onAlive);
          video.removeEventListener("playing", onAlive);
          video.removeEventListener("timeupdate", onAlive);
          window.clearTimeout(cap);
        };
        const finish = (aliveCheck: boolean) => {
          if (aliveCheck && sessionGen() !== gen) {
            return; // 「出画」快路径只认最新一轮；在途旧切换不该宣布新集就绪
          }
          disposeWaiter();
          resolve();
        };
        const onAlive = () => {
          if (!video.paused && video.readyState >= 2 && video.videoWidth > 0) {
            // 新集真正出画 → MEDIA_ALIVE，机器 switching→playing 收口。
            sessionActorRef.current?.send({ type: "MEDIA_ALIVE" });
            finish(true);
          }
        };
        // 封顶必须无条件收口（finish(false)）：上一轮切换被新代次顶掉后，
        // 若连 cap 也被守卫吞了，这条 promise 永挂、finally 永远不跑，
        // 「切换中」只能等页面级兜底（2026-11-16 CDP 实测卡 10s+）。
        const cap = window.setTimeout(() => finish(false), 15000);
        // 登记给「新一轮切换 / effect cleanup」兜底：正常收口时 disposeWaiter
        // 已跑过一次，再跑是幂等的 removeEventListener/clearTimeout no-op。
        trackSwitchDisposer(disposeWaiter);
        video.addEventListener("loadeddata", onAlive);
        video.addEventListener("playing", onAlive);
        video.addEventListener("timeupdate", onAlive);
        onAlive();
      });
    };
    // 此刻实例已建、解码器已挂（url 早已 resolved）。把「建实例」这段映射成
    // LOAD→RESOLVED→ATTACHED，让机器进 buffering；首帧由 onMediaAlive 推 MEDIA_ALIVE。
    sessionActorRef.current?.send({ type: "LOAD", url: resolved.proxyUrl });
    sessionActorRef.current?.send({ type: "RESOLVED", url: resolved.proxyUrl });
    sessionActorRef.current?.send({ type: "ATTACHED" });
    video.addEventListener("progress", onMediaAlive);
    video.addEventListener("loadeddata", onMediaAlive);
    video.addEventListener("loadedmetadata", onMediaAlive);
    video.addEventListener("playing", onMediaAlive);
    video.addEventListener("timeupdate", onMediaAlive);

    return () => {
      // 副作用实现先摘：机器 actor 按 siteKey 存活，比这一轮实例活得久，不能让它
      // 回调到已销毁闭包（那会对着旧 <video> 撤海报 / 交棒）。
      sessionEffectsRef.current = null;
      stopWatchdog();
      window.clearInterval(hintTimer);
      switchRef.current = null;
      noticeRef.current = null;
      // 切换类 timer/listener 全部显式回收（身份校验仍在，这里是第二道闸）：
      // 卸载/HMR 后不允许有任何活着的切换句柄继续摸 <video>。
      disposeSwitchCycle();
      // 海报保持的监听 / 渐隐定时器随卸载收回（DOM 由 art.destroy 移除）。
      posterHold.dispose();
      stopMeter();
      clearSlowNotice();
      prefsWriter.dispose();
      video.removeEventListener("error", onError);
      video.removeEventListener("progress", onMediaAlive);
      video.removeEventListener("loadeddata", onMediaAlive);
      video.removeEventListener("loadedmetadata", onMediaAlive);
      video.removeEventListener("playing", onMediaAlive);
      video.removeEventListener("timeupdate", onMediaAlive);
      video.removeEventListener("volumechange", prefsWriter.onVolumeChange);
      video.removeEventListener("ratechange", prefsWriter.onRateChange);
      video.removeEventListener("loadedmetadata", reportMeta);
      video.removeEventListener("resize", reportMeta);
      video.removeEventListener("loadedmetadata", applyResume);
      fader.dispose();
      // 先通知上层把 portal 里的角标摘掉，再销毁 ArtPlayer：反过来的话 React
      // 会往一个已经被 remove() 的节点里做移除。
      onPlayerRoot?.(null);
      // 只补写音量：拖动可能被节流/定时器延后，卸载时补一次最终值。
      // 但淡入还没开始/没走完就卸载（连点换台）时 volume 还接近 0，别把它写成
      // 偏好（1.0.4 开发期踩过：写成 0 之后整机默认静音）。
      // 倍速绝不能在这里覆盖——ended 触发卸载那一刻 video.playbackRate 可能已被
      // 播放内核重置为 1（实测），写回会抹掉用户刚选的倍速。倍速由写入器在变更时
      // 立即落盘，无需、也不允许在卸载时再写。
      if (fader.fadeDone && Date.now() >= fader.silentUntil) {
        writePlayerPrefs({ volume: video.volume, muted: video.muted });
      }
      // 先置空引用，避免 destroy 过程中的 video:error 再触发换源。
      videoRef.current = null;
      // 换源 / 切集时的硬停流：ArtPlayer.destroy() 只保证自己的模板被移除，
      // 而 hls.js / mpegts.js 是独立 attach 到 <video> 的 MSE 源。若容器已被
      // React 摘掉或 destroy 链中断，旧解码器会继续灌数据 → 「两个声音」。
      // 顺序：先停 <video>（pause + 清 src + load 冲掉缓冲），再销毁解码器，
      // 最后销毁 ArtPlayer（它的 destroy 事件会幂等兜底再调一次 teardown）。
      hardStop();
      unregister();
    };
    // `resolving` 必须进依赖：新一轮解析开始时要立刻卸载旧内核，不能等
    // `setResolved(null)` 落地（两者都是 effect 阶段的 setState，晚一帧）。
    // 其余都是稳定引用（ref / setter），或仅用于日志与回调闭包（vodId）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, resolving, siteKey, vodName]);

  return {
    switchSource: (url: string) =>
      switchRef.current?.(url) ??
      Promise.reject(new Error("播放器尚未就绪，暂时不能原地换集")),
    notice: (text: string | null) => noticeRef.current?.(text),
    switching: machineSwitching,
  };
}
