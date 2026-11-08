import { useState } from "react";
import type { FormEvent } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, toAppError } from "../lib/invoke";
import type { Site, VodInfo } from "../types/tvbox";

const ALL_SITES = "__all__";

interface SearchPageProps {
  sites: Site[];
  siteKey: string;
  navigate: Navigate;
}

interface SearchHit {
  siteKey: string;
  siteName: string;
  vod: VodInfo;
}

/** 搜索页：单站点或全部站点串行检索。 */
export default function SearchPage({ sites, siteKey, navigate }: SearchPageProps) {
  const cmsSites = sites.filter((item) => item.runtime !== "jvm" && item.enabled);
  const [keyword, setKeyword] = useState("");
  const [target, setTarget] = useState(siteKey || ALL_SITES);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [failures, setFailures] = useState(0);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const runSearch = async () => {
    const word = keyword.trim();
    if (!word) {
      setError("请输入搜索关键词");
      return;
    }
    const targets =
      target === ALL_SITES
        ? cmsSites
        : cmsSites.filter((item) => item.key === target);

    if (targets.length === 0) {
      setError("请选择可用的 CMS 站点");
      return;
    }

    setLoading(true);
    setError("");
    setSearched(false);
    setFailures(0);
    setHits([]);

    try {
      const merged: SearchHit[] = [];
      let failed = 0;
      for (const site of targets) {
        try {
          const result = await api.search(site.key, word, 1);
          for (const vod of result.list ?? []) {
            merged.push({ siteKey: site.key, siteName: site.name, vod });
          }
        } catch {
          // 单站点失败不打断整体检索，只计数。
          failed += 1;
        }
      }
      setHits(merged);
      setFailures(failed);
      setSearched(true);
    } catch (err) {
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

      {loading ? <Spinner label="正在检索…" /> : null}

      {!loading && searched ? (
        <p className="result-meta">
          共 {hits.length} 条结果
          {failures > 0 ? `；${failures} 个站点检索失败，已跳过` : ""}
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
