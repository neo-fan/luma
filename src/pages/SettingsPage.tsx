import { useEffect, useState } from "react";
import Empty from "../components/Empty";
import ErrorBar from "../components/ErrorBar";
import Spinner from "../components/Spinner";
import { api, errorMessage } from "../lib/invoke";
import type { ConfigMeta, ConfigSnapshot, ProxyStatus } from "../types/tvbox";

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
      setNotice(`已导入「${snapshot.name}」，共 ${snapshot.sites.length} 个站点`);
      if (kind === "url") {
        setUrl("");
      } else {
        setText("");
      }
      setReload((current) => current + 1);
    } catch (err) {
      setError(`导入失败：${errorMessage(err)}`);
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
      setReload((current) => current + 1);
    } catch (err) {
      setError(`删除失败：${errorMessage(err)}`);
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
    } catch (err) {
      setError(`清空历史失败：${errorMessage(err)}`);
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
        <h2 className="section-title">数据目录</h2>
        <p className="settings-line">
          配置、收藏与观看历史都保存在本机应用数据目录，不会上传到云端。卸载应用前如需保留，请自行备份。
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
