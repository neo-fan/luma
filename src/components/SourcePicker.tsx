import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Empty from "./Empty";
import ErrorBar from "./ErrorBar";
import Spinner from "./Spinner";
import { EMPTY_SOURCE_STATS, searchSources } from "../lib/sources";
import type { SourceOption, SourceSearchStats } from "../lib/sources";
import { errorMessage } from "../lib/invoke";
import type { Site } from "../types/tvbox";

interface SourcePickerProps {
  /** 默认检索词：当前影片片名。 */
  title: string;
  currentSiteKey: string;
  currentSiteName?: string;
  sites: Site[];
  /** 源级提示，例如 `changeable: 0` 的换源限制。 */
  notice?: string;
  /** 切换成功时调用；抛错则以错误提示留在面板内，由用户改选其它源。 */
  onPick: (option: SourceOption) => void | Promise<void>;
  onClose: () => void;
}

/**
 * 手动换源面板：一次聚合 IPC 检索全部启用站点，每站只列片名最匹配的一条。
 * 与自动换源的区别：这里不探活、不排序抢答，完全由用户决定换到哪个源，
 * 因此即使当前线路还能播，也可以主动切换到更清晰 / 集数更全的源。
 */
export default function SourcePicker({
  title,
  currentSiteKey,
  currentSiteName,
  sites,
  notice,
  onPick,
  onClose,
}: SourcePickerProps) {
  const [keyword, setKeyword] = useState(title);
  const [options, setOptions] = useState<SourceOption[]>([]);
  const [stats, setStats] = useState<SourceSearchStats>(EMPTY_SOURCE_STATS);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [onlyMatch, setOnlyMatch] = useState(true);
  const [timeoutMs, setTimeoutMs] = useState(20_000);
  const [picking, setPicking] = useState("");
  const aliveRef = useRef(true);
  /** 首次检索只在挂载时跑一次；sites 为空数组时的引用变化不应触发重搜。 */
  const initialRef = useRef({ title, sites, currentSiteKey });

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const run = async (word: string, list: Site[], current: string, limit: number) => {
    if (!word.trim()) {
      setError("请输入片名关键词");
      return;
    }
    setLoading(true);
    setError("");
    setOptions([]);
    setSearched(false);
    try {
      const result = await searchSources(word, list, current, limit);
      if (!aliveRef.current) {
        return;
      }
      setOptions(result.options);
      setStats(result.stats);
      setSearched(true);
    } catch (err) {
      if (aliveRef.current) {
        setError(`检索失败：${errorMessage(err)}`);
      }
    } finally {
      if (aliveRef.current) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    const init = initialRef.current;
    void run(init.title, init.sites, init.currentSiteKey, 20_000);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // 只在挂载时自动检索；手动检索走 onSubmit，不受 props 引用变化影响。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loading) {
      void run(keyword, sites, currentSiteKey, timeoutMs);
    }
  };

  const pick = async (option: SourceOption) => {
    if (picking) {
      return;
    }
    setPicking(option.siteKey);
    setError("");
    try {
      await onPick(option);
      if (aliveRef.current) {
        onClose();
      }
    } catch (err) {
      if (aliveRef.current) {
        setError(errorMessage(err));
      }
    } finally {
      if (aliveRef.current) {
        setPicking("");
      }
    }
  };

  const visible = onlyMatch ? options.filter((item) => item.matchScore >= 2) : options;
  const missed = stats.failed + stats.skipped;
  // 运行配置里已屏蔽的 jar / JS 源不参与聚合，进度文案要按可用站点数算。
  const eligibleCount = sites.filter(
    (site) => site.enabled && site.runtime !== "jvm" && site.runtime !== "quickjs",
  ).length;

  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="source-picker" role="dialog" aria-modal="true" aria-label="手动换源">
        <header className="source-picker__head">
          <div>
            <h2 className="source-picker__title">手动换源</h2>
            <p className="source-picker__sub">
              当前源：{currentSiteName || currentSiteKey}
              <span className="source-picker__badge">{currentSiteKey}</span>
            </p>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <form className="source-picker__search" onSubmit={onSubmit}>
          <input
            className="input"
            type="text"
            value={keyword}
            placeholder="片名关键词"
            aria-label="换源检索关键词"
            onChange={(event) => setKeyword(event.target.value)}
          />
          <select
            className="select"
            value={timeoutMs}
            aria-label="检索时长"
            title="慢源较多时放宽墙钟，可列出更多候选"
            onChange={(event) => setTimeoutMs(Number(event.target.value))}
          >
            <option value={20_000}>20 秒</option>
            <option value={35_000}>35 秒</option>
          </select>
          <button type="submit" className="btn btn--primary" disabled={loading}>
            {loading ? "搜索中…" : "重新搜索"}
          </button>
        </form>

        <div className="source-picker__meta">
          <span>
            {loading
              ? `正在并发检索 ${eligibleCount} 个站点…`
              : searched
                ? `检索 ${stats.total} 个站点，${stats.ok} 个响应，找到 ${stats.matched} 个片名匹配源` +
                  (stats.tookMs > 0 ? `（${(stats.tookMs / 1000).toFixed(1)}s）` : "") +
                  (missed > 0 ? `；${missed} 个站点失败或超时` : "")
                : "输入片名后检索其它站点"}
          </span>
          <label className="filter-toggle">
            <input
              type="checkbox"
              checked={onlyMatch}
              onChange={(event) => setOnlyMatch(event.target.checked)}
            />
            只看片名匹配
          </label>
        </div>

        {notice ? <p className="tip">{notice}</p> : null}
        {error ? <ErrorBar message={error} /> : null}

        <div className="source-picker__list">
          {loading && options.length === 0 ? <Spinner label="正在查找其它片源…" /> : null}
          {!loading && searched && visible.length === 0 ? (
            <Empty
              title="没有找到其它片源"
              description="试试去掉季数 / 清晰度后缀，或关闭「只看片名匹配」查看弱匹配结果。"
            />
          ) : null}
          {visible.map((option) => (
            <div className="source-item" key={`${option.siteKey}-${option.vodId}`}>
              <div className="source-item__main">
                <span className="source-item__site">
                  {option.siteName}
                  {option.runtime ? <small>{option.runtime}</small> : null}
                </span>
                <strong className="source-item__title">{option.vodName}</strong>
                {option.remarks ? (
                  <span className="source-item__remark">{option.remarks}</span>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn--primary"
                disabled={picking !== ""}
                onClick={() => void pick(option)}
              >
                {picking === option.siteKey ? "切换中…" : "切换"}
              </button>
            </div>
          ))}
        </div>

        <footer className="source-picker__foot">
          切换后会用新站点的同名影片继续；不同源的线路、集数和清晰度可能有差异。
        </footer>
      </div>
    </div>
  );
}
