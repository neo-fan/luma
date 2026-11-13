import { useEffect, useMemo, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import IconButton from "../components/IconButton";
import Spinner from "../components/Spinner";
import {
  cleanConfigName,
  configNameFromUrl,
  describeConfigSource,
  formatImportedAt,
} from "../lib/config";
import { api, errorMessage } from "../lib/invoke";
import { log } from "../lib/logger";
import { APP_VERSION } from "../lib/version";
import type {
  ConfigMeta,
  ConfigSnapshot,
  Diagnostics,
  ProxyStatus,
  Site,
  SiteHealthResult,
  SiteHealthRow,
} from "../types/tvbox";

/** 体检状态对应的中文文案（disabled 为前端合成的禁用态）。 */
const HEALTH_STATUS_LABEL: Record<SiteHealthRow["status"] | "disabled", string> = {
  ok: "可达",
  failed: "失败",
  timeout: "超时",
  skipped: "未完成",
  disabled: "已禁用",
};

/** 体检渲染行：探测行用后端状态，禁用行由前端合成 status="disabled"。 */
interface HealthDisplayRow {
  siteKey: string;
  siteName: string;
  status: SiteHealthRow["status"] | "disabled";
  tookMs: number;
  message?: string;
  count?: number;
  /** jvm 屏蔽源：后端会拒绝手动启用，前端先挡掉。 */
  blocked: boolean;
}

/**
 * 屏蔽源（导入时禁用的 jvm / Android dex jar 源）挡住「启用」：后端会拒绝
 * 手动启用，前端先挡掉，避免无谓 IPC。手动禁用的 cms / python / quickjs 站
 * 不在此列，仍可启用。
 */
function isBlockedSource(site: Site): boolean {
  return site.runtime === "jvm";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 复制文本。优先走后端系统剪贴板：WebView2 的 `navigator.clipboard` 在缺少
 * 用户手势时会弹权限框并挂起，桌面应用里体验很差。失败时把内容放进只读
 * textarea，让用户手动全选复制。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await api.copyText(text);
    return true;
  } catch {
    return false;
  }
}

interface SettingsPageProps {
  activeConfigId?: string;
  /** 当前运行快照的全部站点（含被屏蔽的禁用站），用于与探测结果合并出体检清单。 */
  sites: Site[];
  onImported: (snapshot: ConfigSnapshot) => void;
  onConfigRemoved: (id: string) => void;
}

