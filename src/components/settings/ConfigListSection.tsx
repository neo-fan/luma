import { useEffect, useState } from "react";
import ConfirmDialog from "../ConfirmDialog";
import Empty from "../Empty";
import ErrorBar from "../ErrorBar";
import IconButton from "../IconButton";
import AppSelect from "../AppSelect";
import Spinner from "../Spinner";
import { cleanConfigName, describeConfigSource, describeRefreshState, formatImportedAt, formatRelativeTime } from "../../lib/config";
import { api, errorMessage } from "../../lib/invoke";
import { log } from "../../lib/logger";
import type { ConfigMeta, ConfigSnapshot, RefreshSettings } from "../../types/luma";

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
  /** 行内编辑状态：名称 + 订阅地址（仅 url 来源可改地址）。 */
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [editingUrl, setEditingUrl] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  /** 待删除的配置：非空时弹出确认框（替代原生 confirm）。 */
  const [removingConfig, setRemovingConfig] = useState<ConfigMeta | null>(null);
  /** 订阅自动刷新：全局间隔 + active 配置的上次检查/变化/错误。 */
  const [settings, setSettings] = useState<RefreshSettings | null>(null);
  const [savingInterval, setSavingInterval] = useState(false);
  /** 进行中的刷新：`"active"` 表示顶部「立即检查」，其余是配置 id。 */
  const [refreshingId, setRefreshingId] = useState("");

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
      // 刷新设置是附加信息：命令缺失或读失败时退化成「只有手动检查」，
      // 不能让配置列表整体报错。
      try {
        const next = await api.configRefreshSettings();
        if (alive) {
          setSettings(next);
        }
      } catch {
        if (alive) {
          setSettings(null);
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
      onNotice(`已删除订阅「${meta.name}」`);
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

  const startEdit = (meta: ConfigMeta) => {
    setEditingId(meta.id);
    setEditingName(meta.name);
    // 只有网络地址导入的订阅有「地址」可编辑；文本/文件来源的来源串是正文或
    // 本地路径，塞进输入框既没意义也不安全。
    setEditingUrl(meta.refreshable ? meta.source.value : "");
    onError("");
    onNotice("");
  };

  /**
   * 保存编辑：名称与地址一次提交。
   *
   * 换地址会让后端按新地址重新导入并原地替换同一行；拉取失败时旧订阅保持
   * 不变，这里只把错误抛给用户，不做任何本地状态回收。
   */
  const saveEdit = async (meta: ConfigMeta) => {
    const nextName = cleanConfigName(editingName);
    if (!nextName) {
      onError("订阅名称不能为空");
      return;
    }
    const nextUrl = meta.refreshable ? editingUrl.trim() : "";
    if (meta.refreshable && !nextUrl) {
      onError("订阅地址不能为空");
      return;
    }
    const renamed = nextName !== meta.name;
    const migrated = meta.refreshable && nextUrl !== meta.source.value;
    if (!renamed && !migrated) {
      setEditingId("");
      return;
    }
    setSavingEdit(true);
    onError("");
    onNotice("");
    try {
      const outcome = await api.configEdit(meta.id, {
        name: renamed ? nextName : undefined,
        url: migrated ? nextUrl : undefined,
      });
      // 只有被编辑的就是当前配置时后端才回快照：其余情况不能动站点缓存。
      if (outcome.snapshot) {
        onImported(outcome.snapshot);
      }
      if (migrated) {
        const usable = outcome.snapshot
          ? outcome.snapshot.sites.filter((site) => site.enabled).length
          : 0;
        onNotice(
          outcome.snapshot
            ? `「${outcome.meta.name}」已换到新地址，${usable} 个可用站点`
            : `「${outcome.meta.name}」的订阅地址已更新`,
        );
      } else {
        onNotice(`已重命名为「${outcome.meta.name}」`);
      }
      log.info(migrated ? "config source edited" : "config renamed", {
        id: outcome.meta.id,
        name: outcome.meta.name,
        migrated,
      });
      setEditingId("");
      onReload();
    } catch (err) {
      onError(`${migrated ? "修改订阅地址" : "重命名"}失败：${errorMessage(err)}`);
      log.error("config edit failed", {
        id: meta.id,
        migrated,
        message: errorMessage(err),
      });
    } finally {
      setSavingEdit(false);
    }
  };

  /** 改间隔：0 = 关闭。后端会把设置 + 状态一起回，直接覆盖本地。 */
  const changeInterval = async (hours: number) => {
    setSavingInterval(true);
    onError("");
    try {
      const next = await api.configSetRefreshInterval(hours);
      setSettings(next);
      onNotice(hours === 0 ? "已关闭订阅自动刷新" : `订阅将每 ${hours} 小时检查一次`);
      log.info("refresh interval changed", { hours });
      onReload();
    } catch (err) {
      onError(`保存刷新设置失败：${errorMessage(err)}`);
      log.error("refresh interval failed", { hours, message: errorMessage(err) });
    } finally {
      setSavingInterval(false);
    }
  };

  /**
   * 手动检查一份订阅（配置行上的「检查更新」图标）。
   * 内容变了才换站点缓存——没变化时动缓存会白清页面缓存与滚动位置。
   */
  const refreshConfig = async (meta: ConfigMeta) => {
    const key = meta.id;
    setRefreshingId(key);
    onError("");
    onNotice("");
    try {
      const outcome = await api.configRefresh(meta.id);
      if (outcome.changed && outcome.snapshot) {
        onImported(outcome.snapshot);
        onNotice(`「${outcome.name}」已更新：${outcome.enabled} 个可用站点`);
      } else {
        onNotice(`「${outcome.name}」已是最新，无变化`);
      }
      log.info("config refresh", {
        id: outcome.configId,
        changed: outcome.changed,
        sites: outcome.sites,
        enabled: outcome.enabled,
      });
    } catch (err) {
      onError(`检查更新失败：${errorMessage(err)}`);
      log.error("config refresh failed", { id: key, message: errorMessage(err) });
    } finally {
      setRefreshingId("");
      // 成功与失败都要重拉列表：成败都会刷新「上次检查 / 失败原因」。
      onReload();
    }
  };

  const refreshHint = (() => {
    if (!settings) {
      return "刷新设置暂不可用，仍可手动检查";
    }
    if (settings.intervalHours === 0) {
      return "已关闭：只在点「立即检查」时回拉";
    }
    if (settings.error) {
      return `上次检查失败：${settings.error}`;
    }
    const last = settings.lastCheckedAt
      ? `上次检查 ${formatRelativeTime(settings.lastCheckedAt)}`
      : "尚未检查";
    return `${last} · 每 ${settings.intervalHours} 小时自动检查`;
  })();

  return (
    <div className="settings-block">
      <h2 className="section-title">已导入订阅</h2>
      <div className="refresh-bar">
        <div className="refresh-bar__text">
          <span className="refresh-bar__title">订阅自动刷新</span>
          <span className="refresh-bar__hint">{refreshHint}</span>
        </div>
        <AppSelect
          ariaLabel="订阅自动刷新间隔"
          value={String(settings?.intervalHours ?? 12)}
          disabled={savingInterval || !settings}
          onChange={(value) => void changeInterval(Number(value))}
          options={[
            { value: "0", label: "关闭" },
            { value: "1", label: "每 1 小时" },
            { value: "6", label: "每 6 小时" },
            { value: "12", label: "每 12 小时" },
            { value: "24", label: "每 24 小时" },
          ]}
        />
        {/* 手动检查走每行订阅的「检查更新」图标——这里再放一个「立即检查」
            与它完全重复（active 配置就是其中一行）。 */}
      </div>

      {listError ? <ErrorBar message={`订阅列表读取失败：${listError}`} /> : null}
      {loadingConfigs && configs.length === 0 ? <Spinner label="正在读取订阅列表…" /> : null}
      {!loadingConfigs && configs.length === 0 ? (
        <Empty
          title="暂无已导入的订阅"
          description="在上方填写地址或粘贴文本导入；可以保存多份订阅，随时切换。"
        />
      ) : null}
      {configs.length > 0 ? (
        <ul className="config-list">
          {configs.map((meta) => (
            <li className="config-item" key={meta.id}>
              <div className="config-item__main">
                {editingId === meta.id ? (
                  <form
                    className="config-item__edit"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveEdit(meta);
                    }}
                  >
                    <label className="config-item__field">
                      <span className="config-item__label">名称</span>
                      <input
                        className="input"
                        type="text"
                        value={editingName}
                        maxLength={48}
                        aria-label={`订阅名称 ${meta.name}`}
                        autoFocus
                        onChange={(event) => setEditingName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            setEditingId("");
                          }
                        }}
                      />
                    </label>
                    {meta.refreshable ? (
                      <label className="config-item__field">
                        <span className="config-item__label">地址</span>
                        <input
                          className="input"
                          type="url"
                          value={editingUrl}
                          spellCheck={false}
                          aria-label={`订阅地址 ${meta.name}`}
                          placeholder="https://…"
                          onChange={(event) => setEditingUrl(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setEditingId("");
                            }
                          }}
                        />
                      </label>
                    ) : (
                      <p className="config-item__hint">
                        该订阅来自粘贴文本或本地文件，没有可编辑的地址；如需按地址更新，请重新导入。
                      </p>
                    )}
                    <div className="config-item__edit-actions">
                      <button
                        type="submit"
                        className="btn btn--primary btn--sm"
                        disabled={savingEdit}
                      >
                        {savingEdit ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => setEditingId("")}
                      >
                        取消
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <span className="config-item__name">
                      {meta.name}
                      {meta.id === activeConfigId ? (
                        <span className="config-item__tag">当前</span>
                      ) : null}
                    </span>
                    <span className="config-item__meta">
                      {describeConfigSource(meta.source)} · 导入于 {formatImportedAt(meta.importedAt)}
                    </span>
                    <span className="config-item__refresh">{describeRefreshState(meta)}</span>
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
                  {meta.refreshable ? (
                    <IconButton
                      name="refresh"
                      label="检查更新"
                      size="sm"
                      busy={refreshingId === meta.id}
                      disabled={refreshingId !== ""}
                      onClick={() => void refreshConfig(meta)}
                    />
                  ) : null}
                  <IconButton
                    name="pencil"
                    label="编辑"
                    size="sm"
                    onClick={() => startEdit(meta)}
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
        title="删除订阅"
        message={`确定删除订阅「${removingConfig?.name ?? ""}」吗？删除后需重新导入才能使用。`}
        confirmText="删除"
        danger
        onConfirm={() => void doRemoveConfig()}
        onCancel={() => setRemovingConfig(null)}
      />
    </div>
  );
}
