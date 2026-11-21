import { useEffect, useState } from "react";
import ErrorBar from "../ErrorBar";
import { api, errorMessage } from "../../lib/invoke";
import { log } from "../../lib/logger";
import {
  APP_VERSION,
  formatBuildTime,
  formatVersion,
  readableBuildTime,
} from "../../lib/version";
import type { Diagnostics } from "../../types/luma";
import { copyText, formatBytes } from "./settingsShared";

interface DiagnosticSectionProps {
  /** 父级 reload 计数：导入/切换配置后重新读取版本与目录。 */
  reload: number;
}

/** 版本与日志：展示运行环境，并提供复制诊断信息 / 导出反馈文件。 */
export default function DiagnosticSection({ reload }: DiagnosticSectionProps) {
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
    <div className="settings-block">
      <h2 className="section-title">版本与日志</h2>
      <div className="settings-kv">
        <span>版本</span>
        <code>{formatVersion(diag?.version ?? APP_VERSION)}</code>
        <span>通道</span>
        <code>{diag?.channel ?? "读取中…"}</code>
        {/* 前后端共用一个 build 号：宿主本次启动时刻（Diagnostics.startedAt）。
            不分前端 / 后端两行——dev 下两者必然对不上。 */}
        <span>构建号</span>
        <code title={readableBuildTime(diag?.startedAt) || undefined}>
          {diag
            ? `build: ${formatBuildTime(diag.startedAt) || "unknown"}`
            : "读取中…"}
        </code>
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
        <span>当前订阅</span>
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
        订阅、收藏与观看记录都保存在本机应用数据目录，不会上传到云端。日志同样只写本机，
        保留最近 7 天，URL 会去掉查询参数后记录；反馈问题时请附上日志目录里的文件。
      </p>
    </div>
  );
}
