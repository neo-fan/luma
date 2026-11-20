import { createPortal } from "react-dom";
import type { SkipWindowState } from "../../hooks/usePlayerEngine";
import type { AutoSkipPending } from "../../hooks/useAutoSkipPrompt";

/**
 * 片头/片尾浮层：两种形态共用一个 portal（进 ArtPlayer 模板根，跟画面走、随全屏移动）。
 *
 * 1. **自动跳过倒计时**（`pending`）：配置后进入窗口，先显「N 秒后跳过片头/片尾 · 取消」，
 *    到点由 PlayerPage 执行跳转；用户在倒计时内点取消则本次不跳。倒计时期间**隐藏**同类的
 *    手动按钮，不重复。
 * 2. **手动跳过按钮**：落在片头窗口显「跳过片头」、落在片尾窗口显「跳过片尾」——取消自动跳后，
 *    或没有自动跳介入时仍可直接点。
 *
 * 配置（设秒数 / 取当前时间）不在这儿——入口在 ArtPlayer 原生齿轮，点开是
 * `SkipSettingsDialog`。判定与持久化在引擎 / PlayerPage，这里只展示 + 把意图交给回调。
 */
interface Props {
  host: HTMLDivElement | null;
  state: SkipWindowState | null;
  pending: AutoSkipPending | null;
  onSkipIntro: () => void;
  onSkipOutro: () => void;
  onCancelAuto: () => void;
}

const KIND_LABEL: Record<"intro" | "outro", string> = { intro: "片头", outro: "片尾" };

export function SkipOverlay({ host, state, pending, onSkipIntro, onSkipOutro, onCancelAuto }: Props) {
  if (!host) {
    return null;
  }
  return createPortal(
    <>
      {pending ? (
        <div className={`skip-overlay__auto skip-overlay__auto--${pending.kind}`} role="status">
          <span className="skip-overlay__auto-text">
            {pending.remaining} 秒后跳过{KIND_LABEL[pending.kind]}
          </span>
          <button type="button" className="skip-overlay__auto-cancel" onClick={onCancelAuto}>
            取消
          </button>
        </div>
      ) : null}
      {state?.inIntro && pending?.kind !== "intro" ? (
        <button type="button" className="skip-overlay__btn skip-overlay__btn--intro" onClick={onSkipIntro}>
          跳过片头
        </button>
      ) : null}
      {state?.inOutro && pending?.kind !== "outro" ? (
        <button type="button" className="skip-overlay__btn skip-overlay__btn--outro" onClick={onSkipOutro}>
          跳过片尾
        </button>
      ) : null}
    </>,
    host,
  );
}
