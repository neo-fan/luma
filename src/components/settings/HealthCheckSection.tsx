import { useEffect, useMemo, useState } from "react";
import ErrorBar from "../ErrorBar";
import { api, errorMessage } from "../../lib/invoke";
import { log } from "../../lib/logger";
import type { ConfigSnapshot, Site, SiteHealthResult, SiteHealthRow } from "../../types/tvbox";
import { HEALTH_STATUS_LABEL, type HealthDisplayRow, isBlockedSource } from "./settingsShared";

interface HealthCheckSectionProps {
  /** 当前运行快照的全部站点（含被屏蔽的禁用站），用于与探测结果合并出体检清单。 */
  sites: Site[];
  /** 当前 active 配置 id；变化即清空旧体检结果，避免把 A 配置耗时显示到 B 配置。 */
  activeConfigId?: string;
  onImported: (snapshot: ConfigSnapshot) => void;
}

/** 站点体检：并发探测各可用站可达性与耗时；只读诊断，不写任何缓存。 */
export default function HealthCheckSection({
  sites,
  activeConfigId,
  onImported,
}: HealthCheckSectionProps) {
  const [healthRunning, setHealthRunning] = useState(false);
  /** 后端返回的探测行（仅含 enabled 且可路由的站），保留后端排序。 */
  const [healthRows, setHealthRows] = useState<SiteHealthRow[]>([]);
  /** 整次体检的聚合统计；未体检或配置切换后为 null。 */
  const [healthSummary, setHealthSummary] = useState<SiteHealthResult | null>(null);
  const [healthError, setHealthError] = useState("");
  /** 正在启停切换的 siteKey；空串表示空闲。 */
  const [healthToggling, setHealthToggling] = useState("");
  /** 待删除配置确认已迁至 ConfigListSection；这里是手动禁用的站点集合。 */
  const [disabledKeys, setDisabledKeys] = useState<Set<string>>(() => new Set());

  // 切换 / 重新导入配置后，旧的探测结果、统计与禁用标记都不再属于当前配置，
  // 必须清空并要求重新体检，避免把 A 配置的耗时显示到 B 配置上。
  useEffect(() => {
    setHealthRows([]);
    setHealthSummary(null);
    setHealthError("");
    setDisabledKeys(new Set());
  }, [activeConfigId]);

  /** 站点体检：并发探测各可用站的可达性与耗时；只读诊断，不写任何缓存。 */
  const runHealth = async () => {
    setHealthRunning(true);
    setHealthError("");
    setHealthRows([]);
    setHealthSummary(null);
    try {
      const result = await api.siteHealth();
      setHealthRows(result.rows);
      setHealthSummary(result);
    } catch (err) {
      const message = errorMessage(err);
      setHealthError(message);
      log.error("site health failed", { message });
    } finally {
      setHealthRunning(false);
    }
  };

  /**
   * 手动启用 / 禁用单站。快照交回 App 换全局 sites 缓存（fan-out 立即生效，
   * handleImported 会清三类页面缓存）；探测行 status 保持原样不伪造，只用
   * disabledKeys 额外跟踪被禁用的站，保证禁用后仍能从清单里重新启用。
   */
  const toggleSite = async (row: HealthDisplayRow, nextEnabled: boolean) => {
    setHealthToggling(row.siteKey);
    setHealthError("");
    try {
      const snapshot = await api.siteSetEnabled(row.siteKey, nextEnabled);
      onImported(snapshot);
      setDisabledKeys((current) => {
        const next = new Set(current);
        if (nextEnabled) {
          next.delete(row.siteKey);
        } else {
          next.add(row.siteKey);
        }
        return next;
      });
    } catch (err) {
      const message = errorMessage(err);
      setHealthError(message);
      log.error("site set enabled failed", {
        siteKey: row.siteKey,
        enabled: nextEnabled,
        message,
      });
    } finally {
      setHealthToggling("");
    }
  };

  /**
   * 合并 sites（全量，含禁用站）与 healthRows（仅探测到的 enabled 站）：
   * 1. 探测行按后端排序原样铺开，但被 disabledKeys 标记 / 快照里已禁用的行
   *    覆盖为「已禁用」展示态（不改动 healthRows state，不伪造探测结果）；
   * 2. 从未进入探测结果的禁用站（导入屏蔽的 jvm、体检后新禁用的等）
   *    合成「已禁用」行追加在后，保证禁用后一定能重新启用。
   * 未体检时探测行是空数组，清单只剩「已禁用」分组。
   */
  const healthDisplayRows = useMemo<HealthDisplayRow[]>(() => {
    const siteByKey = new Map(sites.map((site) => [site.key, site]));
    const seen = new Set<string>();

    const rows: HealthDisplayRow[] = healthRows.map((row) => {
      seen.add(row.siteKey);
      const site = siteByKey.get(row.siteKey);
      const disabled =
        (site ? !site.enabled : false) || disabledKeys.has(row.siteKey);
      const siteName = row.siteName || site?.name || row.siteKey;
      if (disabled) {
        return {
          siteKey: row.siteKey,
          siteName,
          status: "disabled",
          tookMs: 0,
          message: site?.disabledReason ?? "已禁用",
          blocked: site ? isBlockedSource(site) : false,
        };
      }
      return {
        siteKey: row.siteKey,
        siteName,
        status: row.status,
        tookMs: row.tookMs,
        message: row.message,
        count: row.count,
        blocked: false,
      };
    });

    for (const site of sites) {
      if (seen.has(site.key)) {
        continue;
      }
      if (site.enabled && !disabledKeys.has(site.key)) {
        // 启用但未被探测（未点体检 / 不可路由）：没有真实结果，不预填。
        continue;
      }
      rows.push({
        siteKey: site.key,
        siteName: site.name || site.key,
        status: "disabled",
        tookMs: 0,
        message: site.disabledReason ?? "已禁用",
        blocked: isBlockedSource(site),
      });
    }

    return rows;
  }, [sites, healthRows, disabledKeys]);

  return (
    <div className="settings-block">
      <h2 className="section-title">站点体检</h2>
      <p className="settings-line">
        对每个可用站点发一次轻量请求测可达性与耗时；这只是当前快照，不代表搜索/播放一定可用。手动禁用只影响当前配置，重新导入会重置。
      </p>
      <div className="health-bar">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={healthRunning || sites.length === 0}
          onClick={() => void runHealth()}
        >
          {healthRunning ? "体检中…" : "开始体检"}
        </button>
        {healthSummary ? (
          <span className="health-summary">
            共 {healthSummary.total} 站 · 可达 {healthSummary.ok} · 失败 {healthSummary.failed} ·
            未完成 {healthSummary.skipped} · 耗时 {healthSummary.tookMs}ms
          </span>
        ) : null}
      </div>
      {sites.length === 0 ? (
        <p className="settings-line">请先导入配置</p>
      ) : null}
      {healthError ? <ErrorBar message={healthError} /> : null}
      {healthDisplayRows.length > 0 ? (
        <ul className="health-list">
          {healthDisplayRows.map((row) => {
            // 任一启停在途就锁全部按钮：site_set_enabled 返回整份 ConfigSnapshot，
            // onImported 会整体替换 sites 缓存，并发切换会让后到的快照覆盖先到的。
            // healthToggling 非空即表示有在途切换；jvm 屏蔽源的启用按钮始终禁用。
            const locked = healthToggling !== "" || row.blocked;
            return (
              <li className="health-item" key={row.siteKey}>
                <span className="health-item__name" title={row.siteName}>
                  {row.siteName}
                </span>
                <span className="health-item__meta">
                  <span className={`health-item__status is-${row.status}`}>
                    {HEALTH_STATUS_LABEL[row.status]}
                  </span>
                  {row.status !== "disabled" ? (
                    <span className="health-item__took">{row.tookMs}ms</span>
                  ) : null}
                  {row.status === "ok" && typeof row.count === "number" ? (
                    <span className="health-item__count">{row.count} 条</span>
                  ) : null}
                  {row.message ? (
                    <span className="health-item__reason" title={row.message}>
                      {row.message}
                    </span>
                  ) : null}
                </span>
                <span className="health-item__actions">
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={locked}
                    onClick={() => void toggleSite(row, row.status === "disabled")}
                  >
                    {healthToggling === row.siteKey
                      ? "处理中…"
                      : row.status === "disabled"
                        ? "启用"
                        : "禁用"}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!healthSummary && !healthRunning && sites.length > 0 ? (
        <p className="settings-line">点击「开始体检」探测各站可达性</p>
      ) : null}
    </div>
  );
}
