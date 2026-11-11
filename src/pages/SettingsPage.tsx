import { useEffect, useState } from "react";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
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
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [configs, setConfigs] = useState<ConfigMeta[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [listError, setListError] = useState("");
  const [reload, setReload] = useState(0);

  const [proxy, setProxy] = useState<ProxyStatus | null>(null);
  const [proxyError, setProxyError] = useState("");

  // 试运行诊断：版本 / 目录 / 日志文件，与配置列表并行获取。
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [diagError, setDiagError] = useState("");
  const [copyTip, setCopyTip] = useState("");
  /** 自动复制失败时的只读兜底文本。 */
  const [manualCopy, setManualCopy] = useState("");

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
      const snapshot = await api.configImport({ kind, value });
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
            onChange={(event) => setUrl(event.target.value)}
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
      </div>

      <div className="settings-block">
        <h2 className="section-title">导入配置（粘贴文本）</h2>
        <textarea
          className="textarea"
          value={text}
          placeholder="把 api.json 的内容粘贴到这里"
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
          <Empty title="暂无已导入的配置" description="在上方填写地址或粘贴文本导入一份配置。" />
        ) : null}
        {configs.length > 0 ? (
          <ul className="config-list">
            {configs.map((meta) => (
              <li className="config-item" key={meta.id}>
                <div className="config-item__main">
                  <span className="config-item__name">
                    {meta.name}
                    {meta.id === activeConfigId ? <span className="config-item__tag">当前</span> : null}
                  </span>
                  <span className="config-item__meta">
                    {meta.source.kind} · {meta.importedAt}
                  </span>
                </div>
                <button type="button" className="btn btn--danger" onClick={() => void removeConfig(meta)}>
                  删除
                </button>
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
        </div>
        {copyTip ? <p className="tip">{copyTip}</p> : null}
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
