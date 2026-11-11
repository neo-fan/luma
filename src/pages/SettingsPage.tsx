import { useEffect, useState } from "react";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
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
import type { ConfigMeta, ConfigSnapshot, Diagnostics, ProxyStatus } from "../types/tvbox";

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
  onImported: (snapshot: ConfigSnapshot) => void;
  onConfigRemoved: (id: string) => void;
}

/** 设置页：配置导入/管理、反代状态、历史清理与免责声明。 */
export default function SettingsPage({
  activeConfigId,
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
          (blocked > 0 ? `；已屏蔽 ${blocked} 个不支持的 jar / JS 源` : ""),
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

  const removeConfig = async (meta: ConfigMeta) => {
    if (!window.confirm(`确定删除配置「${meta.name}」吗？`)) {
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

  const clearHistory = async () => {
    if (!window.confirm("确定清空全部观看历史吗？此操作不可恢复。")) {
      return;
    }
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
                    <button type="button" className="btn btn--sm" onClick={() => startRename(meta)}>
                      重命名
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger btn--sm"
                      onClick={() => void removeConfig(meta)}
                    >
                      删除
                    </button>
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
    </section>
  );
}
