import { useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除 / 清空）：确认键走红色样式。 */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 应用内确认弹层：替代原生 `window.confirm`。
 *
 * 原生 confirm 在 Tauri 里会弹出浏览器样式的对话框，标题可能显示
 * `localhost`、整体视觉也与软件设计语言脱节。这里复用 `.overlay` 遮罩与
 * 面板样式，确认/取消两个按钮沿用 `.btn` 体系，保证一致。
 *
 * Esc 取消、Enter 确认；点遮罩（非面板）取消。三个调用点（历史清空、
 * 配置删除、配置内历史清空）共用本组件。
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确定",
  cancelText = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) {
      return;
    }
    // Esc 关闭交给 Radix Dialog（onOpenChange -> onCancel），这里只管 Enter 确认。
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm]);

  return (
    // 焦点陷阱与 Esc 由 Radix 统一管理；Content 即全屏遮罩（复用 .overlay），
    // 点空白取消保留原 onMouseDown 逻辑。
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Content asChild className="overlay" aria-label={title}>
          <div
            className="overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                onCancel();
              }
            }}
          >
            <div className="confirm" role="alertdialog" aria-modal="true" aria-label={title}>
              <h2 className="confirm__title">{title}</h2>
              <p className="confirm__message">{message}</p>
              <div className="confirm__actions">
                <button type="button" className="btn btn--ghost" onClick={onCancel}>
                  {cancelText}
                </button>
                <button
                  type="button"
                  className={danger ? "btn btn--danger" : "btn btn--primary"}
                  onClick={onConfirm}
                >
                  {confirmText}
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
