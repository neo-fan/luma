import { useMemo, useState } from "react";
import EpisodeButton from "../EpisodeButton";
import IconButton from "../IconButton";
import { episodePanelView } from "../../lib/catalogState";
import type { CatalogStatus } from "../../lib/catalogState";
import type { PlayLine } from "../../lib/format";

interface EpisodePanelProps {
  lines: PlayLine[];
  panelLine: number;
  lineIndex: number;
  episodeIndex: number;
  /** 已请求、还没落地的集：那一格显示排队态，不代表正在播放。 */
  pendingPick?: { lineIndex: number; episodeIndex: number } | null;
  /**
   * 目录尚未拿到（首次从历史/收藏进入）：整个选集区进入加载态。
   * 换源/换集的线路数据在意图落地前就已经可用，不再用 loading 罩住面板。
   */
  loading?: boolean;
  /**
   * 目录数据链状态。与播放地址解析无关：地址失败时这里可以仍是 ready，
   * 面板照常给出剧集与换源。缺省 `ready`（带剧集调用方不需要关心）。
   */
  status?: CatalogStatus;
  /** 目录读取失败的原因，展示在空态里（换源 / 重试是此时仅有的两个出口）。 */
  error?: string;
  onRetry?: () => void;
  setPanelLine: (value: number) => void;
  goToEpisode: (targetLine: number, index: number) => void;
  /** 换源入口：线路 panel 统一管理「线路 + 剧集 + 换源」。 */
  onSwitchSource?: () => void;
}

/** 长剧集才值得给筛选框，短剧多一个输入框纯属噪音。 */
const FILTER_AT = 24;

/**
 * 选集区（常驻在播放器下方）：线路 chip 切换 + 全剧集直达。
 * 索引始终指向**原始**剧集数组，筛选/倒序只影响展示顺序。
 */
export default function EpisodePanel({
  lines,
  panelLine,
  lineIndex,
  episodeIndex,
  pendingPick = null,
  loading = false,
  status = "ready",
  error = "",
  onRetry,
  setPanelLine,
  goToEpisode,
  onSwitchSource,
}: EpisodePanelProps) {
  const [query, setQuery] = useState("");
  const [reverse, setReverse] = useState(false);

  const episodes = lines[panelLine]?.episodes ?? [];
  const view = episodePanelView(status, lines.length, episodes.length);
  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const indexed = episodes
      .map((episode, index) => ({ episode, index }))
      .filter(({ episode }) => !keyword || episode.name.toLowerCase().includes(keyword));
    return reverse ? indexed.reverse() : indexed;
  }, [episodes, query, reverse]);

  return (
    <section className={loading ? "player-episodes is-loading" : "player-episodes"}>
      <div className="section-head">
        <h2 className="section-title">选集</h2>
        <div className="player-episodes__head-actions">
          {/* 集数只按当前线路统计：各线路是独立剧集表，跨线路累加（160 集）
              没有意义，用户要的是「这条线路有多少集」。空态没有数字可给。 */}
          {view === "grid" || view === "empty" ? (
            <span className="page-meta">
              {lines.length} 条线路 · 当前线路 {episodes.length} 集
            </span>
          ) : null}
          {/* 换源与「有没有剧集」无关：目录没取到时它恰恰是唯一出路，不能跟着
              选集区一起消失（这正是「地址拿不到 → 换源也没了」的成因）。 */}
          {onSwitchSource ? (
            <IconButton name="swap" label="换源" onClick={onSwitchSource} />
          ) : null}
        </div>
      </div>

      {view === "loading" ? (
        <p className="tip player-episodes__state">正在读取剧集信息…</p>
      ) : null}

      {view === "error" ? (
        <div className="player-episodes__state player-episodes__state--error">
          <p className="tip">{error || "剧集信息获取失败"}</p>
          <div className="player-episodes__state-actions">
            {onRetry ? (
              <button type="button" className="btn btn--sm" onClick={onRetry}>
                重试
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {view === "loading" || view === "error" ? null : (
        <>
          {lines.length > 0 ? (
            <div className="chip-row">
              {lines.map((item, index) => (
                <button
                  key={`${item.name}-${index}`}
                  type="button"
                  className={[
                    index === panelLine ? "chip is-active" : "chip",
                    index === lineIndex ? "is-last" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  // 点线路 = 只切换下方的剧集列表（浏览哪条线路），不换播放源。
                  // 真正换流只发生在点某条线路下的「某一集」时——切线却刷新播放会打断
                  // 当前画面，且线路与集数两件事被混成一次操作。要换这条线的流，
                  // 就在列出的集里点一集。
                  onClick={() => {
                    if (index === panelLine) {
                      return;
                    }
                    setPanelLine(index);
                  }}
                  title={`查看 ${item.name}（${item.episodes.length} 集）${
                    index === lineIndex ? " · 正在播放的线路" : ""
                  }`}
                >
                  {item.name}（{item.episodes.length}）
                </button>
              ))}
            </div>
          ) : null}

          {episodes.length > FILTER_AT ? (
            <div className="player-episodes__tools">
              <input
                className="input"
                type="text"
                value={query}
                placeholder="筛选集数（如 12、第2季）"
                aria-label="筛选剧集"
                onChange={(event) => setQuery(event.target.value)}
              />
              <IconButton
                name="sort"
                label={reverse ? "正序" : "倒序"}
                pressed={reverse}
                className="icon-btn--flip"
                onClick={() => setReverse((v) => !v)}
              />
              <span className="page-meta">显示 {visible.length} 集</span>
            </div>
          ) : null}

          <div className="player-episodes__gridwrap">
            <div className="episode-grid" aria-busy={loading || undefined}>
              {visible.map(({ episode, index }) => {
                const active = panelLine === lineIndex && index === episodeIndex;
                const pending = !active &&
                  pendingPick !== null &&
                  pendingPick.lineIndex === panelLine &&
                  pendingPick.episodeIndex === index;                // 对应集按**索引位置**判定（不靠集名，源之间集名常对不齐）：其它线路里
                // 同序号那一集标灰点；该线路集数不够（索引越界）时夹到它的最后一集。
                // 倒序只换展示顺序，`index` 仍是原索引，对应关系不变。
                const corrIndex = Math.min(episodeIndex, episodes.length - 1);
                const corresponding =
                  !active && !pending && panelLine !== lineIndex && index === corrIndex;
                return (
                  <EpisodeButton
                    key={`${episode.url}-${index}`}
                    name={episode.name}
                    active={active}
                    pending={pending}
                    corresponding={corresponding}
                    onClick={() => goToEpisode(panelLine, index)}
                  />
                );
              })}
            </div>
            {loading ? (
              <div className="player-episodes__loading" aria-hidden="true">
                <span className="player-episodes__loading-spin" />
              </div>
            ) : null}
          </div>

          {visible.length === 0 ? (
            <p className="tip player-episodes__empty">
              {episodes.length === 0
                ? "这条线路没有可播放的剧集，可换一条线路或换源"
                : "没有匹配的集数"}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
