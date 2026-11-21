import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Navigate } from "../lib/nav";
import { useProxiedImage } from "../hooks/useProxiedImage";
import Empty from "../components/Empty";
import EpisodeButton from "../components/EpisodeButton";
import ErrorBar from "../components/ErrorBar";
import FavStar from "../components/FavStar";
import Icon from "../components/Icon";
import IconButton from "../components/IconButton";
import SourcePicker from "../components/SourcePicker";
import DetailSkeleton from "../components/DetailSkeleton";
import VodMetaHero from "../components/VodMetaHero";
import {
  formatDuration,
  lineLabel,
  parsePlayLines,
  sameTitle,
  toVodRef,
} from "../lib/format";
import type { Episode, PlayLine } from "../lib/format";
import { findPlayableSource } from "../lib/crossSourceRecovery";
import { fetchDoubanMeta } from "../lib/douban";
import type { DoubanMeta } from "../lib/douban";
import { api, cacheKeys, errorMessage } from "../lib/invoke";
import { ageCached, CACHE_TTL, peekFresh } from "../lib/queryClient";
import { notify } from "../lib/notify";
import { recallCard } from "../lib/cardIndex";
import { classifyFailure } from "../lib/failureReason";
import { noDetailSources } from "../lib/noDetailSource";
import { usePageState } from "../lib/usePageState";
import { useAppStore } from "../stores/appStore";
import { peekDetailSeed, putPlaySeed } from "../lib/handoff";
import { prefetchEpisodePlay } from "../hooks/playback/episodePlayResolve";
import { prefetchSources } from "../lib/sourceCache";
import { log } from "../lib/logger";
import type { SourceOption } from "../lib/sources";
import type { HistoryItem, Site, VodInfo } from "../types/luma";

interface DetailPageProps {
  siteKey: string;
  vodId: string;
  /** 列表/搜索已知的片名，详情回来之前就能启动后台换源预取。 */
  title?: string;
  siteName?: string;
  sites: Site[];
  navigate: Navigate;
  onBack: () => void;
}

/**
 * 「自动切到的目标页」不再做跨源自愈：目标页的详情已经探活过，万一再次读空
 * （缓存失效 / 源偶发），不该又跳到第三个源，形成连环跳转。
 */
const skipCrossSource = new Set<string>();
/** 跨源成功后的一次性提示（模块级变量够用，不必写 sessionStorage）。 */
let pendingRecoveryNotice: string | null = null;

/**
 * 源站把 `vod_name` 写空时，用已知片名补上。
 *
 * 「爱瓜TV[py]」这类源的 `detailContent` 只回播放串，片名/封面/简介/演员恒为空：
 * 不补的话标题就是「未命名」，更要紧的是 `toVodRef` 直接拿 `vod_name` 当收藏名
 * 与历史名，存进去之后永远叫「未命名」。路由带的片名是「这部片一定叫什么」的
 * 直接证据，所以只在源站缺字段时补，绝不覆盖源站已经给出的名字。
 */
/** 源站片名为空时用已知片名回填；已有片名不覆盖。 */
function withKnownName(vod: VodInfo, name: string): VodInfo {
  const known = name.trim();
  if (!known || vod.vod_name?.trim()) {
    return vod;
  }
  return { ...vod, vod_name: known };
}

