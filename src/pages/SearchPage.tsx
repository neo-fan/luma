import { SearchX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Navigate } from "../lib/nav";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Icon from "../components/Icon";
import IconButton from "../components/IconButton";
import SiteSelect from "../components/SiteSelect";
import SearchSkeleton from "../components/Skeleton";
import VodCard from "../components/VodCard";
import { api, errorMessage, toAppError } from "../lib/invoke";
import { usePageState } from "../lib/usePageState";
import { rankByTitle, titleMatchScore } from "../lib/format";
import {
  clearSearchHistory,
  pushSearchHistory,
  readSearchHistory,
  removeSearchHistory,
} from "../lib/searchHistory";
import { publishSearchResults } from "../lib/sourceCache";
import { classifyFailure, groupFailures } from "../lib/failureReason";
import { log } from "../lib/logger";
import type { ResultPage, Site, VodInfo } from "../types/tvbox";

const ALL_SITES = "__all__";
// 流式全站搜索不限总墙钟（用户要求）：每站受后端默认 15s 单站超时约束，
// 结果陆续上屏、全部站点跑完才收尾；用户随时可取消。

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
  /** 带着片名跳进来（空详情页的「全站搜索此片」）：落地即搜一次。 */
  initialKeyword?: string;
}

interface SearchHit {
  siteKey: string;
  siteName: string;
  vod: VodInfo;
  /** 片名与关键词的相关度，见 titleMatchScore；用于置顶和「只看匹配」。 */
  matchScore: number;
}

/** 聚合失败的一行：够用户判断「是源挂了还是我关键词错了」，也够我们定位。 */
interface FailureRow {
  siteKey: string;
  siteName: string;
  /** 归类后的短标签（如「源站超时」）——界面只展示这个。 */
  message: string;
  /** 一句话解释这类失败（如「单站超时 15 秒」）。 */
  detail: string;
  /** 原始报错全文——只进日志与「复制诊断」，不进界面。 */
  raw: string;
  /** 单站重试进行中。 */
  busy?: boolean;
}

