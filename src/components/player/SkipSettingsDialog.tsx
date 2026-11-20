import { createPortal } from "react-dom";
import {
  clampSkipMs,
  formatSkipMs,
  introMs,
  outroMs,
  withSkipMs,
  type SkipSegment,
} from "../../lib/skipSegments";

/**
 * 片头/片尾「自定义配置弹窗」——由 ArtPlayer 原生齿轮里那行「片头/片尾」打开。
 *
 * 入口统一进齿轮，但弹窗是我们自己的：每类既能手填秒数，也能**一键取当前播放
 * 时间**：
 *   - 片头 = 当前时间点（开头到这里算片头）；
 *   - 片尾 = 当前到结尾的剩余时长（从这里到结束算片尾）。
 * 改动即时交给 `onConfigChange`（PlayerPage 写回这部剧的 history.skipJson）。
 * portal 进播放器根，跟画面走、全屏时仍在画面内。
 */
interface Props {
  host: HTMLDivElement | null;
  open: boolean;
  config: SkipSegment[];
  /** 这部剧的「跳过」开关：关掉只是不跳，已配好的时长保留。 */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  /** 读当前播放头与时长（秒）；拿不到（未就绪）返回 null，取点按钮随之禁用。 */
  getPlayhead: () => { currentMs: number; durationMs: number } | null;
  onConfigChange: (segments: SkipSegment[]) => void;
  onClose: () => void;
}

const MAX_SEC = 1800; // 与 skipSegments 的 30min 上限对齐

export function SkipSettingsDialog({
  host,
  open,
  config,
  enabled,
  onEnabledChange,
  getPlayhead,
  onConfigChange,
  onClose,
}: Props) {
  if (!host || !open) {
    return null;
  }

  const introSec = Math.round(introMs(config) / 1000);
  const outroSec = Math.round(outroMs(config) / 1000);
  const head = getPlayhead();
  const canCaptureIntro = !!head && head.currentMs > 1000;
  const canCaptureOutro =
    !!head && Number.isFinite(head.durationMs) && head.durationMs > head.currentMs + 1000;

  const setInput = (sec: number) => onConfigChange(withSkipMs(config, "intro", clampSkipMs((Number(sec) || 0) * 1000)));
  const setOutro = (sec: number) => onConfigChange(withSkipMs(config, "outro", clampSkipMs((Number(sec) || 0) * 1000)));
  const captureIntro = () => {
    if (!head) return;
    onConfigChange(withSkipMs(config, "intro", Math.round(head.currentMs)));
  };
  const captureOutro = () => {
    if (!head) return;
    onConfigChange(withSkipMs(config, "outro", Math.round(head.durationMs - head.currentMs)));
  };

  return createPortal(
    <div className="skip-overlay__panel" role="dialog" aria-label="片头片尾设置">
      <div className="skip-overlay__head">
        <span className="skip-overlay__title">片头 / 片尾</span>
        <label className="skip-overlay__switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
          />
          <span>{enabled ? "跳过已开" : "跳过已关"}</span>
        </label>
        <button
          type="button"
          className="skip-overlay__dismiss"
          aria-label="关闭设置"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <div className="skip-overlay__field">
        <label htmlFor="skip-intro">片头（秒）</label>
        <input
          id="skip-intro"
          type="number"
          min={0}
          max={MAX_SEC}
          value={introSec}
          onChange={(e) => setInput(Number(e.target.value) || 0)}
        />
        <button
          type="button"
          className="skip-overlay__capture"
          onClick={captureIntro}
          disabled={!canCaptureIntro}
          title={canCaptureIntro ? `把当前 ${formatSkipMs(head!.currentMs)} 设为片头长度` : "播放中才能取点"}
        >
          取当前
        </button>
      </div>

      <div className="skip-overlay__field">
        <label htmlFor="skip-outro">片尾（秒）</label>
        <input
          id="skip-outro"
          type="number"
          min={0}
          max={MAX_SEC}
          value={outroSec}
          onChange={(e) => setOutro(Number(e.target.value) || 0)}
        />
        <button
          type="button"
          className="skip-overlay__capture"
          onClick={captureOutro}
          disabled={!canCaptureOutro}
          title={canCaptureOutro ? `把「当前到结尾」${formatSkipMs(head!.durationMs - head!.currentMs)} 设为片尾` : "需要有效时长"}
        >
          到结尾
        </button>
      </div>

      <button type="button" className="skip-overlay__close" onClick={onClose}>
        完成
      </button>
    </div>,
    host,
  );
}
