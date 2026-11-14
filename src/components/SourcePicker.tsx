import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import Empty from "./Empty";
import ErrorBar from "./ErrorBar";
import Icon from "./Icon";
import IconButton from "./IconButton";
import { errorMessage } from "../lib/invoke";
import {
  ensureSources,
  getSourceView,
  refreshSources,
  subscribeSourceCache,
  warmSourceDetails,
} from "../lib/sourceCache";
import type { SourceView } from "../lib/sourceCache";
import type { SourceOption } from "../lib/sources";
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

/** 部分源把 `0` / `-` / `None` 这类字段残留当备注返回，直接展示只是噪音。 */
function cleanRemark(raw?: string): string {
  const text = (raw ?? "").trim();
  if (!text) {
    return "";
  }
  if (/^[\d\s.]+$/.test(text) || /^[-—_.·/]+$/.test(text)) {
    return "";
  }
  return /^(none|null|unknown|暂无|无)$/i.test(text) ? "" : text;
}

/**
 * 配置里的源名常自带类型标注（`布布追剧[py]` / `360 | 采集`），再挂一枚
 * `python`/`cms` 徽章就是同一件事说两遍。名字已经交代过运行时就只留名字
 * （名字是配置原文，不改）。
 */
const RUNTIME_ALIASES: Record<string, RegExp> = {
  cms: /(采集|\bcms\b)/i,
  python: /(\bpy\b|python)/i,
  quickjs: /(\bjs\b|quickjs)/i,
  jvm: /\bjvm\b/i,
};

function declaresRuntime(siteName: string, runtime?: string): boolean {
  if (!runtime) {
    return false;
  }
  const alias = RUNTIME_ALIASES[runtime];
  return alias ? alias.test(siteName.trim()) : false;
}

