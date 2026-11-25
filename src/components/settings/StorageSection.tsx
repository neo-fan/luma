import { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "../ConfirmDialog";
import ErrorBar from "../ErrorBar";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { api, errorMessage } from "../../lib/invoke";
import { log } from "../../lib/logger";
import { clearDataCache } from "../../lib/queryClient";
import type { StorageTarget, StorageUsage } from "../../types/luma";
import { formatBytes } from "./settingsShared";

interface StorageSectionProps {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

interface Row {
  target: StorageTarget;
  label: string;
  hint: string;
}

const ROWS: Row[] = [
  {
    target: "imageCache",
    label: "缓存",
    hint: "封面图与页面数据的本机副本；清掉后重新取，不影响收藏、历史和配置。已在屏幕上的封面可能还留在网页缓存里。",
  },
  {
    target: "logs",
    label: "日志",
    hint: "删除历史日志文件。正在写入的当天日志只清空内容，不留空文件句柄。",
  },
  {
    target: "reports",
    label: "反馈报告",
    hint: "删除此前「导出反馈」生成的文件；已经复制或发送到别处的不受影响。",
  },
];

/**
 * 存储与清理：日志、反馈报告、封面缓存都只增不减（日志按 7 天滚动、报告每导一份
 * 多一份、缓存换配置后会留着不再引用的条目），这里给一个立刻腾空间的入口，
 * 而不是等用户去翻数据目录。观看历史的清理在历史页，不在此处重复。
 */
export default function StorageSection({ onError, onNotice }: StorageSectionProps) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loadError, setLoadError] = useState("");
  const { busy, run: runAction } = useAsyncAction<StorageTarget>();
  const [pending, setPending] = useState<StorageTarget | "">("");

  const load = useCallback(async () => {
    try {
      setUsage(await api.storageUsage());
      setLoadError("");
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rowOf = (row: Row) =>
    row.target === "logs"
      ? usage?.logs
      : row.target === "reports"
        ? usage?.reports
        : usage?.imageCache;

  const doClear = async (target: StorageTarget) => {
    setPending("");
    onError("");
    onNotice("");
    await runAction(target, async () => {
      const outcome = await api.storageClear(target);
      if (target === "imageCache") {
        // 内存里的页面数据缓存与磁盘副本同源，一起丢掉才不会「清了又显示旧的」。
        clearDataCache();
      }
      const label = ROWS.find((row) => row.target === target)?.label ?? target;
      const skipped =
        outcome.skipped > 0 ? `，${outcome.skipped} 项正被占用未能清理` : "";
      onNotice(
        `已清理${label}，释放 ${formatBytes(outcome.freedBytes)}，剩余 ${
          formatBytes(outcome.remaining.bytes)
        }${skipped}`,
      );
      log.info("storage cleared", {
        target,
        freedBytes: String(outcome.freedBytes),
        skipped: String(outcome.skipped),
      });
      await load();
    }).catch((err) => {
      onError(`清理失败：${errorMessage(err)}`);
    });
  };

  const total = usage
    ? usage.logs.bytes + usage.reports.bytes + usage.imageCache.bytes
    : 0;

  return (
    <div className="settings-block">
      <h2 className="section-title">
        存储与清理
        <span className="config-item__meta">　本机占用共 {formatBytes(total)}</span>
      </h2>
      {loadError ? <ErrorBar message={loadError} /> : null}

      <ul className="config-list">
        {ROWS.map((row) => {
          const usageRow = rowOf(row);
          const empty = !usageRow || (usageRow.bytes === 0 && usageRow.files === 0);
          return (
            <li className="config-item" key={row.target}>
              <div className="config-item__main">
                <span className="config-item__name">{row.label}</span>
                <span className="config-item__meta">
                  {usageRow
                    ? `${formatBytes(usageRow.bytes)} · ${usageRow.files} 个文件`
                    : "统计中…"}
                </span>
                <span className="config-item__refresh">{row.hint}</span>
              </div>
              <button
                type="button"
                className="btn btn--sm"
                disabled={empty || busy !== null}
                onClick={() => setPending(row.target)}
              >
                {busy === row.target ? "清理中…" : "清理"}
              </button>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={pending !== ""}
        title={`清理${ROWS.find((row) => row.target === pending)?.label ?? ""}`}
        message="清理后这部分内容会重新联网获取，此操作不可恢复。确定继续？"
        confirmText="清理"
        onConfirm={() => {
          if (pending !== "") {
            void doClear(pending);
          }
        }}
        onCancel={() => setPending("")}
      />
    </div>
  );
}