/** 设置页：配置导入/管理、反代状态、历史清理与免责声明。 */
export default function SettingsPage({
  activeConfigId,
  sites,
  onImported,
  onConfigRemoved,
}: SettingsPageProps) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  /** 导入时使用的配置名；默认取 URL 域名，用户可以直接改。 */
  const [name, setName] = useState("");
  /** 用户手动改过名字后，就不再跟着 URL 自动变。 */
  const [nameTouched, setNameTouched] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [configs, setConfigs] = useState<ConfigMeta[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [listError, setListError] = useState("");
  const [reload, setReload] = useState(0);
  /** 正在切换的配置 id；只用于禁用按钮与文案。 */
  const [switching, setSwitching] = useState("");
  /** 行内重命名状态。 */
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [renaming, setRenaming] = useState(false);

  const [proxy, setProxy] = useState<ProxyStatus | null>(null);
  const [proxyError, setProxyError] = useState("");

  // 试运行诊断：版本 / 目录 / 日志文件，与配置列表并行获取。
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagError, setDiagError] = useState("");
  const [copyTip, setCopyTip] = useState("");
  /** 自动复制失败时的只读兜底文本。 */
  const [manualCopy, setManualCopy] = useState("");
  /** 最近一次导出的反馈文件路径。 */
  const [reportPath, setReportPath] = useState("");

  // ---- 站点体检：仅在本次打开设置页内有效，不落缓存 ----
  /** 体检是否进行中。 */
  const [healthRunning, setHealthRunning] = useState(false);
  /** 后端返回的探测行（仅含 enabled 且可路由的站），保留后端排序。 */
  const [healthRows, setHealthRows] = useState<SiteHealthRow[]>([]);
  /** 整次体检的聚合统计；未体检或配置切换后为 null。 */
  const [healthSummary, setHealthSummary] = useState<SiteHealthResult | null>(null);
  const [healthError, setHealthError] = useState("");
  /** 正在启停切换的 siteKey；空串表示空闲。 */
  const [healthToggling, setHealthToggling] = useState("");

  /** 待删除的配置：非空时弹出确认框（替代原生 confirm）。 */
  const [removingConfig, setRemovingConfig] = useState<ConfigMeta | null>(null);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  /**
   * 前端额外记录「手动禁用」的站点：`site_health` 只返回 enabled 站，禁用后
   * 该站从 rows 消失，靠这个集合让它在清单里继续以「已禁用」出现、可重新启用。
   */
  const [disabledKeys, setDisabledKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setLoadingConfigs(true);
      setListError("");
      // Two independent commands: start both before awaiting either, so the
      // page does not pay two serial IPC round trips.
      const listPromise = api.configList();
      const proxyPromise = api.proxyStatus();
      try {
        const list = await listPromise;
        if (alive) {
          setConfigs(list);
        }
      } catch (err) {
        if (alive) {
          setConfigs([]);
          setListError(errorMessage(err));
        }
      } finally {
        if (alive) {
          setLoadingConfigs(false);
        }
      }

      try {
        const status = await proxyPromise;
        if (alive) {
          setProxy(status);
          setProxyError("");
        }
      } catch (err) {
        if (alive) {
          setProxy(null);
          setProxyError(errorMessage(err));
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [reload]);

  // 诊断信息单独一个 effect：配置列表 / 反代慢时也能先把版本与目录显示出来。
  useEffect(() => {
    let alive = true;
    void api
      .diagnostics()
      .then((value) => {
        if (alive) {
          setDiag(value);
          setDiagError("");
        }
      })
      .catch((err) => {
        if (alive) {
          setDiag(null);
          setDiagError(errorMessage(err));
        }
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  // 切换 / 重新导入配置后，旧的探测结果、统计与禁用标记都不再属于当前配置，
  // 必须清空并要求重新体检，避免把 A 配置的耗时显示到 B 配置上。
  useEffect(() => {
    setHealthRows([]);
    setHealthSummary(null);
    setHealthError("");
    setDisabledKeys(new Set());
  }, [activeConfigId]);

  const importConfig = async (kind: "url" | "text", value: string) => {
    if (!value) {
      setError(kind === "url" ? "请先填写配置地址" : "请先粘贴配置内容");
      return;
    }
    setImporting(true);
    setError("");
    setNotice("");
    try {
      const snapshot = await api.configImport({
        kind,
        value,
        // 只有用户真的改过名字才提交。输入框里自动填的域名只是「默认值预览」，
        // 跟着发过去会把同一份配置已有的自定义名改掉（`box` 会变回域名）。
        // 没提交时后端按「保留已有名字 → 域名」的顺序兜底。
        name: nameTouched ? cleanConfigName(name) || undefined : undefined,
      });
      onImported(snapshot);
      // configImport 返回的是运行配置（导入原件在后端单独保留）；把主动
      // 屏蔽的数量报出来，用户才知道为什么站点比原始 json 里少。
      const usable = snapshot.sites.filter((site) => site.enabled).length;
      const blocked = snapshot.sites.filter((site) => site.disabledReason).length;
      setNotice(
        `已导入「${snapshot.name}」，${usable} 个可用站点` +
          (blocked > 0 ? `；已屏蔽 ${blocked} 个不支持的 jar 源` : ""),
      );
      log.info("config imported", {
        id: snapshot.id,
        name: snapshot.name,
        kind,
        sites: snapshot.sites.length,
        enabled: usable,
        blocked,
      });
      if (kind === "url") {
        setUrl("");
      } else {
        setText("");
      }
      // 名字只对本次导入有效：清空后下次会重新按域名推导。
      setName("");
      setNameTouched(false);
      setReload((current) => current + 1);
    } catch (err) {
      setError(`导入失败：${errorMessage(err)}`);
      log.error("config import failed", { kind, message: errorMessage(err) });
    } finally {
      setImporting(false);
    }
  };

  const removeConfig = (meta: ConfigMeta) => {
    setRemovingConfig(meta);
  };

  const doRemoveConfig = async () => {
    const meta = removingConfig;
    setRemovingConfig(null);
    if (!meta) {
      return;
    }
    setError("");
    setNotice("");
    try {
      await api.configRemove(meta.id);
      onConfigRemoved(meta.id);
      setNotice(`已删除配置「${meta.name}」`);
      log.info("config removed", { id: meta.id, name: meta.name });
      setReload((current) => current + 1);
    } catch (err) {
      setError(`删除失败：${errorMessage(err)}`);
      log.error("config remove failed", { id: meta.id, message: errorMessage(err) });
    }
  };

  /** 手动切换 active 配置：后端返回运行快照，前端整体换掉站点缓存。 */
  const switchConfig = async (meta: ConfigMeta) => {
    if (meta.id === activeConfigId) {
      return;
    }
    setSwitching(meta.id);
    setError("");
    setNotice("");
    try {
      const snapshot = await api.configActivate(meta.id);
      onImported(snapshot);
      const usable = snapshot.sites.filter((site) => site.enabled).length;
      setNotice(`已切换到「${snapshot.name}」，${usable} 个可用站点`);
      log.info("config activated", {
        id: snapshot.id,
        name: snapshot.name,
        sites: snapshot.sites.length,
        enabled: usable,
      });
      setEditingId("");
      setReload((current) => current + 1);
    } catch (err) {
      setError(`切换失败：${errorMessage(err)}`);
      log.error("config activate failed", { id: meta.id, message: errorMessage(err) });
    } finally {
      setSwitching("");
    }
  };

  const startRename = (meta: ConfigMeta) => {
    setEditingId(meta.id);
    setEditingName(meta.name);
    setError("");
    setNotice("");
  };

  const saveRename = async (meta: ConfigMeta) => {
    const next = cleanConfigName(editingName);
    if (!next) {
      setError("配置名称不能为空");
      return;
    }
    if (next === meta.name) {
      setEditingId("");
      return;
    }
    setRenaming(true);
    try {
      const updated = await api.configRename(meta.id, next);
      setNotice(`已重命名为「${updated.name}」`);
      log.info("config renamed", { id: updated.id, name: updated.name });
      setEditingId("");
      setReload((current) => current + 1);
    } catch (err) {
      setError(`重命名失败：${errorMessage(err)}`);
      log.error("config rename failed", { id: meta.id, message: errorMessage(err) });
    } finally {
      setRenaming(false);
    }
  };

  const clearHistory = () => {
    setConfirmClearHistory(true);
  };

  const doClearHistory = async () => {
    setConfirmClearHistory(false);
    setError("");
    setNotice("");
    try {
      await api.historyClear();
      setNotice("已清空观看历史");
      log.info("history cleared");
    } catch (err) {
      setError(`清空历史失败：${errorMessage(err)}`);
    }
  };

  const openLogs = async () => {
    setCopyTip("");
    try {
      await api.openLogDir();
      log.info("log dir opened");
    } catch (err) {
      setCopyTip(`打开日志目录失败：${errorMessage(err)}`);
    }
  };

  /** 一键复制诊断信息：试运行反馈只需要粘贴这一段，不必让用户找文件。 */
  const copyDiagnostics = async () => {
    const payload = diag ?? { version: APP_VERSION, note: "diagnostics unavailable" };
    const text = JSON.stringify(payload, null, 2);
    const copied = await copyText(text);
    setManualCopy(copied ? "" : text);
    setCopyTip(
      copied
        ? "诊断信息已复制，可直接粘贴反馈"
        : "自动复制失败，请手动全选复制下面的内容",
    );
    log.info("diagnostics copy", { ok: copied, version: payload.version });
  };

  /** 生成反馈文件（诊断 + 日志尾部），一个文件就能发给开发者。 */
  const exportReport = async () => {
    setCopyTip("");
    setManualCopy("");
    try {
      const file = await api.exportReport();
      setReportPath(file);
      setCopyTip("反馈文件已生成，可直接发送这个文件");
      log.info("report exported", { file });
    } catch (err) {
      setCopyTip(`生成反馈文件失败：${errorMessage(err)}`);
      log.error("report export failed", { message: errorMessage(err) });
    }
  };

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
    <section className="page">
      <header className="page-head">
        <h1 className="page-title">设置</h1>
      </header>

      {error ? <ErrorBar message={error} /> : null}
      {notice ? <p className="tip tip--ok">{notice}</p> : null}

      <div className="settings-block">
        <h2 className="section-title">导入配置（URL）</h2>
        <div className="search-bar">
          <input
            className="input"
            type="text"
            value={url}
            placeholder="https://example.com/api.json"
            onChange={(event) => {
              const next = event.target.value;
              setUrl(next);
              // 只在用户没手动改过名字时跟着 URL 走，避免覆盖自定义名。
              if (!nameTouched) {
                setName(configNameFromUrl(next));
              }
            }}
          />
          <button
            type="button"
            className="btn btn--primary"
            disabled={importing}
            onClick={() => void importConfig("url", url.trim())}
          >
            {importing ? "导入中…" : "导入"}
          </button>
        </div>
        <label className="config-name">
          <span className="config-name__label">配置名称</span>
          <input
            className="input"
            type="text"
            value={name}
            maxLength={48}
            placeholder="留空则使用域名 / 配置内名称"
            onChange={(event) => {
              setName(event.target.value);
              setNameTouched(true);
            }}
          />
          <small className="config-name__hint">
            URL 与粘贴文本共用；默认取域名，可改成任意名字，保存后可在下方切换
          </small>
        </label>
      </div>

      <div className="settings-block">
        <h2 className="section-title">导入配置（粘贴文本）</h2>
        <textarea
          className="textarea"
          value={text}
          placeholder="把 api.json 的内容粘贴到这里（名称沿用上方「配置名称」）"
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={importing}
          onClick={() => void importConfig("text", text.trim())}
        >
          {importing ? "导入中…" : "导入文本"}
        </button>
      </div>

      <div className="settings-block">
        <h2 className="section-title">已导入配置</h2>
        {listError ? <ErrorBar message={`配置列表读取失败：${listError}`} /> : null}
        {loadingConfigs && configs.length === 0 ? <Spinner label="正在读取配置列表…" /> : null}
        {!loadingConfigs && configs.length === 0 ? (
          <Empty
            title="暂无已导入的配置"
            description="在上方填写地址或粘贴文本导入；可以保存多份配置，随时切换。"
          />
        ) : null}
        {configs.length > 0 ? (
          <ul className="config-list">
            {configs.map((meta) => (
              <li className="config-item" key={meta.id}>
                <div className="config-item__main">
                  {editingId === meta.id ? (
                    <div className="config-item__rename">
                      <input
                        className="input"
                        type="text"
                        value={editingName}
                        maxLength={48}
                        aria-label={`重命名 ${meta.name}`}
                        autoFocus
                        onChange={(event) => setEditingName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            void saveRename(meta);
                          } else if (event.key === "Escape") {
                            setEditingId("");
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn--primary btn--sm"
                        disabled={renaming}
                        onClick={() => void saveRename(meta)}
                      >
                        {renaming ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => setEditingId("")}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="config-item__name">
                        {meta.name}
                        {meta.id === activeConfigId ? (
                          <span className="config-item__tag">当前</span>
                        ) : null}
                      </span>
                      <span className="config-item__meta">
                        {describeConfigSource(meta.source)} · {formatImportedAt(meta.importedAt)}
                      </span>
                    </>
                  )}
                </div>
                {editingId === meta.id ? null : (
                  <div className="config-item__actions">
                    {meta.id === activeConfigId ? null : (
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={switching === meta.id}
                        onClick={() => void switchConfig(meta)}
                      >
                        {switching === meta.id ? "切换中…" : "切换"}
                      </button>
                    )}
                    <IconButton
                      name="pencil"
                      label="重命名"
                      size="sm"
                      onClick={() => startRename(meta)}
                    />
                    <IconButton
                      name="trash"
                      label="删除"
                      size="sm"
                      tone="danger"
                      onClick={() => removeConfig(meta)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="settings-block">
        <h2 className="section-title">本地反代</h2>
        {proxyError ? <ErrorBar message={`反代状态读取失败：${proxyError}`} /> : null}
        {proxy ? (
          <p className="settings-line">
            端口：{proxy.port} · 监听：{proxy.baseUrl} · allowLocal：{proxy.allowLocal ? "是" : "否"}
          </p>
        ) : null}
        {!proxy && !proxyError ? <p className="settings-line">读取中…</p> : null}
      </div>

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

      <div className="settings-block">
        <h2 className="section-title">版本与日志</h2>
        <div className="settings-kv">
          <span>版本</span>
          <code>v{diag?.version ?? APP_VERSION}</code>
          <span>运行平台</span>
          <code>{diag ? `${diag.os}/${diag.arch}` : "读取中…"}</code>
          <span>数据目录</span>
          <code title={diag?.dataDir}>{diag?.dataDir ?? "读取中…"}</code>
          <span>日志目录</span>
          <code title={diag?.logDir}>{diag?.logDir ?? "读取中…"}</code>
          <span>日志文件</span>
          <code>
            {diag ? `${diag.logFiles.length} 个 · ${formatBytes(diag.logBytes)}` : "读取中…"}
          </code>
          <span>当前配置</span>
          <code>
            {diag?.config
              ? `${diag.config.name} · ${diag.config.enabled}/${diag.config.sites} 站点`
              : "未导入"}
          </code>
        </div>
        {diagError ? <ErrorBar message={`诊断信息读取失败：${diagError}`} /> : null}
        <div className="settings-actions">
          <button type="button" className="btn" onClick={() => void openLogs()}>
            打开日志目录
          </button>
          <button type="button" className="btn" onClick={() => void copyDiagnostics()}>
            复制诊断信息
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void exportReport()}>
            导出反馈文件
          </button>
        </div>
        {copyTip ? <p className="tip">{copyTip}</p> : null}
        {reportPath ? (
          <p className="settings-line" title={reportPath}>
            反馈文件：<code>{reportPath}</code>
          </p>
        ) : null}
        {manualCopy ? (
          <textarea
            className="textarea"
            readOnly
            value={manualCopy}
            aria-label="诊断信息"
            onFocus={(event) => event.currentTarget.select()}
          />
        ) : null}
        <p className="settings-line">
          配置、收藏与观看历史都保存在本机应用数据目录，不会上传到云端。日志同样只写本机，
          保留最近 7 天，URL 会去掉查询参数后记录；反馈问题时请附上日志目录里的文件。
        </p>
      </div>

      <div className="settings-block">
        <h2 className="section-title">观看历史</h2>
        <button type="button" className="btn btn--danger" onClick={() => void clearHistory()}>
          清空历史
        </button>
      </div>

      <p className="disclaimer">本软件为播放框架，不提供任何片源。</p>

      <ConfirmDialog
        open={removingConfig !== null}
        title="删除配置"
        message={`确定删除配置「${removingConfig?.name ?? ""}」吗？删除后需重新导入才能使用。`}
        confirmText="删除"
        danger
        onConfirm={() => void doRemoveConfig()}
        onCancel={() => setRemovingConfig(null)}
      />

      <ConfirmDialog
        open={confirmClearHistory}
        title="清空观看历史"
        message="确定清空全部观看历史吗？此操作不可恢复。"
        confirmText="清空"
        danger
        onConfirm={() => void doClearHistory()}
        onCancel={() => setConfirmClearHistory(false)}
      />
    </section>
  );
}
