import { useEffect, useState } from "react";
import ConfirmDialog from "../ConfirmDialog";
import Empty from "../Empty";
import ErrorBar from "../ErrorBar";
import IconButton from "../IconButton";
import Spinner from "../Spinner";
import { cleanConfigName, describeConfigSource, formatImportedAt } from "../../lib/config";
import { api, errorMessage } from "../../lib/invoke";
import { log } from "../../lib/logger";
import type { ConfigMeta, ConfigSnapshot } from "../../types/tvbox";

interface ConfigListSectionProps {
  activeConfigId?: string;
  onImported: (snapshot: ConfigSnapshot) => void;
  onConfigRemoved: (id: string) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
  /** 父级 reload 计数：变化即重新拉取配置列表（依赖项，必须稳定）。 */
  reload: number;
  /** 本 section 内的切换/删除完成后，请求父级把 reload 计数 +1。 */
  onReload: () => void;
}

/** 已导入配置列表：切换 active、行内重命名、删除（带二次确认）。 */
export default function ConfigListSection({
  activeConfigId,
  onImported,
  onConfigRemoved,
  onNotice,
  onError,
  reload,
  onReload,
}: ConfigListSectionProps) {
  const [configs, setConfigs] = useState<ConfigMeta[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(false);
  const [listError, setListError] = useState("");
  /** 正在切换的配置 id；只用于禁用按钮与文案。 */
  const [switching, setSwitching] = useState("");
  /** 行内重命名状态。 */
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [renaming, setRenaming] = useState(false);
  /** 待删除的配置：非空时弹出确认框（替代原生 confirm）。 */
  const [removingConfig, setRemovingConfig] = useState<ConfigMeta | null>(null);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setLoadingConfigs(true);
      setListError("");
      try {
        const list = await api.configList();
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
    };
    void run();
    return () => {
      alive = false;
    };
  }, [reload]);

  const removeConfig = (meta: ConfigMeta) => {
    setRemovingConfig(meta);
  };

  const doRemoveConfig = async () => {
    const meta = removingConfig;
    setRemovingConfig(null);
    if (!meta) {
      return;
    }
    onError("");
    onNotice("");
    try {
      await api.configRemove(meta.id);
      onConfigRemoved(meta.id);
      onNotice(`已删除配置「${meta.name}」`);
      log.info("config removed", { id: meta.id, name: meta.name });
      onReload();
    } catch (err) {
      onError(`删除失败：${errorMessage(err)}`);
      log.error("config remove failed", { id: meta.id, message: errorMessage(err) });
    }
  };

  /** 手动切换 active 配置：后端返回运行快照，前端整体换掉站点缓存。 */
  const switchConfig = async (meta: ConfigMeta) => {
    if (meta.id === activeConfigId) {
      return;
    }
    setSwitching(meta.id);
    onError("");
    onNotice("");
    try {
      const snapshot = await api.configActivate(meta.id);
      onImported(snapshot);
      const usable = snapshot.sites.filter((site) => site.enabled).length;
      onNotice(`已切换到「${snapshot.name}」，${usable} 个可用站点`);
      log.info("config activated", {
        id: snapshot.id,
        name: snapshot.name,
        sites: snapshot.sites.length,
        enabled: usable,
      });
      setEditingId("");
      onReload();
    } catch (err) {
      onError(`切换失败：${errorMessage(err)}`);
      log.error("config activate failed", { id: meta.id, message: errorMessage(err) });
    } finally {
      setSwitching("");
    }
  };

  const startRename = (meta: ConfigMeta) => {
    setEditingId(meta.id);
    setEditingName(meta.name);
    onError("");
    onNotice("");
  };

  const saveRename = async (meta: ConfigMeta) => {
    const next = cleanConfigName(editingName);
    if (!next) {
      onError("配置名称不能为空");
      return;
    }
    if (next === meta.name) {
      setEditingId("");
      return;
    }
    setRenaming(true);
    try {
      const updated = await api.configRename(meta.id, next);
      onNotice(`已重命名为「${updated.name}」`);
      log.info("config renamed", { id: updated.id, name: updated.name });
      setEditingId("");
      onReload();
    } catch (err) {
      onError(`重命名失败：${errorMessage(err)}`);
      log.error("config rename failed", { id: meta.id, message: errorMessage(err) });
    } finally {
      setRenaming(false);
    }
  };

  return (
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

      <ConfirmDialog
        open={removingConfig !== null}
        title="删除配置"
        message={`确定删除配置「${removingConfig?.name ?? ""}」吗？删除后需重新导入才能使用。`}
        confirmText="删除"
        danger
        onConfirm={() => void doRemoveConfig()}
        onCancel={() => setRemovingConfig(null)}
      />
    </div>
  );
}
