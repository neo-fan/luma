import { useEffect, useRef, useState } from "react";
import type { Navigate } from "../App";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import VodCard from "../components/VodCard";
import { api, errorMessage } from "../lib/invoke";
import { usePageState } from "../lib/usePageState";
import type { HomeResult, Site } from "../types/tvbox";

interface HomePageProps {
  sites: Site[];
  siteKey: string;
  onSiteChange: (key: string) => void;
  navigate: Navigate;
}

/**
 * 站点切换防抖窗口：下拉连点时只在用户停下后发一次请求。
 * 300ms 足够覆盖「按住方向键快速扫过多个站点 / 连续点选」，又不会让
 * 正常切换显得迟钝。
 */
const SWITCH_DEBOUNCE_MS = 300;

/** 首页：站点切换 + 分类标签 + 推荐网格。 */
export default function HomePage({ sites, siteKey, onSiteChange, navigate }: HomePageProps) {
  // 首页推荐内容按站点保留，返回首页时直接出结果；站点 key 变化时自然失效。
  const [home, setHome] = usePageState<HomeResult | null>(`home:${siteKey}:data`, null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  /** 下拉的即时值；真正的 siteKey 由防抖后的 onSiteChange 更新。 */
  const [draftSite, setDraftSite] = useState(siteKey);
  /** 下一次 siteKey 生效时是否跳过缓存（用户主动切换 = 自动刷新）。 */
  const forceNextRef = useRef<string | null>(null);
  const switchTimerRef = useRef<number | null>(null);

  const site = sites.find((item) => item.key === siteKey);
  const classes = home?.classes?.length ? home.classes : site?.categories ?? [];
  const list = home?.list ?? [];
  const selectedSite = sites.some((item) => item.key === draftSite) ? draftSite : siteKey;

  // 外部 siteKey 变化（配置加载、App 恢复偏好）时同步下拉显示。
  useEffect(() => {
    setDraftSite(siteKey);
  }, [siteKey]);

  useEffect(() => {
    return () => {
      if (switchTimerRef.current !== null) {
        window.clearTimeout(switchTimerRef.current);
      }
    };
  }, []);

  /**
   * 站点切换：立即更新下拉显示，300ms 后才真正切换并强制刷新。
   * 快速 A→B→C 只会请求 C；C 与当前站点相同时直接取消，不发请求。
   */
  const switchSite = (next: string) => {
    setDraftSite(next);
    if (switchTimerRef.current !== null) {
      window.clearTimeout(switchTimerRef.current);
    }
    switchTimerRef.current = window.setTimeout(() => {
      switchTimerRef.current = null;
      if (next === siteKey) {
        return;
      }
      forceNextRef.current = next;
      onSiteChange(next);
    }, SWITCH_DEBOUNCE_MS);
  };

  useEffect(() => {
    const force = forceNextRef.current === siteKey;
    if (force) {
      forceNextRef.current = null;
    }
    // 已有缓存内容、且不是手动刷新 / 主动切站点：跳过整个请求，不闪 Spinner。
    if (home && reload === 0 && !force) {
      return;
    }
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
          const result = await api.home(siteKey, reload > 0 || force);
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
            setError(errorMessage(err));
            setLoading(false);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 600));
          if (!alive) {
            return;
          }
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

  if (sites.length > 0 && !siteKey) {
    return (
      <section className="page">
        <header className="page-head">
          <h1 className="page-title">首页</h1>
        </header>
        <Empty
          title={`当前配置的 ${sites.length} 个站点都需要 jar 运行时`}
          description="这些是 csp_/jar 源，依赖 Android 运行时（P2）。可以先用「直播」页，或导入含 CMS / py / js 站点的配置。"
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
            value={selectedSite}
            onChange={(event) => switchSite(event.target.value)}
            aria-label="选择站点"
          >
            {sites.map((item) => {
              // Old localStorage caches have no disabledReason: a jvm site is
              // still blocked there even though `enabled` says true.
              const blocked = Boolean(item.disabledReason) || item.runtime === "jvm";
              const suffix = blocked ? "（已屏蔽）" : item.enabled ? "" : "（已禁用）";
              return (
                <option key={item.key} value={item.key} disabled={blocked || !item.enabled}>
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
                navigate({
                  name: "detail",
                  siteKey,
                  vodId: String(vod.vod_id),
                  title: vod.vod_name,
                })
              }
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
