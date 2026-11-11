import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";

interface ErrorBarProps {
  message: string;
  onRetry?: () => void;
  /** 隐藏复制按钮的场景（默认显示，错误可复制便于反馈）。 */
  copyable?: boolean;
}

type CopyState = "idle" | "ok" | "failed";

/** 内联错误提示：中文文案 + 一键复制 + 可选重试。 */
export default function ErrorBar({ message, onRetry, copyable = true }: ErrorBarProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  const onCopy = useCallback(async () => {
    const result = await copyText(message);
    setCopyState(result === "failed" ? "failed" : "ok");
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
    }
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800);
  }, [message]);

  return (
    <div className="error-bar" role="alert">
      <span className="error-bar__text">{message}</span>
      <div className="error-bar__actions">
        {copyable ? (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={onCopy}
            data-copy-state={copyState}
            aria-label="复制错误"
          >
            {copyState === "ok" ? "已复制" : copyState === "failed" ? "复制失败" : "复制错误"}
          </button>
        ) : null}
        {onRetry ? (
          <button type="button" className="btn btn--sm" onClick={onRetry}>
            重试
          </button>
        ) : null}
      </div>
    </div>
  );
}
