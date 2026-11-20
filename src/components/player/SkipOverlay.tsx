import { createPortal } from "react-dom";
import type { AutoSkipPending } from "../../hooks/useAutoSkipPrompt";

/**
 * 片头/片尾自动跳过的轻提示：进入窗口只显「N 秒后跳过片头」，3 秒到点执行。
 *
 * 不再有常驻的「跳过片头/片尾」按钮——窗口态由引擎上报，自动跳过已经覆盖了
 * 手动按钮的全部用途；取消后本次不跳，也不会留一个显眼的按钮占着画面。
 */
interface Props {
  host: HTMLDivElement | null;
  pending: AutoSkipPending | null;
  onCancelAuto: () => void;
}

const KIND_LABEL: Record<"intro" | "outro", string> = { intro: "片头", outro: "片尾" };

export function SkipOverlay({ host, pending, onCancelAuto }: Props) {
  if (!host || !pending) {
    return null;
  }
  return createPortal(
    <div
      className={`skip-overlay__auto skip-overlay__auto--${pending.kind}`}
      role="status"
      aria-live="off"
    >
      <span className="skip-overlay__auto-text">
        {pending.remaining} 秒后跳过{KIND_LABEL[pending.kind]}
      </span>
      <button type="button" className="skip-overlay__auto-cancel" onClick={onCancelAuto}>
        取消
      </button>
    </div>,
    host,
  );
}