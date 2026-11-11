import { useState } from "react";
import type { FormEvent } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { usePageState } from "../lib/usePageState";
import { rankByTitle, titleMatchScore } from "../lib/format";
import { publishSearchResults } from "../lib/sourceCache";
import type { ResultPage, Site, VodInfo } from "../types/tvbox";

const ALL_SITES = "__all__";
/** 全站聚合的墙钟：与后端每源超时一致，超时后返回已完成的源。 */
const ALL_TIMEOUT_MS = 20_000;

interface AggregateRow {
  siteKey: string;
  ok: boolean;
  data?: ResultPage;
  error?: { code?: string; message?: string };
}

interface AggregateResult {
  results: AggregateRow[];
  ok: number;
  failed: number;
  total: number;
  skipped?: number;
  tookMs: number;
}

interface SearchPageProps {
  sites: Site[];
  navigate: Navigate;
}

interface SearchHit {
  siteKey: string;
  siteName: string;
  vod: VodInfo;
  /** 片名与关键词的相关度，见 titleMatchScore；用于置顶和「只看匹配」。 */
  matchScore: number;
}

/** 搜索页：单站点直连，全部站点走后端一次并发聚合。 */
export default function SearchPage({ sites, navigate }: SearchPageProps) {
  // P2: jar sites are dispatchable now. Keep them selectable so a failing
  // source shows its reason instead of silently disappearing from the list.
  const selectableSites = sites.filter((item) => item.enabled);
  // 聚合搜索要 12~20 秒；点进详情再返回时不应把结果清空重搜。
  // 只有 loading / error 是瞬时状态，其余都留在页面快照里。
  const K = "search:state:";
  const [keyword, setKeyword] = usePageState<string>(`${K}keyword`, "");
  // A 100-site config makes single-site search the wrong default: users expect
  // one keyword to cover the whole active config.
  const [target, setTarget] = usePageState<string>(`${K}target`, ALL_SITES);
  const [hits, setHits] = usePageState<SearchHit[]>(`${K}hits`, []);
  const [matchCount, setMatchCount] = usePageState<number>(`${K}matchCount`, 0);
  /** 视图偏好，跨搜索保留；不改后端返回，只影响渲染哪些卡片。 */
  const [onlyMatches, setOnlyMatches] = usePageState<boolean>(`${K}onlyMatches`, false);
  const [failures, setFailures] = usePageState<number>(`${K}failures`, 0);
  /** 源级降级原因（规格 14 节）：按出现次数取前三条，避免刷屏。 */
  const [failureReasons, setFailureReasons] = usePageState<string[]>(`${K}failureReasons`, []);
  const [progress, setProgress] = usePageState<string>(`${K}progress`, "");
  const [searched, setSearched] = usePageState<boolean>(`${K}searched`, false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const runSearch = async () => {
    const word = keyword.trim();
    if (!word) {
      setError("请输入搜索关键词");
      return;
    }
    setLoading(true);
    setError("");
    setSearched(false);
    setFailures(0);
    setFailureReasons([]);
    setHits([]);
    setMatchCount(0);
    setProgress("");

    try {
      const merged: SearchHit[] = [];

      if (target !== ALL_SITES) {
        const site = selectableSites.find((item) => item.key === target);
        if (!site) {
          setError("所选站点不可用，请重新选择");
          return;
        }
        const result = await api.search(site.key, word, 1);
        for (const vod of result.list ?? []) {
          merged.push({
            siteKey: site.key,
            siteName: site.name,
            vod,
            matchScore: titleMatchScore(vod.vod_name, word),
          });
        }
      } else {
        if (selectableSites.length === 0) {
          setError("请先导入一份配置");
          return;
        }
        setProgress(`正在并发检索 ${selectableSites.length} 个站点（最长 ${ALL_TIMEOUT_MS / 1000} 秒）…`);
        // 一次 IPC 让 Rust 并发扇出；串行逐站调用在 100+ 站点的配置下要等几分钟。
        const agg = (await api.spiderInvoke({
          siteKey: "all",
          method: "searchContent",
          args: [word, false, 1],
          timeoutMs: ALL_TIMEOUT_MS,
        })) as AggregateResult;
        const names = new Map(selectableSites.map((item) => [item.key, item.name]));
        const seen = new Set<string>();
        for (const row of agg.results ?? []) {
          if (!row.ok) {
            continue;
          }
          for (const vod of row.data?.list ?? []) {
            // A site can appear in several aggregate rows, and some sources
            // repeat an id. De-duplicate before rendering so no duplicate
            // cards show up; entries without an id are left untouched.
            const id = vod.vod_id ? `${row.siteKey}:${vod.vod_id}` : "";
            if (id && seen.has(id)) {
              continue;
            }
            if (id) {
              seen.add(id);
            }
            merged.push({
              siteKey: row.siteKey,
              siteName: names.get(row.siteKey) ?? row.siteKey,
              vod,
              matchScore: titleMatchScore(vod.vod_name, word),
            });
          }
        }
        setProgress(
          `${agg.ok}/${agg.total} 个站点响应，耗时 ${(agg.tookMs / 1000).toFixed(1)} 秒`,
        );
        // 搜索结果就是换源候选：立刻发布给 sourceCache，点进详情后
        // 「⇄ 换源」直接读缓存，不必再发一次 20s 全站聚合。
        // 单站搜索只覆盖一个站点，不发布（否则会被误判为「已检索全站」），
        // 由详情页的后台预取补全。
        publishSearchResults(
          word,
          agg.results ?? [],
          selectableSites,
          {
            total: agg.total ?? selectableSites.length,
            ok: agg.ok ?? 0,
            failed: agg.failed ?? 0,
            skipped: agg.skipped ?? 0,
            tookMs: agg.tookMs ?? 0,
            matched: 0, // 由 sourceCache 按当前片名重算
          },
          "search",
        );
        // 后端可能一个站点都没跑（active 配置为空 / 站点全被过滤）。
        // 静默显示空结果会让人以为是片源没搜到，明确提示去重新导入。
        if (agg.total === 0) {
          setError("当前配置没有可搜索的站点，请到「设置」重新导入配置");
        }
        // Group identical failures so 28 csp_* sites sharing one Android dex
        // jar produce one readable reason instead of 28 identical lines.
        const reasons = new Map<string, number>();
        for (const row of agg.results ?? []) {
          if (row.ok) {
            continue;
          }
          const message = row.error?.message || row.error?.code || "未知错误";
          reasons.set(message, (reasons.get(message) ?? 0) + 1);
        }
        setFailureReasons(
          [...reasons.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([message, count]) => `${message}（${count} 个站点）`),
        );
        setFailures(agg.failed + (agg.skipped ?? 0));
      }

      // 源站回退推荐列表 / 单字模糊匹配会把精确命中冲到几十条之后。
      // 先按片名相关度稳定置顶，再交给 UI；不丢弃任何结果。
      const ranked = rankByTitle(merged, word, (hit) => hit.vod.vod_name);
      setHits(ranked);
      setMatchCount(ranked.filter((hit) => hit.matchScore >= 2).length);
      setSearched(true);
    } catch (err) {
      setFailures(1);
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) {
      return;
    }
    void runSearch();
  };

  const visibleHits = onlyMatches
    ? hits.filter((hit) => hit.matchScore >= 2)
    : hits;

  return (
    <section className="page">
      <header className="page-head">
        <h1 className="page-title">搜索</h1>
      </header>

      <form className="search-bar" onSubmit={onSubmit}>
        <input
          className="input"
          type="text"
          value={keyword}
          placeholder="输入片名关键词"
          onChange={(event) => setKeyword(event.target.value)}
        />
        <select
          className="select"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          aria-label="选择搜索站点"
        >
          <option value={ALL_SITES}>全部站点</option>
          {selectableSites.map((site) => (
            <option key={site.key} value={site.key}>
              {site.name}
              {site.runtime === "jvm" ? "（jar 源）" : ""}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn--primary" disabled={loading}>
          {loading ? "搜索中…" : "搜索"}
        </button>
      </form>

      {error ? <ErrorBar message={error} /> : null}

      {loading ? <Spinner label={progress || "正在检索…"} /> : null}

      {!loading && searched ? (
        <p className="result-meta">
          {progress ? `${progress}；` : ""}共 {hits.length} 条结果
          {matchCount > 0 ? `；其中 ${matchCount} 条片名匹配` : ""}
          {onlyMatches ? `；当前显示 ${visibleHits.length} 条` : ""}
          {failures > 0 ? `；${failures} 个站点失败或超时，已跳过` : ""}
        </p>
      ) : null}

      {!loading && searched && failureReasons.length > 0 ? (
        <p className="result-meta" style={{ opacity: 0.72, fontSize: 12 }}>
          未响应源的原因：{failureReasons.join("；")}
        </p>
      ) : null}

      {!loading && searched &&
      hits.length > 0 &&
      matchCount > 0 &&
      matchCount < hits.length ? (
        <label className="filter-toggle">
          <input
            type="checkbox"
            checked={onlyMatches}
            onChange={(event) => setOnlyMatches(event.target.checked)}
          />
          只看片名匹配（{matchCount} 条）
        </label>
      ) : null}

      {!loading && searched && visibleHits.length === 0 ? (
        <Empty
          title={hits.length === 0 ? "没有找到相关内容" : "没有片名匹配的结果"}
          description={
            hits.length === 0
              ? "换个关键词，或选择其它站点再试。"
              : "关闭「只看片名匹配」可查看其它站点返回的结果。"
          }
        />
      ) : null}

      {visibleHits.length > 0 ? (
        <div className="vod-grid">
          {visibleHits.map((hit, index) => (
            <VodCard
              key={`${hit.siteKey}-${hit.vod.vod_id}-${index}`}
              title={hit.vod.vod_name}
              pic={hit.vod.vod_pic}
              remarks={hit.vod.vod_remarks}
              sub={hit.siteName}
              onOpen={() =>
                navigate({
                  name: "detail",
                  siteKey: hit.siteKey,
                  vodId: String(hit.vod.vod_id),
                  // 带上片名：详情还没回来就能启动后台换源预取。
                  title: hit.vod.vod_name,
                })
              }
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
