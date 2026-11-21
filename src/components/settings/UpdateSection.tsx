import { useEffect, useState } from "react";
import ConfirmDialog from "../ConfirmDialog";
import ErrorBar from "../ErrorBar";
import { api, errorMessage } from "../../lib/invoke";
import { log } from "../../lib/logger";
import { readUpdatePrefs, writeUpdatePrefs } from "../../lib/updatePrefs";
import { APP_VERSION, IS_DEV_BUILD, formatVersion } from "../../lib/version";
import type { UpdateInfo, UpdateProgress } from "../../types/luma";
import { formatBytes } from "./settingsShared";

/** 下载阶段：idle → downloading → ready（安装包已落盘并校验通过）。 */
type Phase = "idle" | "checking" | "downloading" | "ready";

/**
 * 关于与更新。
 *
 * 两个入口共用同一份后端缓存：启动时静默检查与这里的「检查更新」都走
 * `update_check`，10 分钟内不会重复打代理。界面只在用户主动点击时才报错，
 * 进入页面时的自动查询失败保持静默——否则每次进设置都要看一条红条。
 */
export default function UpdateSection() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [installer, setInstaller] = useState("");
  const [tip, setTip] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [prefs, setPrefs] = useState(readUpdatePrefs);

  // 下载进度：整段订阅一次，组件卸载即退订。
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    void api
      .onUpdateProgress((next) => setProgress(next))
      .then((unlisten) => {
        if (alive) {
          off = unlisten;
        } else {
          unlisten();
        }
      })
      .catch(() => {
        // 事件订阅失败不影响主流程：进度条退化为不确定态。
      });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // 进页面先读一次缓存结果（后端 10 分钟 TTL），失败不打扰用户。
  useEffect(() => {
    let alive = true;
    void api
      .updateCheck(false)
      .then((value) => {
        if (alive) {
          setInfo(value);
        }
      })
      .catch(() => {
        // 静默：用户还没主动要求检查。
      });
    return () => {
      alive = false;
    };
  }, []);

  const check = async () => {
    if (phase === "checking" || phase === "downloading") {
      return;
    }
    setPhase("checking");
    setError("");
    setTip("");
    try {
      const value = await api.updateCheck(true);
      setInfo(value);
      setPrefs(writeUpdatePrefs({ lastCheckAt: Date.now() }));
      setTip(
        value.hasUpdate
          ? `发现新版本 ${formatVersion(value.latest)}`
          : `已是最新版本（${formatVersion(value.current)}）`,
      );
      log.info("update check", { current: value.current, latest: value.latest });
    } catch (err) {
      setError(`检查更新失败：${errorMessage(err)}`);
      log.warn("update check failed", { message: errorMessage(err) });
    } finally {
      setPhase("idle");
    }
  };

  const download = async () => {
    if (phase === "downloading") {
      return;
    }
    setPhase("downloading");
    setError("");
    setTip("");
    setProgress({ downloaded: 0, total: info?.size ?? 0 });
    try {
      const path = await api.updateDownload();
      setInstaller(path);
      setPhase("ready");
      setTip(
        IS_DEV_BUILD
          ? "安装包已下载并校验通过。调试构建不执行安装，请用正式版验证流程。"
          : "安装包已下载并校验通过，点击「立即安装」继续。",
      );
      log.info("update downloaded", { path });
    } catch (err) {
      setPhase("idle");
      setError(`下载失败：${errorMessage(err)}`);
      log.warn("update download failed", { message: errorMessage(err) });
    }
  };

  const install = async () => {
    setConfirming(false);
    if (!installer) {
      return;
    }
    try {
      await api.updateInstall(installer);
      // 正常路径下应用会立刻退出，这里不会继续执行。
    } catch (err) {
      setError(`启动安装失败：${errorMessage(err)}`);
    }
  };

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : 0;

  const latestLabel = info ? formatVersion(info.latest) : "尚未检查";

  return (
    <div className="settings-block">
      <h2 className="section-title">关于与更新</h2>
      <p className="settings-line">
        从 GitHub Release 检查新版本，安装包按「GitHub 加速」里选择的通道下载，
        校验 SHA256 后静默安装。安装时应用会退出，完成后重新打开即可。
      </p>

      <div className="settings-kv">
        <span>当前版本</span>
        <code>{formatVersion(APP_VERSION)}</code>
        <span>最新版本</span>
        <code>{latestLabel}</code>
        <span>更新通道</span>
        <code>
          {info
            ? info.source
              ? `加速 ${info.source}`
              : "直连 GitHub"
            : "检查后显示"}
        </code>
        {info?.hasUpdate && info.size > 0 ? (
          <>
            <span>安装包</span>
            <code>
              {info.assetName} · {formatBytes(info.size)}
            </code>
          </>
        ) : null}
      </div>

      <label className="filter-toggle update-auto">
        <input
          type="checkbox"
          checked={prefs.autoCheck}
          onChange={(event) => {
            setPrefs(writeUpdatePrefs({ autoCheck: event.target.checked }));
          }}
        />
        <span className="update-auto__text">
          <span>启动时自动检查</span>
          <span className="update-auto__note">
            每天最多一次；发现新版本只在侧栏轻提示，不打断播放。
          </span>
        </span>
      </label>

      {error ? <ErrorBar message={error} /> : null}

      <div className="settings-actions">
        <button
          type="button"
          className="btn"
          disabled={phase === "checking" || phase === "downloading"}
          onClick={() => void check()}
        >
          {phase === "checking" ? "检查中…" : "检查更新"}
        </button>
        {info?.hasUpdate && phase !== "ready" ? (
          <button
            type="button"
            className="btn btn--primary"
            disabled={phase === "downloading"}
            onClick={() => void download()}
          >
            {phase === "downloading" ? "下载中…" : "下载更新"}
          </button>
        ) : null}
        {phase === "ready" && !IS_DEV_BUILD ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setConfirming(true)}
          >
            立即安装
          </button>
        ) : null}
      </div>

      {phase === "downloading" ? (
        <div className="update-progress" role="progressbar" aria-valuenow={percent}>
          <span className="update-progress__bar" style={{ width: `${percent}%` }} />
          <span className="update-progress__text">
            {progress
              ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)} · ${percent}%`
              : "正在连接…"}
          </span>
        </div>
      ) : null}

      {tip ? <p className="tip tip--ok">{tip}</p> : null}

      {/* 更新说明来自 CHANGELOG，纯文本展示：不渲染 markdown，避免源站内容进 DOM。 */}
      {info?.hasUpdate && info.notes ? (
        <details className="update-notes">
          <summary>更新说明</summary>
          <pre>{info.notes}</pre>
        </details>
      ) : null}

      {IS_DEV_BUILD ? (
        <p className="settings-line">
          当前是调试构建：可以检查与下载，但不会执行安装（会覆盖正式版安装目录）。
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        title="安装新版本"
        message={
          info
            ? `应用将退出并静默安装 ${formatVersion(info.latest)}，安装完成后请重新打开 Luma。`
            : "应用将退出并安装新版本，完成后请重新打开 Luma。"
        }
        confirmText="安装并退出"
        onConfirm={() => void install()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
