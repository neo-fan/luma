import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { copyText } from "../lib/clipboard";
import { noticeTtl } from "../lib/notice";
import { useNoticeCountdown } from "../hooks/useNoticeCountdown";
import Icon from "./Icon";
import IconButton from "./IconButton";
import NoticeLife from "./NoticeLife";

interface ErrorBarProps {
  /** 人话主文案：一句话说清**哪一步**失败了（如「首页内容加载失败」）。 */
  message: string;
  /**
   * 归类后的一句归因（`classifyFailure().label`，如「源站超时」）。
   * 只放结论，不放原始报错——原始报错走 `detail`。
   */
  hint?: string;
  /**
   * 原始报错全文。默认折叠在「技术详情」里：用户 99% 不需要它，但反馈
   * 问题时要能一键拿到。**绝不直接铺在主文案里**（那会把界面变成日志）。
   */
  detail?: string;
  onRetry?: () => void;
  /** 额外动作（如「换一个直播源」），走 `.btn` 视觉层级，与图标动作区分。 */
  actions?: ReactNode;
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
  /** `compact` 用于窄面板（直播左栏 272px）：同一套解剖结构，去掉留白。 */
  size?: "bar" | "compact";
}

type CopyState = "idle" | "ok" | "failed";

/**
 * 页内错误横幅。
 *
 * 解剖结构固定为四段，全站所有错误态都长这样：
 *   [图标] 主文案（哪一步失败）
 *          归因（哪种失败）
 *          ▸ 技术详情（原始报错，折叠）
 *                            [复制] [重试/换源] [倒计时]
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
  hint,
  detail,
  onRetry,
  actions,
  copyable = true,
  lifetime = "sticky",
  ttlMs,
  size = "bar",
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

  /** 复制的是「可贴进反馈工单」的整段：主文案 + 归因 + 原始报错。 */
  const onCopy = useCallback(async () => {
    const payload = [message, hint, detail].filter(Boolean).join("\n");
    const result = await copyText(payload);
    setCopyState(result === "failed" ? "failed" : "ok");
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
    }
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800);
  }, [message, hint, detail]);

  if (countdown.expired) {
    return null;
  }

  return (
    <div
      className={
        size === "compact" ? "error-bar error-bar--compact" : "error-bar"
      }
      role="alert"
      data-lifetime={lifetime}
      onMouseEnter={countdown.hold}
      onMouseLeave={countdown.release}
    >
      <Icon name="alert" size={16} className="error-bar__icon" />
      <div className="error-bar__body">
        <p className="error-bar__text">{message}</p>
        {hint ? <p className="error-bar__hint">{hint}</p> : null}
        {detail ? (
          <details className="error-bar__detail">
            <summary>技术详情</summary>
            <pre className="error-bar__raw">{detail}</pre>
          </details>
        ) : null}
        {actions ? <div className="error-bar__extra">{actions}</div> : null}
      </div>
      <div className="error-bar__actions">
        <NoticeLife left={countdown.left} progress={countdown.progress} />
        {copyable ? (
          <IconButton
            name={copyState === "ok" ? "check" : "copy"}
            label={
              copyState === "ok"
                ? "已复制"
                : copyState === "failed"
                  ? "复制失败"
                  : "复制错误"
            }
            size="sm"
            className={copyState === "ok" ? "is-on" : ""}
            onClick={onCopy}
            data-copy-state={copyState}
          />
        ) : null}
        {onRetry ? (
          <IconButton name="refresh" label="重试" size="sm" onClick={onRetry} />
        ) : null}
      </div>
    </div>
  );
}
