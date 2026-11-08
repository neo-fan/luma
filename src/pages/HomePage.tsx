import { useEffect, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, toAppError } from "../lib/invoke";
import type { HomeResult, Site } from "../types/tvbox";

interface HomePageProps {
  sites: Site[];
  siteKey: string;
  onSiteChange: (key: string) => void;
  navigate: Navigate;
}

/** 首页：站点切换 + 分类标签 + 推荐网格。 */
export default function HomePage({ sites, siteKey, onSiteChange, navigate }: HomePageProps) {
  const [home, setHome] = useState<HomeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  const site = sites.find((item) => item.key === siteKey);
  const classes = home?.classes?.length ? home.classes : site?.categories ?? [];
  const list = home?.list ?? [];

  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (!siteKey) {
        setHome(null);
        setError("");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      // 冷启动或刚导入配置后，站点写入与页面挂载可能抢跑，失败时自动重试一次。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await api.home(siteKey);
          if (alive) {
            setHome(result);
            setError("");
            setLoading(false);
          }
          return;
        } catch (err) {
          if (!alive) {
            return;
          }
          if (attempt === 1) {
            setHome(null);
            setError(toAppError(err).message);
            setLoading(false);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }
      if (alive) {
        setLoading(false);
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [siteKey, reload]);

  if (sites.length === 0) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">首页</h1>
        </header>
        <Empty
          title="请先在设置导入配置"
          description="导入 TVBox 配置后，这里会列出可用的站点与推荐内容。"
          action={
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => navigate({ name: "settings" })}
            >
              前往设置
            </button>
          }
        />
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <div className="page-head__main">
          <h1 className="page-title">首页</h1>
          <select
            className="select"
            value={siteKey}
            onChange={(event) => onSiteChange(event.target.value)}
            aria-label="选择站点"
          >
            {sites.map((item) => {
              const unsupported = item.runtime === "jvm";
              const suffix = unsupported ? "（暂不支持）" : item.enabled ? "" : "（已禁用）";
              return (
                <option key={item.key} value={item.key} disabled={unsupported || !item.enabled}>
                  {item.name}
                  {suffix}
                </option>
              );
            })}
          </select>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => setReload((value) => value + 1)}
          disabled={!siteKey || loading}
        >
          刷新
        </button>
      </header>

      {error ? <ErrorBar message={`首页加载失败：${error}`} onRetry={() => setReload((v) => v + 1)} /> : null}

      {!siteKey ? (
        <Empty
          title="没有可用的 CMS 站点"
          description="当前配置里没有启用中的 CMS 站点，请检查配置或到设置重新导入。"
        />
      ) : null}

      {siteKey ? (
        <div className="chip-row">
          {classes.length === 0 ? (
            <span className="chip chip--muted">暂无分类</span>
          ) : (
            classes.map((item) => (
              <button
                key={item.type_id}
                type="button"
                className="chip"
                onClick={() =>
                  navigate({
                    name: "category",
                    siteKey,
                    tid: item.type_id,
                    title: item.type_name || "分类",
                  })
                }
              >
                {item.type_name || item.type_id}
              </button>
            ))
          )}
        </div>
      ) : null}

      {loading && list.length === 0 ? <Spinner label="正在加载首页内容…" /> : null}

      {!loading && siteKey && !error && list.length === 0 ? (
        <Empty title="该站点暂无推荐内容" description="可以换一个站点，或直接使用搜索。" />
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
    </section>
  );
}
