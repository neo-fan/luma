import { useState } from "react";
import { createPortal } from "react-dom";
import type { SkipWindowState } from "../../hooks/usePlayerEngine";
import { introMs, outroMs, type SkipSegment } from "../../lib/skipSegments";

/**
 * 片头/片尾跳过浮层（portal 进 ArtPlayer 模板根，跟画面走、随全屏移动）。
 *
 * - 落在片头窗口 → 「跳过片头」；落在片尾窗口 → 「跳过片尾」。点击 seek 由调用方
 *   决定（片头跳 introMs、片尾跳到结尾触发既有「下一集」）。
 * - 齿轮打开内联编辑器，按「秒」设这部剧的片头/片尾时长；改动即时回写 history。
 *
 * 组件只负责展示与把用户意图交给回调，判定与持久化都在 `skipSegments` / PlayerPage。
 */
interface Props {
  host: HTMLDivElement | null;
  state: SkipWindowState | null;
  config: SkipSegment[];
  onSkipIntro: () => void;
  onSkipOutro: () => void;
  onConfigChange: (segments: SkipSegment[]) => void;
}

const MAX_SEC = 1800; // 与 skipSegments 的 30min 上限对齐

function toSegments(introSec: number, outroSec: number): SkipSegment[] {
  const out: SkipSegment[] = [];
  if (introSec > 0) out.push({ kind: "intro", ms: Math.round(introSec * 1000) });
  if (outroSec > 0) out.push({ kind: "outro", ms: Math.round(outroSec * 1000) });
  return out;
}

export function SkipOverlay({ host, state, config, onSkipIntro, onSkipOutro, onConfigChange }: Props) {
  const [editing, setEditing] = useState(false);
  if (!host) {
    return null;
  }

  const curIntroSec = Math.round(introMs(config) / 1000);
  const curOutroSec = Math.round(outroMs(config) / 1000);

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

      <button
        type="button"
        className="skip-overlay__gear"
        aria-label="设置片头片尾"
        title="设置片头片尾"
        onClick={() => setEditing((v) => !v)}
      >
        ⚙
      </button>

      {editing ? (
        <div className="skip-overlay__panel" role="dialog" aria-label="片头片尾设置">
          <label className="skip-overlay__field">
            <span>片头（秒）</span>
            <input
              type="number"
              min={0}
              max={MAX_SEC}
              value={curIntroSec}
              onChange={(e) =>
                onConfigChange(toSegments(Number(e.target.value) || 0, curOutroSec))
              }
            />
          </label>
          <label className="skip-overlay__field">
            <span>片尾（秒）</span>
            <input
              type="number"
              min={0}
              max={MAX_SEC}
              value={curOutroSec}
              onChange={(e) =>
                onConfigChange(toSegments(curIntroSec, Number(e.target.value) || 0))
              }
            />
          </label>
          <p className="skip-overlay__hint">按这部剧记忆，换源也带着走；设 0 即不跳。</p>
          <button type="button" className="skip-overlay__close" onClick={() => setEditing(false)}>
            完成
          </button>
        </div>
      ) : null}
    </>,
    host,
  );
}
