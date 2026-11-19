import { createPortal } from "react-dom";
import type { SkipWindowState } from "../../hooks/usePlayerEngine";

/**
 * 片头/片尾「跳过」动作按钮（portal 进 ArtPlayer 模板根，跟画面走、随全屏移动）。
 *
 * 只承载**即时操作**：落在片头窗口显「跳过片头」、落在片尾窗口显「跳过片尾」。
 * 配置（设秒数 / 取当前时间）不在这儿——入口在 ArtPlayer 原生齿轮，点开是
 * `SkipSettingsDialog`。组件只展示 + 把意图交给回调，判定与持久化在引擎 / PlayerPage。
 */
interface Props {
  host: HTMLDivElement | null;
  state: SkipWindowState | null;
  onSkipIntro: () => void;
  onSkipOutro: () => void;
}

export function SkipOverlay({ host, state, onSkipIntro, onSkipOutro }: Props) {
  if (!host) {
    return null;
  }
  return createPortal(
    <>
      {state?.inIntro ? (
        <button type="button" className="skip-overlay__btn skip-overlay__btn--intro" onClick={onSkipIntro}>
          跳过片头
        </button>
      ) : null}
      {state?.inOutro ? (
        <button type="button" className="skip-overlay__btn skip-overlay__btn--outro" onClick={onSkipOutro}>
          跳过片尾
        </button>
      ) : null}
    </>,
    host,
  );
}
