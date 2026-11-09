import { useState } from "react";
import type { FormEvent } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, toAppError } from "../lib/invoke";
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
}

/** 搜索页：单站点直连，全部站点走后端一次并发聚合。 */
export default function SearchPage({ sites, navigate }: SearchPageProps) {
  const cmsSites = sites.filter((item) => item.runtime !== "jvm" && item.enabled);
  const [keyword, setKeyword] = useState("");
  // A 100-site config makes single-site search the wrong default: users expect
  // one keyword to cover the whole active config.
  const [target, setTarget] = useState<string>(ALL_SITES);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [failures, setFailures] = useState(0);
  const [progress, setProgress] = useState("");
  const [searched, setSearched] = useState(false);
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
    setHits([]);
    setProgress("");

    try {
      const merged: SearchHit[] = [];

      if (target !== ALL_SITES) {
        const site = cmsSites.find((item) => item.key === target);
        if (!site) {
          setError("所选站点不可用，请重新选择");
          return;
        }
        const result = await api.search(site.key, word, 1);
        for (const vod of result.list ?? []) {
          merged.push({ siteKey: site.key, siteName: site.name, vod });
        }
      } else {
        if (cmsSites.length === 0) {
          setError("请先导入一份配置");
          return;
        }
        setProgress(`正在并发检索 ${cmsSites.length} 个站点（最长 ${ALL_TIMEOUT_MS / 1000} 秒）…`);
        // 一次 IPC 让 Rust 并发扇出；串行逐站调用在 100+ 站点的配置下要等几分钟。
        const agg = (await api.spiderInvoke({
          siteKey: "all",
          method: "searchContent",
          args: [word, false, 1],
          timeoutMs: ALL_TIMEOUT_MS,
        })) as AggregateResult;
        const names = new Map(cmsSites.map((item) => [item.key, item.name]));
        for (const row of agg.results ?? []) {
          if (!row.ok) {
            continue;
          }
          for (const vod of row.data?.list ?? []) {
            merged.push({
              siteKey: row.siteKey,
              siteName: names.get(row.siteKey) ?? row.siteKey,
              vod,
            });
          }
        }
        setProgress(
          `${agg.ok}/${agg.total} 个站点响应，耗时 ${(agg.tookMs / 1000).toFixed(1)} 秒`,
        );
        setFailures(agg.failed + (agg.skipped ?? 0));
      }

      setHits(merged);
      setSearched(true);
    } catch (err) {
      setFailures(1);
      setError(toAppError(err).message);
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
          {cmsSites.map((site) => (
            <option key={site.key} value={site.key}>
              {site.name}
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
          {failures > 0 ? `；${failures} 个站点失败或超时，已跳过` : ""}
        </p>
      ) : null}

      {!loading && searched && hits.length === 0 ? (
        <Empty title="没有找到相关内容" description="换个关键词，或选择其它站点再试。" />
      ) : null}

      {hits.length > 0 ? (
        <div className="vod-grid">
          {hits.map((hit, index) => (
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
                })
              }
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