/** 搜索页：单站点直连，全部站点走后端一次并发聚合。 */
export default function SearchPage({
  sites,
  navigate,
  initialKeyword,
}: SearchPageProps) {
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
  const [onlyMatches, setOnlyMatches] = usePageState<boolean>(
    `${K}onlyMatches`,
    false,
  );
  const [failures, setFailures] = usePageState<number>(`${K}failures`, 0);
  /** 因配置规则被跳过（禁用 / 屏蔽的源）的站点数：与「失败」分开报，不混算。 */
  const [skipped, setSkipped] = usePageState<number>(`${K}skipped`, 0);
  /** 源级降级原因（规格 14 节）：按出现次数取前三条，避免刷屏。 */
  const [failureReasons, setFailureReasons] = usePageState<string[]>(
    `${K}failureReasons`,
    [],
  );
  /** 逐站失败明细：用户能看到是哪一站、什么错，并对单站重试。 */
  const [failureRows, setFailureRows] = usePageState<FailureRow[]>(
    `${K}failureRows`,
    [],
  );
  const [showFailures, setShowFailures] = useState(false);
  const [progress, setProgress] = usePageState<string>(`${K}progress`, "");
  const [searched, setSearched] = usePageState<boolean>(`${K}searched`, false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 等待期已耗时（秒），驱动进度条文案；loading 结束即重置。 */
  const [elapsed, setElapsed] = useState(0);
  /**
   * 搜索代次。后端没有中断通道（一次 IPC 扇出到底），所以「取消」和
   * 「搜索中改词重搜」都是纯前端语义：递增代次 → 旧请求的迟到结果（含
   * 流式 chunk）整批丢弃，新请求立刻开始。源站请求仍会跑完，换取的是
   * 用户不用先点取消、也不用干等 20 秒。
   */
  const searchGenRef = useRef(0);
  /** 搜索输入框 ref：清除后把焦点拉回，方便立刻重输。 */
  const inputRef = useRef<HTMLInputElement>(null);
  /** 用户实际搜过的词，跨重启保留；与页面快照分开存。 */
  const [recent, setRecent] = useState<string[]>(() => readSearchHistory());

  // 等待期计时：500ms 粒度足够，结束/取消即停。
  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [loading]);

  const runSearch = async (wordOverride?: string) => {
    const word = (wordOverride ?? keyword).trim();
    if (!word) {
      setError("请输入搜索关键词");
      return;
    }
    const gen = searchGenRef.current + 1;
    searchGenRef.current = gen;
    const alive = () => searchGenRef.current === gen;
    // 提交一次就记一次（即使这次失败，用户意图也值得保留）。
    setRecent(pushSearchHistory(word));
    const startedAt = Date.now();
    /** 聚合统计（日志用）；单站搜索补一条等价结构。 */
    let aggregateStats: {
      total: number;
      ok: number;
      failed: number;
      skipped: number;
      tookMs: number;
    } | null = null;
    setLoading(true);
    setError("");
    setSearched(false);
    setFailures(0);
    setSkipped(0);
    setFailureReasons([]);
    setFailureRows([]);
    setShowFailures(false);
    setHits([]);
    setMatchCount(0);
    setProgress("");

    try {
      const merged: SearchHit[] = [];
      /** 原始失败详情：只进日志，界面用归类后的标签。 */
      const rawFailures: Array<{ code?: string; message?: string }> = [];

      if (target !== ALL_SITES) {
        const site = selectableSites.find((item) => item.key === target);
        if (!site) {
          setError("所选站点不可用，请重新选择");
          return;
        }
        const result = await api.search(site.key, word, 1);
        if (!alive()) {
          // 已被取消 / 被新一次搜索取代：迟到的结果整批丢弃。
          log.info("search result discarded after cancel", {
            keyword: word.slice(0, 60),
            scope: target,
          });
          return;
        }
        for (const vod of result.list ?? []) {
          merged.push({
            siteKey: site.key,
            siteName: site.name,
            vod,
            matchScore: titleMatchScore(vod.vod_name, word),
          });
        }
        aggregateStats = {
          total: 1,
          ok: 1,
          failed: 0,
          skipped: 0,
          tookMs: Date.now() - startedAt,
        };
      } else {
        if (selectableSites.length === 0) {
          setError("请先导入一份配置");
          return;
        }
        setProgress(
          `正在并发检索 ${selectableSites.length} 个站点，结果陆续返回中…`,
        );
        const names = new Map(
          selectableSites.map((item) => [item.key, item.name]),
        );
        const seen = new Set<string>();
        /** 流式增量（到达序）：每个 chunk 到达就并进 hits 上屏，不等全站。 */
        const streamed: SearchHit[] = [];
        const streamedFailures: Array<{ code?: string; message?: string }> = [];
        const streamedRows: FailureRow[] = [];
        let streamOk = 0;
        let streamFailed = 0;
        /** 把一批成功/失败结果并入界面（去重 + 相关度重排 + 失败明细）。 */
        const absorbChunk = (row: AggregateRow) => {
          if (row.ok) {
            streamOk += 1;
            let added = false;
            for (const vod of row.data?.list ?? []) {
              const id = vod.vod_id ? `${row.siteKey}:${vod.vod_id}` : "";
              if (id && seen.has(id)) continue;
              if (id) seen.add(id);
              streamed.push({
                siteKey: row.siteKey,
                siteName: names.get(row.siteKey) ?? row.siteKey,
                vod,
                matchScore: titleMatchScore(vod.vod_name, word),
              });
              added = true;
            }
            if (added) {
              // 每批都按片名相关度稳定重排：先到的精确命中保持置顶，
              // 后到的按分数插队（陆续出来、始终有序）。
              const ranked = rankByTitle(
                streamed,
                word,
                (hit) => hit.vod.vod_name,
              );
              setHits(ranked);
              setMatchCount(ranked.filter((hit) => hit.matchScore >= 2).length);
              setSearched(true);
            }
          } else {
            streamFailed += 1;
            const raw = row.error?.message || row.error?.code || "未知错误";
            streamedFailures.push({ code: row.error?.code, message: raw });
            const reason = classifyFailure(row.error?.code, raw);
            streamedRows.push({
              siteKey: row.siteKey,
              siteName: names.get(row.siteKey) ?? row.siteKey,
              message: reason.label,
              detail: reason.hint,
              raw,
            });
            setFailureRows(
              streamedRows.sort((a, b) =>
                a.siteName.localeCompare(b.siteName, "zh-Hans-CN"),
              ),
            );
            setFailures(streamedRows.length);
            setFailureReasons(
              groupFailures(streamedFailures)
                .slice(0, 3)
                .map((group) => `${group.label}（${group.count} 个站点）`),
            );
          }
          setProgress(
            `已响应 ${streamOk + streamFailed}/${selectableSites.length} 个站点，已出 ${streamed.length} 条结果`,
          );
        };
        // 流式订阅要在发请求前挂上：后端每完成一个站点就推一行。
        const unlisten = await api.onSearchChunk((row) => {
          // 只收本代次的 chunk：改词重搜后上一轮的站点仍会陆续回包，
          // 没有 streamId 过滤的话旧词的结果会混进新词列表。
          if (alive() && row.streamId === String(gen)) {
            absorbChunk(row);
          }
        });
        try {
          // 一次 IPC 让 Rust 并发扇出；串行逐站调用在 100+ 站点的配置下要等几分钟。
          // 不传 timeoutMs：流式模式不限总墙钟，每站用后端默认 15s 单站超时。
          const agg = (await api.spiderInvoke({
            siteKey: "all",
            method: "searchContent",
            args: [word, false, 1],
            stream: true,
            streamId: String(gen),
          })) as AggregateResult;
          if (!alive()) {
            // 被取消 / 被新搜索取代：迟到的聚合结果整批丢弃。
            log.info("search result discarded after cancel", {
              keyword: word.slice(0, 60),
              scope: "all",
            });
            return;
          }
          await finalizeAggregate(agg, names);
        } finally {
          unlisten();
        }

        async function finalizeAggregate(
          agg: AggregateResult,
          names: Map<string, string>,
        ) {
          // 对账用独立的去重集（流式期的 seen 已含全部增量，复用会把
          // 整份结果误判成重复）；条目写进**外层 merged**——runSearch 末尾
          // 的 setHits(ranked) 读的是它。
          const finalSeen = new Set<string>();
          for (const row of agg.results ?? []) {
            if (!row.ok) {
              continue;
            }
            for (const vod of row.data?.list ?? []) {
              // A site can appear in several aggregate rows, and some sources
              // repeat an id. De-duplicate before rendering so no duplicate
              // cards show up; entries without an id are left untouched.
              const id = vod.vod_id ? `${row.siteKey}:${vod.vod_id}` : "";
              if (id && finalSeen.has(id)) {
                continue;
              }
              if (id) {
                finalSeen.add(id);
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
          // 换源图标直接读缓存，不必再发一次 20s 全站聚合。
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
          // 失败原因归类：原始报错（完整 URL、协议名、解析器行列号）**不进界面**，
          // 只归类成「源站超时 / 需要验证码 / 内容无法解析」这类人能懂的说法；
          // 原文保留在 row.raw 里，供日志与「复制诊断」用。
          const breakdown: FailureRow[] = [];
          for (const row of agg.results ?? []) {
            if (row.ok) {
              continue;
            }
            const raw = row.error?.message || row.error?.code || "未知错误";
            rawFailures.push({ code: row.error?.code, message: raw });
            const reason = classifyFailure(row.error?.code, raw);
            breakdown.push({
              siteKey: row.siteKey,
              siteName: names.get(row.siteKey) ?? row.siteKey,
              message: reason.label,
              detail: reason.hint,
              raw,
            });
          }
          // 摘要按类型聚合成「源站超时（22 个站点）」，不再逐条罗列原始报错。
          setFailureReasons(
            groupFailures(rawFailures)
              .slice(0, 3)
              .map((group) => `${group.label}（${group.count} 个站点）`),
          );
          // 明细按站点名排序：用户找「某某站怎么没结果」时能直接扫。
          setFailureRows(
            breakdown.sort((a, b) =>
              a.siteName.localeCompare(b.siteName, "zh-Hans-CN"),
            ),
          );
          // 计数口径与明细对齐：**只算真正失败的源**。
          // 原先把 skipped（按配置规则跳过的禁用源）也算进「失败」，
          // 于是摘要写 41 个失败、明细只列 5 行，用户会问「另外 36 个去哪了」。
          // skipped 单独作为「已跳过」说明，不再冒充失败。
          setFailures(breakdown.length);
          setSkipped(agg.skipped ?? 0);
          aggregateStats = {
            total: agg.total,
            ok: agg.ok,
            failed: agg.failed,
            skipped: agg.skipped ?? 0,
            tookMs: agg.tookMs,
          };
        }
      }

      if (!alive()) {
        return;
      }
      // 源站回退推荐列表 / 单字模糊匹配会把精确命中冲到几十条之后。
      // 先按片名相关度稳定置顶，再交给 UI；不丢弃任何结果。
      const ranked = rankByTitle(merged, word, (hit) => hit.vod.vod_name);
      setHits(ranked);
      setMatchCount(ranked.filter((hit) => hit.matchScore >= 2).length);
      setSearched(true);
      log.info("search done", {
        keyword: word.slice(0, 60),
        scope: target === ALL_SITES ? "all" : target,
        ...(aggregateStats ?? {}),
        hits: ranked.length,
        matched: ranked.filter((hit) => hit.matchScore >= 2).length,
        elapsedMs: Date.now() - startedAt,
        // 归类后的分组计数：便于事后按类型统计（超时/验证码/解析…）。
        failureGroups: groupFailures(rawFailures).map(
          (g) => `${g.kind}:${g.count}`,
        ),
      });
      // 原始报错全文只进日志（界面已换成归类后的中文标签）。
      if (rawFailures.length > 0) {
        log.info("search failure details", {
          keyword: word.slice(0, 60),
          failures: rawFailures.map((f) => ({
            code: f.code ?? "",
            message: (f.message ?? "").slice(0, 300),
          })),
        });
      }
    } catch (err) {
      if (!alive()) {
        return;
      }
      const appError = toAppError(err);
      setFailures(1);
      // 界面只出归类结论：原始 message 里常带完整请求 URL 与解析器行列号，
      // 直出会让搜索页变成日志（原文留在下面这行 warn 里）。
      setError(
        `搜索失败（${classifyFailure(appError.code, appError.message).label}）`,
      );
      log.warn("search failed", {
        keyword: word.slice(0, 60),
        message: appError.message,
      });
    } finally {
      // 旧请求结束时不能把新请求的 loading 关掉。
      if (alive()) {
        setLoading(false);
      }
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // 搜索中允许直接改词重搜：新一次 runSearch 会递增代次，旧结果整批作废。
    void runSearch();
  };

  /** 取消等待：递增代次让迟到的结果失效，立即退出等待态。 */
  const onCancel = () => {
    if (!loading) {
      return;
    }
    searchGenRef.current += 1;
    setLoading(false);
    setProgress("");
    log.info("search cancelled by user");
  };

  /** 点历史词直接重搜：setKeyword 是异步的，所以把词显式传给 runSearch。 */
  const onRecentPick = (word: string) => {
    setKeyword(word);
    void runSearch(word);
  };

  /**
   * 输入框内嵌的 ×：有内容时才出现。点击清空关键词，并复位搜索结果/状态——
   * 否则「空关键词 + 残留结果」会停在页面上，用户不知道算搜了还是没搜。
   * 同时递增代次让可能的在途搜索作废，避免旧结果随后又冒出来。
   */
  const onClear = () => {
    searchGenRef.current += 1;
    setLoading(false);
    setProgress("");
    setKeyword("");
    setHits([]);
    setMatchCount(0);
    setOnlyMatches(false);
    setFailures(0);
    setSkipped(0);
    setFailureReasons([]);
    setFailureRows([]);
    setShowFailures(false);
    setSearched(false);
    setError("");
    inputRef.current?.focus();
  };

  const onRecentClear = () => setRecent(clearSearchHistory());
  const onRecentRemove = (word: string) => setRecent(removeSearchHistory(word));

  /**
   * 带着片名跳进来（空详情页的「全站搜索此片」）时落地即搜一次。
   * - 用 ref 记住已自动搜过的词：dev 的 StrictMode 会把 effect 跑两遍，
   *   聚合搜索白烧一轮 20 秒；重复渲染同理。
   * - 与当前 keyword 相同时不重搜：用户可能只是从结果页点回搜索页。
   */
  const bootKeywordRef = useRef("");
  useEffect(() => {
    const word = (initialKeyword || "").trim();
    if (!word || bootKeywordRef.current === word) {
      return;
    }
    bootKeywordRef.current = word;
    setKeyword(word);
    if (word !== keyword.trim()) {
      void runSearch(word);
    }
    // keyword / runSearch 故意不列依赖：这里只关心「跳进来时带的是哪个词」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKeyword]);

  /**
   * 单站重试：聚合时超时的慢源往往单独再跑一次就能出结果。成功则把结果
   * 合并进当前列表（仍按片名相关度排序），并把该站从失败明细里移除。
   */
  const retrySite = async (row: FailureRow) => {
    const word = keyword.trim();
    if (!word) {
      return;
    }
    setFailureRows((current) =>
      current.map((item) =>
        item.siteKey === row.siteKey ? { ...item, busy: true } : item,
      ),
    );
    try {
      const result = await api.search(row.siteKey, word, 1, true);
      const added: SearchHit[] = (result.list ?? []).map((vod) => ({
        siteKey: row.siteKey,
        siteName: row.siteName,
        vod,
        matchScore: titleMatchScore(vod.vod_name, word),
      }));
      const merged = rankByTitle(
        [...hits, ...added],
        word,
        (hit) => hit.vod.vod_name,
      );
      // 同一站可能重复点重试；按 (siteKey, vodId) 去重后再落盘。
      const deduped: SearchHit[] = [];
      const seen = new Set<string>();
      for (const hit of merged) {
        const id = `${hit.siteKey}:${hit.vod.vod_id}`;
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        deduped.push(hit);
      }
      setHits(deduped);
      setMatchCount(deduped.filter((hit) => hit.matchScore >= 2).length);
      setFailureRows((current) =>
        current.filter((item) => item.siteKey !== row.siteKey),
      );
      setFailures((count) => Math.max(0, count - 1));
      log.info("search retry ok", {
        siteKey: row.siteKey,
        hits: added.length,
        keyword: word.slice(0, 60),
      });
    } catch (err) {
      // 重试失败：界面同样只显示归类后的标签，原始报错进日志。
      const raw = errorMessage(err);
      const reason = classifyFailure(undefined, raw);
      setFailureRows((current) =>
        current.map((item) =>
          item.siteKey === row.siteKey
            ? {
                ...item,
                busy: false,
                message: reason.label,
                detail: reason.hint,
                raw,
              }
            : item,
        ),
      );
      log.warn("search retry failed", {
        siteKey: row.siteKey,
        keyword: word.slice(0, 60),
        message: raw,
      });
    }
  };

  const visibleHits = onlyMatches
    ? hits.filter((hit) => hit.matchScore >= 2)
    : hits;

  return (
    <section className="page">
      {/* 页头 + 搜索条在滚动区之外：翻结果时还能改词、换站、再搜一次。 */}
      <header className="page-head">
        <h1 className="page-title">搜索</h1>
      </header>

      <form className="search-bar" onSubmit={onSubmit}>
        <div
          className={`search-input-wrap${keyword.trim() !== "" ? " has-clear" : ""}`}
        >
          <input
            ref={inputRef}
            className="input"
            type="text"
            value={keyword}
            placeholder="输入片名关键词"
            onChange={(event) => setKeyword(event.target.value)}
          />
          {keyword.trim() !== "" ? (
            <button
              type="button"
              className="search-clear"
              aria-label="清除搜索"
              title="清除搜索"
              onClick={onClear}
            >
              <Icon name="close" />
            </button>
          ) : null}
        </div>
        <SiteSelect
          sites={selectableSites}
          value={target}
          onChange={setTarget}
        />
        {/* 等待中也能提交：这次提交会打断上一次，不用先点「取消」。 */}
        <button type="submit" className="btn btn--primary">
          <Icon name="search" />
          {loading ? "重新搜索" : "搜索"}
        </button>
      </form>
      <div className="page-body">
        {recent.length > 0 ? (
          <div className="recent-searches">
            <div className="recent-searches__head">
              <span className="recent-searches__label">最近搜索</span>
              <IconButton
                name="trash"
                label="清空最近搜索"
                size="sm"
                tone="danger"
                onClick={onRecentClear}
              />
            </div>
            <div className="recent-row">
              {recent.map((word) => (
                <span className="recent-chip" key={word}>
                  <button
                    type="button"
                    className="recent-chip__word"
                    title={word}
                    onClick={() => onRecentPick(word)}
                  >
                    {word}
                  </button>
                  <button
                    type="button"
                    className="recent-chip__remove"
                    aria-label={`删除搜索词 ${word}`}
                    title="删除"
                    onClick={() => onRecentRemove(word)}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {!loading && !searched && keyword.trim() === "" ? (
          <p className="search-hint">
            输入片名或关键词，<strong>跨全部站点</strong>
            检索资源；也可在上方选择特定站点后搜索。
          </p>
        ) : null}

        {error ? <ErrorBar message={error} /> : null}

        {loading ? (
          <>
            {/* 进度行：真实语义是「无增量事件的等待」——不假装有百分比，
             * 给已耗时 + 上限 + 取消入口，比孤立转圈可预期。 */}
            <div className="search-progress" role="status" aria-live="polite">
              <span className="search-progress__bar" aria-hidden="true" />
              <span className="search-progress__label">
                {progress || "正在检索…"} 已等待 {elapsed} 秒 · 可直接改词重搜
              </span>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={onCancel}
              >
                取消
              </button>
            </div>
            {/* 骨架网格只垫空窗期：流式结果陆续上屏后让位给真实卡片。
              不用 .vod-card 类名，探针计数不受干扰。 */}
            {hits.length === 0 ? <SearchSkeleton count={12} /> : null}
          </>
        ) : null}

        {!loading && searched ? (
          <p className="result-meta">
            {progress ? `${progress}；` : ""}共 {hits.length} 条结果
            {matchCount > 0 ? `；其中 ${matchCount} 条片名匹配` : ""}
            {onlyMatches ? `；当前显示 ${visibleHits.length} 条` : ""}
            {failures > 0 ? `；${failures} 个站点失败` : ""}
            {skipped > 0 ? `；${skipped} 个站点按配置跳过` : ""}
          </p>
        ) : null}

        {!loading && searched && failureReasons.length > 0 ? (
          <p
            className="result-meta"
            style={{ opacity: 0.72, fontSize: "var(--fs-xs)" }}
          >
            失败原因：{failureReasons.join("；")}
          </p>
        ) : null}

        {!loading && searched && failureRows.length > 0 ? (
          <div className="failure-panel">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-expanded={showFailures}
              onClick={() => setShowFailures((value) => !value)}
            >
              {showFailures
                ? "收起失败源"
                : `查看 ${failureRows.length} 个失败源`}
            </button>
            {showFailures ? (
              <ul className="failure-list">
                {failureRows.map((row) => (
                  <li className="failure-item" key={row.siteKey}>
                    <span className="failure-item__name" title={row.siteKey}>
                      {row.siteName}
                    </span>
                    <span className="failure-item__reason" title={row.detail}>
                      {row.message}
                    </span>
                    <IconButton
                      name="refresh"
                      label={row.busy ? "重试中" : "重试"}
                      size="sm"
                      busy={row.busy}
                      disabled={row.busy}
                      onClick={() => void retrySite(row)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {!loading &&
        searched &&
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
            title={
              hits.length === 0 ? "没有找到相关内容" : "没有片名匹配的结果"
            }
            description={
              hits.length === 0
                ? "换个关键词，或选择其它站点再试。"
                : "关闭「只看片名匹配」可查看其它站点返回的结果。"
            }
            icon={SearchX}
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
      </div>
    </section>
  );
}