/**
 * 手动换源面板：候选来自 sourceCache（搜索结果 + 详情页后台预取），打开
 * 即展示，不再在挂载时发一次 20s 全站聚合。仅「重新搜索」是显式请求；
 * 后台补全到达时订阅更新会自动合并，用户无需刷新。
 *
 * 与自动换源的区别：这里不探活、不排序抢答，完全由用户决定换到哪个源。
 *
 * 布局契约（探针依赖，勿改选择器名）：`.source-picker` / `__search input.input`
 * / `__meta`（含「个站点」文案）/ `.filter-toggle input` / `.source-item`
 * 内 `.source-item__site` `.source-item__title` 与含「切换」的按钮。
 * 行高统一 60px：备注长短不再是行高变量（单行省略号 + 固定列宽）。
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
  const keywordRef = useRef(title);
  const [view, setView] = useState<SourceView>(() =>
    getSourceView(title, sites, currentSiteKey),
  );
  const [searched, setSearched] = useState(
    () => getSourceView(title, sites, currentSiteKey).cached,
  );
  const [loading, setLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [error, setError] = useState("");
  const [onlyMatch, setOnlyMatch] = useState(true);
  const [picking, setPicking] = useState("");
  const aliveRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 挂载参数固定：sites / props 引用变化不应触发重新检索。 */
  const initialRef = useRef({ title, sites, currentSiteKey });

  useEffect(() => {
    aliveRef.current = true;
    const init = initialRef.current;
    const sync = (next: SourceView, markSearched = false) => {
      if (!aliveRef.current) {
        return;
      }
      setView(next);
      if (markSearched) {
        setSearched(true);
      }
    };
    const first = getSourceView(init.title, init.sites, init.currentSiteKey);
    sync(first, first.cached);

    if (init.title.trim()) {
      if (!first.cached) {
        // 详情页/播放页的后台预取可能已在跑：ensure 会共享同一个 Promise，
        // 不会重复向后端扇出；这里只显示加载态。
        setLoading(true);
        void ensureSources(init.title, init.sites, init.currentSiteKey)
          .then((next) => sync(next, true))
          .finally(() => {
            if (aliveRef.current) {
              setLoading(false);
            }
          });
      } else if (!first.complete) {
        // 搜索词只是片名片段：已有候选先直出，后台静默补全完整片名。
        setBackfilling(true);
        void ensureSources(init.title, init.sites, init.currentSiteKey)
          .then((next) => sync(next, true))
          .finally(() => {
            if (aliveRef.current) {
              setBackfilling(false);
            }
          });
      }
    }

    // 后台预取完成后才打开面板（或面板已打开）都要拿到最新候选。
    const unsubscribe = subscribeSourceCache(() =>
      sync(getSourceView(keywordRef.current, init.sites, init.currentSiteKey), true),
    );
    // Esc 由 Radix Dialog 统一处理（焦点陷阱 + 关闭），不再手挂 window keydown。
    return () => {
      aliveRef.current = false;
      unsubscribe();
    };
    // 只在挂载时建立订阅与首次判定；手动检索走 onSubmit。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 打开面板即预热前几个候选的播放列表，点「切换」时详情首屏直接命中。 */
  useEffect(() => {
    if (view.options.length > 0) {
      void warmSourceDetails(view.options);
    }
  }, [view]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading || backfilling) {
      return;
    }
    const word = keyword.trim();
    if (!word) {
      setError("请输入片名关键词");
      return;
    }
    keywordRef.current = word;
    setLoading(true);
    setError("");
    void refreshSources(word, sites, currentSiteKey)
      .then((next) => {
        if (aliveRef.current) {
          setView(next);
          setSearched(true);
        }
      })
      .catch((err) => {
        if (aliveRef.current) {
          setError(`检索失败：${errorMessage(err)}`);
        }
      })
      .finally(() => {
        if (aliveRef.current) {
          setLoading(false);
        }
      });
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

  const visible = onlyMatch ? view.options.filter((item) => item.matchScore >= 2) : view.options;
  const stats = view.stats;
  const missed = stats.failed + stats.skipped;
  // 运行配置里已屏蔽的 jvm（Android dex/jar）源不参与聚合，进度文案按可用站点数算。
  const eligibleCount = sites.filter(
    (site) => site.enabled && site.runtime !== "jvm",
  ).length;

  // 统计行压成一行「指标串」：原句 40 多字，在 720 面板里必然折行/被截，
  // 关键信息（多少站点响应、几个候选）反而被挤掉。
  const statsLine =
    `检索 ${stats.total} 个站点 · ${stats.ok} 响应 · ${stats.matched} 匹配源` +
    (stats.tookMs > 0 ? `（${(stats.tookMs / 1000).toFixed(1)}s）` : "") +
    (missed > 0 ? ` · ${missed} 失败/超时` : "");
  const originLabel =
    view.origin === "search"
      ? "来自搜索结果 · "
      : view.origin === "prefetch"
        ? "已后台预取 · "
        : view.origin === "manual"
          ? "本次检索 · "
          : view.origin === "mixed"
            ? "搜索 + 后台补全 · "
            : "";
  const metaText = loading
    ? `正在并发检索 ${eligibleCount} 个站点…`
    : searched || view.cached
      ? `${backfilling ? "后台补全中 · " : ""}${originLabel}${statsLine}`
      : "输入片名后检索其它站点";
  const cacheAge = view.ageMs === undefined ? "" : view.ageMs < 60_000
    ? "刚刚"
    : `${Math.floor(view.ageMs / 60_000)} 分钟前`;

  const busy = loading || backfilling;

  return (
    // Radix Dialog：焦点陷阱 / Esc / aria 由它统一管理。Content 直接铺满
    // 全屏遮罩（复用 .overlay），面板仍是普通子节点——探针依赖
    // `document.querySelector('.source-picker')` 及其子结构，DOM 契约不变。
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Content
          asChild
          className="overlay"
          aria-label="手动换源"
          // 默认焦点落在第一个可聚焦元素（右上角关闭），会顺手弹出「关闭」气泡；
          // 打开面板的意图是「改关键词」，焦点直接给输入框并全选，键入即替换。
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
        >
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
                <div className="source-picker__heading">
                  <h2 className="source-picker__title">手动换源</h2>
                  <p className="source-picker__sub">
                    <span className="source-picker__sub-label">当前源</span>
                    <span className="source-picker__badge">
                      {currentSiteName || currentSiteKey}
                    </span>
                    {currentSiteName && currentSiteKey && currentSiteName !== currentSiteKey
                      && /^[A-Za-z0-9_.:-]+$/.test(currentSiteKey) ? (
                      <code className="source-picker__key">{currentSiteKey}</code>
                    ) : null}
                  </p>
                </div>
                <IconButton name="close" label="关闭" onClick={onClose} />
              </header>

              <form className="source-picker__search" onSubmit={onSubmit}>
                <input
                  ref={inputRef}
                  className="input"
                  type="text"
                  value={keyword}
                  placeholder="片名关键词"
                  aria-label="换源检索关键词"
                  onChange={(event) => setKeyword(event.target.value)}
                />
                {/* 主操作是列表里的「切换」，检索只是重跑一次聚合，用次级按钮 */}
                <button type="submit" className="btn source-picker__research" disabled={busy}>
                  <Icon name="refresh" className={busy ? "is-spinning" : undefined} />
                  {busy ? "检索中" : "重新搜索"}
                </button>
              </form>

              <div className="source-picker__meta">
                <div className="source-picker__stats" title={metaText}>
                  {view.cached && !loading ? (
                    <span
                      className="source-cache-badge"
                      title="候选已缓存，点「切换」不再触发全站检索"
                    >
                      <Icon name="check" />
                      已缓存{cacheAge ? ` · ${cacheAge}` : ""}
                    </span>
                  ) : null}
                  <span className="source-picker__stats-text" role="status" aria-live="polite">
                    {metaText}
                    {view.pending && !loading ? " · 正在后台补全其它源" : ""}
                  </span>
                </div>
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

              <div
                className="source-picker__list"
                aria-busy={loading}
                // 整行可点：按钮只是「切换到 X」这个动作的可见落点，
                // 点行内任意空白同样有效（大热区），但点按钮本身不重复触发。
                onClick={(event) => {
                  const row = (event.target as HTMLElement).closest(".source-item");
                  if (!row || (event.target as HTMLElement).closest("button")) {
                    return;
                  }
                  const key = row.getAttribute("data-site-key");
                  const option = visible.find((item) => item.siteKey === key);
                  if (option) {
                    void pick(option);
                  }
                }}
              >
                {loading && view.options.length === 0 ? (
                  <div className="source-skel" aria-hidden="true">
                    {[0, 1, 2, 3].map((i) => (
                      <div className="source-skel__row" key={i}>
                        <span className="source-skel__avatar" />
                        <span className="source-skel__lines">
                          <span className="source-skel__line" />
                          <span className="source-skel__line source-skel__line--short" />
                        </span>
                        <span className="source-skel__btn" />
                      </div>
                    ))}
                  </div>
                ) : null}

                {!loading && searched && visible.length === 0 ? (
                  <Empty
                    title="没有找到其它片源"
                    description="试试去掉季数 / 清晰度后缀，或关闭「只看片名匹配」查看弱匹配结果。"
                  />
                ) : null}

                {visible.length > 0 ? (
                  <div className="source-list">
                    {visible.map((option) => {
                      const remark = cleanRemark(option.remarks);
                      const isPicking = picking === option.siteKey;
                      return (
                        <div
                          className="source-item"
                          key={`${option.siteKey}-${option.vodId}`}
                          data-site-key={option.siteKey}
                        >
                          <span className="source-item__avatar" aria-hidden="true">
                            {(option.siteName || "?").trim().slice(0, 1)}
                          </span>
                          <div className="source-item__main">
                            {/* 换源时真正要比较的是「哪个站」，片名在这里是一行
                                常量（同一次检索几乎完全相同），所以站点名做主语、
                                片名降到次行与集数/版本并列。片名不同（弱匹配）
                                时它就在次行第一位，正是需要被看到的位置。 */}
                            <strong className="source-item__site">
                              {option.siteName}
                              {option.runtime && !declaresRuntime(option.siteName, option.runtime) ? (
                                <small>{option.runtime}</small>
                              ) : null}
                            </strong>
                            <div className="source-item__meta">
                              <span className="source-item__title" title={option.vodName}>
                                {option.vodName}
                              </span>
                              {remark ? (
                                <span className="source-item__remark">{remark}</span>
                              ) : null}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn source-item__pick"
                            aria-label={`切换到 ${option.siteName}`}
                            aria-busy={isPicking || undefined}
                            disabled={isPicking}
                            onClick={() => void pick(option)}
                          >
                            {isPicking ? "切换中" : "切换"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <footer className="source-picker__foot">
                切换后直接读取已缓存的播放列表；不同源的线路、集数与清晰度可能有差异。
              </footer>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
