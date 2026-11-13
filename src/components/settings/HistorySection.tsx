import { useState } from "react";
import ConfirmDialog from "../ConfirmDialog";
import { api, errorMessage } from "../../lib/invoke";
import { log } from "../../lib/logger";

interface HistorySectionProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

/** 观看历史管理：清空全部历史（带二次确认）。 */
export default function HistorySection({ onError, onNotice }: HistorySectionProps) {
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);

  const clearHistory = () => {
    setConfirmClearHistory(true);
  };

  const doClearHistory = async () => {
    setConfirmClearHistory(false);
    onError("");
    onNotice("");
    try {
      await api.historyClear();
      onNotice("已清空观看历史");
      log.info("history cleared");
    } catch (err) {
      onError(`清空历史失败：${errorMessage(err)}`);
    }
  };

  return (
    <div className="settings-block">
      <h2 className="section-title">观看历史</h2>
      <button type="button" className="btn btn--danger" onClick={() => void clearHistory()}>
        清空历史
      </button>

      <ConfirmDialog
        open={confirmClearHistory}
        title="清空观看历史"
        message="确定清空全部观看历史吗？此操作不可恢复。"
        confirmText="清空"
        danger
        onConfirm={() => void doClearHistory()}
        onCancel={() => setConfirmClearHistory(false)}
      />
    </div>
  );
}