/** 详情页：影片信息 + 收藏 + 线路/剧集选择 + 手动换源。 */
export default function DetailPage({
  siteKey,
  vodId,
  title,
  siteName,
  sites,
  navigate,
  onBack,
}: DetailPageProps) {
  const detailKey = cacheKeys.detail(siteKey, vodId);
  /**
   * 源站没给片名时，这一屏还能依据的片名：路由片名 → 列表卡片。
   *
   * 两者都没有（直接输 URL）时是空串，页面按「未命名」占位。
   */
  const knownName =
    (title || "").trim() || (recallCard(siteKey, vodId)?.vod_name ?? "").trim();

  /**
   * 首帧数据的两种来源，语义不同：
   * - **详情缓存**（10 分钟内抓过）：权威，可直接用，不发请求；
   * - **交接实体**（上一页交过来的卡片）：够渲染但没有播放串，标 `needFetch`
   *   让首屏后照样问一次源。
   *
   * 缓存优先于交接：同一部剧时缓存那份信息更全（有播放串），交接只是它缺席时的
   * 补位。不写进 `usePageState`（那层没有 TTL，会把十分钟前的详情当成还新鲜），
   * 也不在 effect 里「消费」交接：dev StrictMode 会挂载两次，两次之间清掉就等于
   * 第二次读到空。交接层本身有身份匹配与 2 分钟保质期。
   */
  const [bootstrap] = useState(() => {
    const cached = peekFresh<VodInfo[]>(detailKey, CACHE_TTL.detail)?.[0] ?? null;
    if (cached) {
      // 缓存里也可能是源站片名为空的那一份：同样补，否则秒开路径又把「未命名」
      // 带回来（播放种子、收藏、历史都读这份）。
      return { vod: withKnownName(cached, knownName), needFetch: false };
    }
    const seed = peekDetailSeed(siteKey, vodId);
    // 缓存与交接实体都没有（直接输 URL / 分享链接 / WebView 恢复会话）：没有首帧
    // 数据就必须问一次源，否则页面停在「当前源没有返回影片详情」，只有手动重试
    // 才会加载。
    return { vod: seed ? withKnownName(seed, knownName) : null, needFetch: true };
  });
  const [vod, setVod] = useState<VodInfo | null>(bootstrap.vod);
  /** 手上这份是否只是交接实体（没有播放串）：是则首屏后仍要取一次详情。 */
  const [needFetch, setNeedFetch] = useState(bootstrap.needFetch);
  /**
   * 空详情时回填的卡片：发现型源（豆瓣[py] 等）的 `detailContent` 恒为空，但列表
   * 卡片自带海报、评分、年份，那是这个源能给出的全部信息。来源是 `cardIndex`
   * （列表拉取时顺手记下）。
   */
  const [emptyCard, setEmptyCard] = useState<VodInfo | null>(null);
  /**
   * 后台正在播的那条会话。详情请求失败时用它判断「这部片其实正在播」——
   * 播放器是常驻层，切到详情页后流还在走，前台再报「没有影片详情」自相矛盾。
   */
  const playSession = useAppStore((state) => state.playSession);
  // 空态卡片的封面也走同一套 /image 代理：豆瓣的 pic 带内联 `@Referer=`，
  // 直连会被防盗链挡成 403。
  const emptyCardImage = useProxiedImage(emptyCard?.vod_pic);
  const [lineIndex, setLineIndex] = usePageState(`${detailKey}:line`, 0);
  const [episodeQuery, setEpisodeQuery] = usePageState(
    `${detailKey}:query`,
    "",
  );
  const [reverse, setReverse] = usePageState(`${detailKey}:reverse`, false);

  // 瞬时状态不缓存：刷新序号每次挂载归零，保证回退一定走缓存。
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /**
   * 「当前源没给这部片详情」与「请求真的失败」要分开：
   * 前者（列表为空）在 TVBox 生态里很常见——发现/榜单型源本来就只给海报，
   * 不是客户端故障，不该画红色错误条；后者（抛异常）才按失败处理。
   */
  const [empty, setEmpty] = useState(false);
  const [reload, setReload] = useState(0);
  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [showSources, setShowSources] = useState(false);
  // 空详情（发现/推荐型源）时自动按片名去其它源找可播放版本的状态。
  const [fallback, setFallback] = useState<"idle" | "searching" | "none">(
    "idle",
  );
  const fallbackCancelRef = useRef(false);
  const [recoveryNotice] = useState(() => pendingRecoveryNotice);
  // dev StrictMode 会把 useState 初始化器跑两次：不能在初始化器里清空，否则
  // 第二次挂载读到 null、提示直接消失。改到 effect 里清（幂等，跑两次无碍）。
  useEffect(() => {
    if (recoveryNotice) {
      pendingRecoveryNotice = null;
    }
  }, [recoveryNotice]);
  // 历史进度刚在播放页写过，必须每次回到详情重新读，不能缓存成旧值。
  const [resume, setResume] = useState<HistoryItem | null>(null);
  /**
   * 豆瓣补全结果。`null` = 没有（未开启 / 没匹配上 / 请求失败），
   * 三者对界面是同一种状态：整块不渲染。
   */
  const [doubanMeta, setDoubanMeta] = useState<DoubanMeta | null>(null);

  /** 重新问一次源（错误页与「有内容但刷新失败」共用）。 */
  const retryDetail = () => {
    fallbackCancelRef.current = true;
    // 手动重试意味着用户不接受「这个源没详情」，把记忆清掉重新判定。
    noDetailSources.forget(siteKey);
    setReload((value) => value + 1);
  };

  useEffect(() => {
    // reload>0 是用户点了刷新图标；此时忽略缓存强制拉取最新播放列表。
    // `needFetch` 由首帧来源决定（交接实体必须补一次），因此不进依赖：它只在
    // 请求回来后置假，进依赖会让 effect 在「刚拿完结果」时再跑一轮。
    if (!needFetch && reload === 0) {
      return;
    }
    let alive = true;
    const run = async () => {
      setLoading(true);
      setError("");
      setEmpty(false);
      setFallback("idle");
      fallbackCancelRef.current = false;
      try {
        // 列表/搜索已给出的片名用于空详情自愈：旧 vod_id 失效时按名回查。
        const list = await api.detail(
          siteKey,
          vodId,
          reload > 0,
          (title || "").trim(),
        );
        if (!alive) {
          return;
        }
        // 源已经给过答复（有或没有）：不再需要补取。
        setNeedFetch(false);
        const first = list && list.length > 0 ? list[0] : null;
        if (!first) {
          setVod(null);
          // 不算异常：只是这个源没给播放列表（发现/榜单型源就是这样）。
          // 文案与后续动作分开处理，红色错误条只留给真正的请求失败。
          setEmpty(true);
          // 列表卡片若还在索引里，空态就退化成「卡片详情」而不是白板。
          setEmptyCard(recallCard(siteKey, vodId));
          // 发现型源（豆瓣[py] 等）连 searchContent 都没有，同站按名回查必然
          // 失败。这里直接用片名在其它站点找一个真能播的详情，成功就切过去；
          // 用户一旦手动操作（重试 / 打开换源面板）就中止，避免迟到结果跳页。
          const word = (title || "").trim();
          if (!word || skipCrossSource.has(`${siteKey}:${vodId}`)) {
            return;
          }
          setFallback("searching");
          void (async () => {
            try {
              const result = await findPlayableSource(
                word,
                sites,
                siteKey,
                () => alive && !fallbackCancelRef.current,
              );
              if (!alive || fallbackCancelRef.current) {
                return;
              }
              if (!result.found) {
                setFallback("none");
                log.warn("cross-source recovery found no playable candidate", {
                  siteKey,
                  vodId,
                  title: word,
                  probed: result.probed,
                });
                return;
              }
              const found = result.found;
              skipCrossSource.add(`${found.siteKey}:${found.vodId}`);
              pendingRecoveryNotice = `《${word}》在当前源没有播放列表，已切换到「${found.siteName || found.siteKey}」`;
              log.info("detail recovered from another source", {
                from: siteKey,
                to: found.siteKey,
                vodId: found.vodId,
                probed: result.probed,
              });
              navigate(
                {
                  name: "detail",
                  siteKey: found.siteKey,
                  vodId: found.vodId,
                  title: found.vodName,
                },
                true,
              );
            } catch (err) {
              if (alive) {
                setFallback("none");
                log.warn("cross-source recovery failed", {
                  siteKey,
                  vodId,
                  message: errorMessage(err),
                });
              }
            }
          })();
          return;
        }
        setVod(withKnownName(first, knownName));
        setFallback("idle");
        setEmpty(false);
      } catch (err) {
        if (alive) {
          // 不把已有内容清成白板：交接实体（或上一次的缓存）本来就够看，
          // 请求失败只报错，保留画面。
          setError(errorMessage(err));
          log.warn("detail failed", {
            siteKey,
            vodId,
            message: errorMessage(err),
          });
        }
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
    // vod 故意不进依赖：只在挂载 / 换源 / 手动刷新时决定是否请求，
    // 否则渲染过程中写入 vod 会立刻再触发一次 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, vodId, reload]);

  /**
   * 换源候选后台预取：搜索词与片名一致时搜索结果已缓存，这里直接跳过；
   * 从首页 / 收藏进入或搜索词只是片段时，补一次精确片名的全站检索。
   * 整个过程 fire-and-forget，不显示 loading、不影响详情首屏。
   */
  const prefetchTitle = (title?.trim() || vod?.vod_name?.trim() || "").trim();
  useEffect(() => {
    if (!prefetchTitle) {
      return;
    }
    // 详情首屏的 detailContent 先落地，再启动后台全站检索，避免抢首个请求。
    const timer = window.setTimeout(
      () => prefetchSources(prefetchTitle, sites),
      1200,
    );
    return () => window.clearTimeout(timer);
  }, [prefetchTitle, sites]);

  // 收藏与观看进度都是「看一眼就走」的旁路数据，失败不阻断详情浏览。
  const [resumeReady, setResumeReady] = useState(false);
  useEffect(() => {
    let alive = true;
    setResumeReady(false);
    void (async () => {
      // 两个旁路请求相互独立：串行会把「进详情页」的等待时间叠成两段 IPC。
      // 各自 catch 成 null，语义与原来「分别 try/catch 后落默认值」等价。
      const [favorites, history] = await Promise.all([
        api.favoritesList().catch(() => null),
        api.historyList().catch(() => null),
      ]);
      if (!alive) return;
      // 收藏按片名记录：换源后 siteKey/vodId 全变，但星标仍应是「已收藏」。
      setFavorite(
        favorites !== null &&
          favorites.some(
            (item) =>
              sameTitle(item.name, vod?.vod_name || title) ||
              (item.siteKey === siteKey && item.vodId === vodId),
          ),
      );
      // 历史按剧名去重：换源后 siteKey / vodId 会变，只有剧名完全匹配
      // 才能把上一次（可能来自别的源）的进度接上。
      const byTitle = (title ?? "").trim();
      setResume(
        history === null
          ? null
          : ((byTitle
              ? history.find((item) => item.name?.trim() === byTitle)
              : null) ??
              history.find(
                (item) => item.siteKey === siteKey && item.vodId === vodId,
              ) ??
              null),
      );
      // resume 的加载完成时间必须显式上报：自动定位线路要看这个信号，
      // 否则「lines 先到、历史后到」时定位会被只跑一次的守卫吞掉。
      setResumeReady(true);
    })();
    return () => {
      alive = false;
    };
    // title 不在依赖里会让「按剧名接续别的源的进度」永远等不到 title 到位。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, vodId, title]);

  /**
   * 豆瓣补全：进详情页自动问一次，等详情落地后再发（`vod_year` 到位时能避免
   * 同名片认错，也保证一次访问只发一次请求）。不预取首页、不在列表里发。
   * 拿不到就是 `null`——不渲染区块、不弹提示、不占位，详情照旧显示源站信息。
   * 同一片名+年份的去重与并发合并都在 `src/lib/douban.ts` 里，从播放页返回
   * 详情（组件重新挂载）不会重复打豆瓣。设置关闭时该函数直接返回 null。
   */
  const doubanTitle = (vod?.vod_name || emptyCard?.vod_name || title || "").trim();
  const doubanYear = (vod?.vod_year || emptyCard?.vod_year || "").trim();
  // 源自带豆瓣 subject id 时按 id 直取（实测 62% 的 CMS 条目有），省掉搜索那一跳。
  const doubanSubjectId = (vod?.vod_douban_id || emptyCard?.vod_douban_id || "").trim();
  useEffect(() => {
    // 片名/年份变了先清空：详情页在同一条路由上换片时组件不卸载，
    // 不清会出现「上一部片的评分挂在新片下面」。
    setDoubanMeta(null);
    // 片名一到位就并行去拉豆瓣，**不等详情加载完**：源站详情慢的时候
    // （布布追剧实测 9s）先按源站字段把这一屏画出来，豆瓣到了再升级，
    // 而不是「豆瓣没回来就一直空着 / 等详情回来才发豆瓣」。
    if (!doubanTitle) {
      return;
    }
    let alive = true;
    void (async () => {
      const meta = await fetchDoubanMeta(doubanTitle, doubanYear || undefined, {
        priority: true,
        subjectId: doubanSubjectId || undefined,
      });
      if (alive && meta) {
        setDoubanMeta(meta);
      }
    })();
    return () => {
      alive = false;
    };
  }, [doubanTitle, doubanYear, doubanSubjectId]);

  // 简介的溢出测量、展开/收起都在 `VodMetaHero` 里做：详情页与播放页共用
  // 同一份实现，避免两处口径漂移。

  const lines = useMemo(
    () => parsePlayLines(vod?.vod_play_from, vod?.vod_play_url),
    [vod],
  );
  const line = lines[lineIndex] ?? lines[0] ?? null;

  /** 集数多时（动辄上百集）提供名称/序号过滤与倒序，index 保留原序号。 */
  const episodes = useMemo(() => {
    const list = (line?.episodes ?? []).map((episode, index) => ({
      episode,
      index,
    }));
    const word = episodeQuery.trim().toLowerCase();
    const filtered = word
      ? list.filter(
          ({ episode, index }) =>
            episode.name.toLowerCase().includes(word) ||
            String(index + 1) === word,
        )
      : list;
    return reverse ? filtered.slice().reverse() : filtered;
  }, [line, episodeQuery, reverse]);

  /**
   * 「上次看到」一次只允许一格。
   *
   * 先定唯一目标再渲染：集名（同线路）优先，地址只作跨线路兜底。逐格用
   * `地址 || 集名` 做 OR 会双亮——历史存成「第 40 集的地址 + 第 37 集的集名」时，
   * 地址命中一格、集名又命中另一格。
   */
  const seenEpisode = useMemo(() => {
    if (!resume || !line) {
      return null;
    }
    if (resume.playFrom === line.name && resume.episodeName) {
      const byName = episodes.find(
        ({ episode }) => episode.name === resume.episodeName,
      );
      if (byName) {
        return byName;
      }
    }
    if (resume.playUrl) {
      return (
        episodes.find(({ episode }) => episode.url === resume.playUrl) ?? null
      );
    }
    return null;
  }, [resume, line, episodes]);

  /**
   * 打开详情页就定位到「上次用的那条线路」：历史记录里存的是线路名
   * （`playFrom`），源调整线路顺序后按名字仍找得准。定位只在**进入 / 换源**
   * 时执行一次，之后用户手动点 chip 不会被拉回去。历史读取是本地 SQLite
   * （几乎总比网络详情先到），不需要等 resume 迟到再补定位——那会把用户
   * 刚点选的线路又拉回「上次线路」。
   */
  const autoLineRef = useRef("");
  useEffect(() => {
    // resumeReady 是关键闸门：数据缓存 命中时 lines 几乎立刻就有，而历史是
    // 另一次 IPC。不等它的话，第一次 effect 会在 resume 尚为 null 时就把
    // 「已定位」标记写上，历史随后到达也再也不会定位（实测复现）。
    if (
      lines.length === 0 ||
      !resumeReady ||
      autoLineRef.current === detailKey
    ) {
      return;
    }
    autoLineRef.current = detailKey;
    const wanted = resume?.playFrom
      ? lines.findIndex((item) => item.name === resume.playFrom)
      : -1;
    if (wanted >= 0) {
      if (wanted !== lineIndex) {
        setLineIndex(wanted);
      }
      return;
    }
    // 没历史、或那条线路已经下架：持久化的索引越界时才回到第一条。
    if (lineIndex > lines.length - 1) {
      setLineIndex(0);
    }
  }, [detailKey, lines, resume, resumeReady, lineIndex, setLineIndex]);

  /** 「继续播放」优先回到历史里的那一集，否则从第一集开始。 */
  const quickPlay = useMemo(() => {
    if (resume) {
      // 首选上次那条线路：同一部剧的线路顺序可能变，按名字定位更稳。
      const preferred = resume.playFrom
        ? lines.find((item) => item.name === resume.playFrom)
        : undefined;
      const order = preferred
        ? [preferred, ...lines.filter((item) => item !== preferred)]
        : lines;
      for (const item of order) {
        const index = item.episodes.findIndex(
          (episode) => episode.url === resume.playUrl,
        );
        if (index >= 0) {
          return { line: item, episode: item.episodes[index], index };
        }
      }
      // 源的剧集地址换了（CDN 轮换很常见）：回到同线路、同名的那一集。
      if (preferred && resume.episodeName) {
        const index = preferred.episodes.findIndex(
          (episode) => episode.name === resume.episodeName,
        );
        if (index >= 0) {
          return { line: preferred, episode: preferred.episodes[index], index };
        }
      }
    }
    const first = lines[0];
    return first?.episodes.length
      ? { line: first, episode: first.episodes[0], index: 0 }
      : null;
  }, [lines, resume]);

  /**
   * 「继续播放」目标预取：用户从历史回来时十有八九就点它，先替源站把
   * playerContent + resolve_play 跑完写进集级缓存，播放页命中即省掉 1~18s。
   *
   * 只在有 `resume` 时做——没看过这部剧时「从第一集开始」的意图弱得多，
   * 不值得每次进详情都无条件打一次源。每个集地址一次，避免状态抖动反复触发。
   */
  const prefetchedRef = useRef(new Set<string>());
  useEffect(() => {
    if (!resume || !quickPlay) {
      return;
    }
    const episode = quickPlay.episode;
    const key = `${siteKey}|${quickPlay.line.name}|${episode.url}`;
    if (prefetchedRef.current.has(key)) {
      return;
    }
    prefetchedRef.current.add(key);
    void prefetchEpisodePlay(siteKey, quickPlay.line.name, episode.url);
  }, [resume, quickPlay, siteKey]);

  const playEpisode = (target: PlayLine, episode: Episode) => {
    // 详情页已经握着完整实体（含播放串）：交给播放页算线路与集定位，首帧直接成型，
    // 只剩「问源要地址」这一步真正需要等网络。
    if (vod) {
      putPlaySeed(siteKey, vod, episode.url);
    }
    navigate({
      name: "player",
      siteKey,
      vodId,
      vodName: vod?.vod_name ?? "",
      playUrl: episode.url,
      episodeName: episode.name,
      playFrom: target.name,
    });
  };

  const toggleFavorite = async () => {
    if (!vod || favBusy) {
      return;
    }
    setFavBusy(true);
    try {
      const next = await api.favoritesToggle(toVodRef(siteKey, siteName, vod));
      setFavorite(next);
      // 事件型反馈走全局 toast：不再往页面里插一行 `.tip` 把内容顶下去。
      if (next) {
        notify.success("已加入收藏");
      } else {
        notify.info("已取消收藏");
      }
    } catch (err) {
      notify.error("收藏失败，请重试");
      log.warn("favorite toggle failed", { message: errorMessage(err) });
    } finally {
      setFavBusy(false);
    }
  };

  /** 换源只替换当前详情页，避免返回键在几十个源之间来回绕。 */
  const pickSource = (option: SourceOption) => {
    fallbackCancelRef.current = true;
    setShowSources(false);
    navigate(
      {
        name: "detail",
        siteKey: option.siteKey,
        vodId: option.vodId,
        title: option.vodName,
      },
      true,
    );
  };

  if (loading && !vod) {
    return (
      <section className="page">
        <header className="page-head">
          <div className="page-head__main">
            <IconButton name="back" label="返回" onClick={onBack} />
            {/* 换源瞬间就能看到新源名，不必等详情请求回来。 */}
            <span className="detail-source" title={siteKey}>
              当前源：{siteName || siteKey}
            </span>
          </div>
        </header>
        <div className="page-body">
          {/* 骨架复刻真实版式：从收藏 / 历史点进来时，等待期间就能看出
              「马上出现的是海报 + 简介 + 剧集」，而不是一片空白里转个圈。
              只在**手上什么都没有**时用它——交接实体会自带 hero，不能压成骨架。 */}
          <DetailSkeleton />
        </div>
      </section>
    );
  }

  if (error || !vod) {
    const retry = retryDetail;
    const openSources = () => {
      fallbackCancelRef.current = true;
      setShowSources(true);
    };
    // 这个源已被证实「详情空 + 按名也搜不到」（含本次请求刚判定的）：直接
    // 说明它是榜单/推荐源，不让用户以为是客户端坏了。
    const known = !error && empty && noDetailSources.has(siteKey);
    // 卡片回填后，标题优先用卡片片名（`title` 只在从列表点进来时才有，
    // 收藏/历史直链进详情时只剩卡片这一条线索）。
    const cardTitle = (emptyCard?.vod_name || title || "").trim();
    /** 豆瓣也命中时，用它补上卡片/路由都没给出的片名。 */
    const searchWord = (cardTitle || doubanMeta?.title || "").trim();
    /**
     * 前台详情与后台会话是不是同一部片。
     *
     * 换源后 `siteKey + vodId` 会变，所以先按身份比，再退回片名（收藏/历史
     * 直链进详情时通常只剩片名这一条线索）。
     */
    const playingThis =
      !!playSession &&
      ((playSession.siteKey === siteKey && playSession.vodId === vodId) ||
        (!!playSession.vodName &&
          !!searchWord &&
          sameTitle(playSession.vodName, searchWord)));
    const emptyMeta = [
      emptyCard?.vod_remarks,
      emptyCard?.vod_year,
      emptyCard?.type_name,
    ]
      .filter((item): item is string => Boolean(item && String(item).trim()))
      .join(" · ");
    return (
      <section className="page">
        <header className="page-head">
          <IconButton name="back" label="返回" onClick={onBack} />
          <IconButton name="swap" label="换源" onClick={openSources} />
        </header>
        <div className="page-body">
          {error ? (
            <ErrorBar
              message="详情加载失败"
              hint={classifyFailure(undefined, error).label}
              detail={error}
              onRetry={retry}
            />
          ) : doubanMeta ? (
            /* 豆瓣命中、但源站没有详情与播放地址（发现/榜单型源）：直接用豆瓣
               资料渲染这一屏——用户要看的是「这部片是什么」，和一个「怎么把它
               放出来」的出口。与详情 hero 共用 `VodMetaHero`，版式不另起一套。 */
            <div className="detail-douban-page" role="status">
              <p className="detail-douban-page__tag">豆瓣信息 · 当前源只提供榜单</p>
              <VodMetaHero
                variant="detail"
                vod={emptyCard}
                douban={doubanMeta}
                fallbackName={cardTitle}
                posterPlaceholder="无封面"
                descriptionFallback="暂未获取到剧情简介。"
                footer={
                  searchWord ? (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() =>
                        navigate({ name: "search", keyword: searchWord })
                      }
                    >
                      <Icon name="search" />
                      全站搜索此片
                    </button>
                  ) : null
                }
              />
              <div className="detail-douban-page__foot">
                <p className="detail-empty__desc">
                  「{siteName || siteKey}
                  」是榜单/推荐型源：能给出片名、海报和评分，但没有播放地址。豆瓣资料已补全，想直接看的话换一个有片源的站点。
                </p>
                {fallback === "searching" || fallback === "none" ? (
                  <p className="detail-empty__hint">
                    {fallback === "searching"
                      ? `正在按片名从其它源查找${searchWord ? `《${searchWord}》` : ""}的可播放版本，找到后会自动切换…`
                      : "已按片名在其它源查找，暂时没有找到可播放的版本。"}
                  </p>
                ) : null}
                <div className="detail-empty__actions">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={openSources}
                  >
                    换源
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={retry}
                  >
                    重试
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* 居中容器：空态是这一屏唯一的内容，贴左上角会显得「页面没渲染完」；
               垂直居中后上下留白对称，视线自然落在海报与下一步动作上。 */
            <div className="detail-empty-wrap">
              <div
                className={
                  emptyCard ? "detail-empty detail-empty--card" : "detail-empty"
                }
                role="status"
              >
                {emptyCard && emptyCardImage.src ? (
                  <div className="detail-empty__poster">
                    <img
                      src={emptyCardImage.src}
                      alt={emptyCard.vod_name || ""}
                      onError={emptyCardImage.onError}
                    />
                  </div>
                ) : null}
                <div className="detail-empty__body">
                  <p className="detail-empty__title">
                    {playingThis
                      ? `《${playSession?.vodName || cardTitle}》正在后台播放`
                      : cardTitle
                        ? `《${cardTitle}》`
                        : known
                          ? `「${siteName || siteKey}」不提供播放列表`
                          : "当前源没有返回影片详情"}
                  </p>
                  {emptyMeta ? (
                    <p className="detail-empty__meta">{emptyMeta}</p>
                  ) : null}
                  <p className="detail-empty__desc">
                    {playingThis
                      ? "播放器还在播这部片；这个源这次没返回详情，可以直接回去接着看，或换一个有片源的站点。"
                      : emptyCard
                        ? `「${siteName || siteKey}」是榜单/推荐型源：能给出片名、海报和评分，但没有影片详情与播放地址。想看这部片，换一个有片源的站点即可。`
                        : known
                          ? "这类源只提供榜单/推荐（海报、评分、片名），点任何影片都不会有剧集，换片也一样。"
                          : "可能是影片 id 失效或站点临时波动，也可能是这个源只做发现/推荐。"}
                  </p>
                  {fallback === "searching" || fallback === "none" ? (
                    <p className="detail-empty__hint">
                      {fallback === "searching"
                        ? `正在按片名从其它源查找${cardTitle ? `《${cardTitle}》` : ""}的可播放版本，找到后会自动切换…`
                        : "已按片名在其它源查找，暂时没有找到可播放的版本。"}
                    </p>
                  ) : null}
                  <div className="detail-empty__actions">
                    {playingThis && playSession ? (
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() => navigate({ name: "player", ...playSession })}
                      >
                        回到播放
                      </button>
                    ) : cardTitle ? (
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        onClick={() =>
                          navigate({ name: "search", keyword: cardTitle })
                        }
                      >
                        全站搜索此片
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`btn btn--sm ${cardTitle || playingThis ? "btn--ghost" : "btn--primary"}`}
                      onClick={openSources}
                    >
                      换源
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={retry}
                    >
                      重试
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
          {showSources ? (
            <SourcePicker
              title={title || ""}
              currentSiteKey={siteKey}
              currentSiteName={siteName}
              sites={sites}
              onPick={pickSource}
              onClose={() => setShowSources(false)}
            />
          ) : null}
        </div>
      </section>
    );
  }

  const site = sites.find((item) => item.key === siteKey);
  const cacheAge = ageCached(detailKey);
  const cacheLabel =
    cacheAge === undefined
      ? ""
      : cacheAge < 60_000
        ? "刚缓存"
        : `${Math.floor(cacheAge / 60_000)} 分钟前缓存`;

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <IconButton name="back" label="返回" onClick={onBack} />
          <span className="detail-source" title={siteKey}>
            当前源：{siteName || siteKey}
          </span>
          {cacheLabel ? (
            <span
              className="page-meta"
              title="播放列表来自本次会话的缓存，点刷新可强制重新拉取"
            >
              {cacheLabel}
            </span>
          ) : null}
        </div>
        <div className="iconbar">
          <IconButton
            name="swap"
            label="换源"
            onClick={() => setShowSources(true)}
          />
          <IconButton
            name="refresh"
            label="刷新"
            busy={loading}
            onClick={() => setReload((value) => value + 1)}
            disabled={loading}
          />
        </div>
      </header>

      <div className="page-body">
        {recoveryNotice ? (
          <p className="tip tip--ok">{recoveryNotice}</p>
        ) : null}
        {error ? (
          // 有内容（交接实体或上一次的缓存）但请求失败：保留画面，只报错。
          <ErrorBar
            message="详情加载失败"
            hint={classifyFailure(undefined, error).label}
            detail={error}
            onRetry={retryDetail}
          />
        ) : null}
        {site?.changeable === false ? (
          <p className="tip">
            该源声明
            changeable=0（不建议作为换源目标）；按片名跨源查找仍会进行，手动换源也可用。
          </p>
        ) : null}

        <VodMetaHero
          variant="detail"
          vod={vod}
          douban={doubanMeta}
          // 源站片名可能为空（见 withKnownName）：路由/卡片带过来的片名是这一屏
          // 唯一的「叫什么」证据，必须传下去，否则整页标题是「未命名」。
          fallbackName={knownName || emptyCard?.vod_name || ""}
          descriptionFallback="暂无简介"
          posterPlaceholder={vod.vod_pic || doubanMeta?.pic ? "无封面" : ""}
          titleExtra={
            <FavStar
              on={favorite}
              busy={favBusy}
              onToggle={() => void toggleFavorite()}
            />
          }
          footer={
            /* 按钮只留动作本身：线路有 chip 的「上次」角标、集数有剧集格的「上次看到」，
               进度这类细节放 hover 提示里，不占按钮文案。 */
            <button
              type="button"
              className="btn btn--primary"
              disabled={!quickPlay}
              onClick={() =>
                quickPlay && playEpisode(quickPlay.line, quickPlay.episode)
              }
              title={
                resume && quickPlay
                  ? `上次看到：${resume.episodeName || `第 ${quickPlay.index + 1} 集`} · ${formatDuration(resume.positionMs ?? 0)}`
                  : undefined
              }
            >
              <Icon name="play" />
              {resume && quickPlay ? "继续播放" : "播放第 1 集"}
            </button>
          }
        />

        {/* 豆瓣信息已并入上面的 hero（命中时替换源站元数据），不再单独占一块。 */}

        <div className="section">
          <div className="section-head">
            <h2 className="section-title">播放线路</h2>
            <span className="page-meta">
              {/* 与播放页选集面板同口径：各线路是独立剧集表，不做跨线路累加。
                  还没有目录时不占位，下面的正文只给一句「正在获取剧集…」。 */}
              {lines.length === 0
                ? null
                : `${lines.length} 条线路 · 当前线路 ${line?.episodes.length ?? 0} 集`}
            </span>
          </div>
          {lines.length === 0 ? (
            loading ? (
              // 交接实体只有片名/海报，没有播放串：这里必须说清在等什么，
              // 否则「暂无可播放剧集」会把人误判成这个源没有片。
              <p className="page-meta">正在获取剧集…</p>
            ) : (
              <Empty
                title="暂无可播放剧集"
                description="该影片没有提供播放地址，可试试手动换源。"
              />
            )
          ) : (
            <>
              {/* `chip-row--lines` 是给探针/脚本的稳定锚点：分类 chip 也用
                `.chip-row .chip`，混在一起会把「2026」「大陆」当成线路点。 */}
              <div className="chip-row chip-row--lines">
                {lines.map((item, index) => {
                  const lastUsed = resume?.playFrom === item.name;
                  return (
                    <button
                      key={`${item.name}-${index}`}
                      type="button"
                      className={[
                        index === lineIndex ? "chip is-active" : "chip",
                        lastUsed ? "is-last" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      data-line={item.name}
                      onClick={() => setLineIndex(index)}
                      title={
                        lastUsed
                          ? `${item.episodes.length} 集 · 上次观看的线路`
                          : `${item.episodes.length} 集`
                      }
                    >
                      {lineLabel(item.name)}（{item.episodes.length}）
                    </button>
                  );
                })}
              </div>

              <div className="detail-episode-tools">
                <input
                  className="input"
                  type="text"
                  value={episodeQuery}
                  placeholder="筛选剧集名称 / 集号"
                  aria-label="筛选剧集"
                  onChange={(event) => setEpisodeQuery(event.target.value)}
                />
                <IconButton
                  name="sort"
                  label={reverse ? "正序" : "倒序"}
                  pressed={reverse}
                  className="icon-btn--flip"
                  onClick={() => setReverse((value) => !value)}
                />
                <span className="page-meta">显示 {episodes.length} 集</span>
                {/* 线路与集名都落到「上次那集」时给出显式提示：剧集多时高亮
                  那格通常在可视区外，光靠 `is-seen` 角标会让人以为没记住。 */}
                {resume?.episodeName && resume.playFrom === line?.name ? (
                  <span className="page-meta detail-episode-tools__seen">
                    上次看到：{resume.episodeName}
                  </span>
                ) : null}
              </div>

              {line ? (
                <div className="episode-grid">
                  {episodes.map((item) => (
                    <EpisodeButton
                      key={`${item.episode.url}-${item.index}`}
                      name={item.episode.name}
                      seen={item === seenEpisode}
                      onClick={() => playEpisode(line, item.episode)}
                    />
                  ))}
                </div>
              ) : null}
              {episodes.length === 0 ? (
                <Empty
                  title="没有匹配的剧集"
                  description="换个名称或集号再试。"
                />
              ) : null}
            </>
          )}
        </div>

        {showSources ? (
          <SourcePicker
            title={title || vod.vod_name}
            currentSiteKey={siteKey}
            currentSiteName={siteName}
            sites={sites}
            notice={
              site?.changeable === false
                ? "当前源禁止自动换源，手动切换仍由你决定。"
                : undefined
            }
            onPick={pickSource}
            onClose={() => setShowSources(false)}
          />
        ) : null}
      </div>
    </section>
  );
}
