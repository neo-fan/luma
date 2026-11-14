import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { noticeTtl } from "../lib/notice";
import { useNoticeCountdown } from "../hooks/useNoticeCountdown";
import IconButton from "./IconButton";
import NoticeLife from "./NoticeLife";

interface ErrorBarProps {
  message: string;
  onRetry?: () => void;
  /** 隐藏复制按钮的场景（默认显示，错误可复制便于反馈）。 */
  copyable?: boolean;
  /**
   * 存活策略（不是严重级别）：
   *
   * - `sticky`（默认）＝常驻：需要用户处置（全部线路不可播、导入失败），
   *   自动消失等于把唯一出口藏起来；
   * - `timed` ＝ 按 `NOTICE_TTL.warn`（8s）带倒计时收起：时效性结论
   *   （此刻这条线路不行），画面可能已自愈或在别的线路上播着，挂着就是
   *   过期信息。
   */
  lifetime?: "sticky" | "timed";
  /** 覆盖时长（毫秒）；0 = 常驻。一般不用传。 */
  ttlMs?: number;
}

type CopyState = "idle" | "ok" | "failed";

/**
 * 页内错误横幅：中文文案 + 一键复制 + 可选重试 + 可选的倒计时生命线。
 *
 * 与全局 toast 的分工（架构约定，勿混用）：
 *  - toast ＝ 与页面主内容无关的**事件**（已自动换线、已加入收藏），浮层、不推布局；
 *  - ErrorBar ＝ **阻断当前任务**、需要用户看一眼并决策的错误，占位醒目；
 *  - `.tip` ＝ 长期说明（不是事件），常驻、无动作。
 * 倒计时与进度线由 `useNoticeCountdown` + `NoticeLife` 提供，和 toast 共用同一套
 * 实现与样式，保证「同一个系统里的提示长得一样」。
 */
export default function ErrorBar({
  message,
  onRetry,
  copyable = true,
  lifetime = "sticky",
  ttlMs,
}: ErrorBarProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | null>(null);
  const countdown = useNoticeCountdown(
    ttlMs ?? (lifetime === "timed" ? noticeTtl("warn") : 0),
  );

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

  if (countdown.expired) {
    return null;
  }

  return (
    <div
      className="error-bar"
      role="alert"
      data-lifetime={lifetime}
      onMouseEnter={countdown.hold}
      onMouseLeave={countdown.release}
    >
      <span className="error-bar__text">{message}</span>
      <div className="error-bar__actions">
        <NoticeLife left={countdown.left} progress={countdown.progress} />
        {copyable ? (
          <IconButton
            name={copyState === "ok" ? "check" : "copy"}
            label={
              copyState === "ok" ? "已复制" : copyState === "failed" ? "复制失败" : "复制错误"
            }
            size="sm"
            className={copyState === "ok" ? "is-on" : ""}
            onClick={onCopy}
            data-copy-state={copyState}
          />
        ) : null}
        {onRetry ? <IconButton name="refresh" label="重试" size="sm" onClick={onRetry} /> : null}
      </div>
    </div>
  );
}
