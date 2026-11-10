import { useEffect, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { usePageState } from "../lib/usePageState";
import type { ResultPage } from "../types/tvbox";

interface CategoryPageProps {
  siteKey: string;
  tid: string;
  title: string;
  onBack: () => void;
  navigate: Navigate;
}

/** 分类页：网格 + 分页。 */
export default function CategoryPage({ siteKey, tid, title, onBack, navigate }: CategoryPageProps) {
  const stateKey = `category:${siteKey}:${tid}`;
  // 页码与结果都按「站点 + 分类」保留，看完详情返回时停在同一页。
  const [page, setPage] = usePageState<number>(`${stateKey}:page`, 1);
  const [data, setData] = usePageState<ResultPage | null>(`${stateKey}:${page}:data`, null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (data && reload === 0) {
      return;
    }
    let alive = true;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const result = await api.category(siteKey, tid, page, reload > 0);
        if (alive) {
          setData(result);
        }
      } catch (err) {
        if (alive) {
          setData(null);
          setError(errorMessage(err));
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
  }, [siteKey, tid, page, reload]);

  const list = data?.list ?? [];
  const pageCount = Math.max(1, data?.pagecount ?? 1);
  const current = data?.page ?? page;

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            ← 返回
          </button>
          <h1 className="page-title">{title}</h1>
        </div>
        <span className="page-meta">
          第 {current} / {pageCount} 页
        </span>
      </header>

      {error ? (
        <ErrorBar
          message={`分类加载失败：${error}`}
          onRetry={() => setReload((value) => value + 1)}
        />
      ) : null}

      {loading && list.length === 0 ? <Spinner label="正在加载分类内容…" /> : null}

      {!loading && !error && list.length === 0 ? (
        <Empty title="该分类暂无内容" description="换个分类或回到首页试试。" />
      ) : null}

      {list.length > 0 ? (
        <div className="vod-grid">
          {list.map((vod, index) => (
            <VodCard
              key={`${vod.vod_id}-${index}`}
              title={vod.vod_name}
              pic={vod.vod_pic}
              remarks={vod.vod_remarks}
              onOpen={() =>
                navigate({ name: "detail", siteKey, vodId: String(vod.vod_id) })
              }
            />
          ))}
        </div>
      ) : null}

      <div className="pager">
        <button
          type="button"
          className="btn"
          disabled={loading || page <= 1}
          onClick={() => setPage((value) => Math.max(1, value - 1))}
        >
          上一页
        </button>
        <span className="pager__label">
          {current} / {pageCount}
        </span>
        <button
          type="button"
          className="btn"
          disabled={loading || page >= pageCount}
          onClick={() => setPage((value) => value + 1)}
        >
          下一页
        </button>
      </div>
    </section>
  );
}
