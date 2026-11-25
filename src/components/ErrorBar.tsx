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
  /**
   * 给人看的补充说明（下一步能做什么）。
   *
   * 与 `hint` 分工：`hint` 是**归因**（一句话说这是什么错，如「源站未响应」），
   * `description` 是**处置**（重试 / 换源）。只在页级错误（`size="panel"`）
   * 里放大成正文；条状里它与 hint 同级，够用就好。
   */
  description?: string;
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
  /**
   * 呈现尺寸：
   *
   * - `bar`（默认）＝页内横幅，压在当前内容之上，不接管版面；
   * - `compact` ＝ 窄面板（直播左栏 272px）里的一小条，同一套解剖结构去留白；
   * - `panel` ＝ **错误就是这一屏的内容**（详情页整页失败）：同一套解剖结构
   *   装进一张居中卡片，由页面套 `.detail-empty-wrap` 垂直居中。贴顶横幅
   *   在整页失败时会留下「一条红字 + 一大片黑」，看起来像页面没渲染完。
   */
  size?: "bar" | "compact" | "panel";
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
  description,
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

  // timed 到期两段式退场：先挂 is-leaving 淡出（180ms，只动 opacity/transform，
  // 见 feedback.css），再真正卸载——直接 return null 是硬消失。倒计时重置
  // （ttl 变化）时对称复位，不留下「半退场」状态。
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!countdown.expired) {
      setLeaving(false);
      setGone(false);
      return;
    }
    setLeaving(true);
    const timer = window.setTimeout(() => setGone(true), 180);
    return () => window.clearTimeout(timer);
  }, [countdown.expired]);

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

  if (gone) {
    return null;
  }

  // 空文案只剩图标与复制按钮——一块「红色空洞」。页面侧本就各自守卫错误态，
  // 这里再兜一层：没有可说的话就别说（2026-11-20 全页体检：存储节无条件渲染
  // loadError="" 的空条）。
  if (!message) {
    return null;
  }

  const isPanel = size === "panel";

  return (
    <div
      className={
        (isPanel
          ? "error-bar error-bar--panel"
          : size === "compact"
            ? "error-bar error-bar--compact"
            : "error-bar") + (leaving ? " is-leaving" : "")
      }
      role="alert"
      data-lifetime={lifetime}
      onMouseEnter={countdown.hold}
      onMouseLeave={countdown.release}
    >
      <Icon
        name="alert"
        size={isPanel ? 20 : 16}
        className="error-bar__icon"
      />
      <div className="error-bar__body">
        <p className="error-bar__text">{message}</p>
        {hint ? <p className="error-bar__hint">{hint}</p> : null}
        {description ? (
          <p className="error-bar__desc">{description}</p>
        ) : null}
        {detail || (isPanel && copyable) ? (
          <div className="error-bar__tech">
            {detail ? (
              <details className="error-bar__detail">
                <summary>技术详情</summary>
                <pre className="error-bar__raw">{detail}</pre>
              </details>
            ) : null}
            {/* 面板态把「复制错误」挂在技术详情同一行：两者都是诊断动作，
                塞进动作行会让人以为它和「换源」是一类；也不钉在行尾——那样
                拉出长长一条空档，卡片看着散。 */}
            {isPanel && copyable ? (
              <button
                type="button"
                className="btn btn--ghost error-bar__copy"
                onClick={onCopy}
                data-copy-state={copyState}
              >
                <Icon name={copyState === "ok" ? "check" : "copy"} />
                {copyState === "ok"
                  ? "已复制"
                  : copyState === "failed"
                    ? "复制失败"
                    : "复制错误"}
              </button>
            ) : null}
          </div>
        ) : null}
        {actions || (isPanel && onRetry) ? (
          <div className="error-bar__extra">
            {/* 页级错误里「重试」是主目标动作：给文字按钮，不用只有图标的
                小按钮——整页都在等这一个决定，别让人去猜图标含义。 */}
            {isPanel && onRetry ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={onRetry}
              >
                <Icon name="refresh" />
                重试
              </button>
            ) : null}
            {actions}
          </div>
        ) : null}
      </div>
      <div className="error-bar__actions">
        <NoticeLife left={countdown.left} progress={countdown.progress} />
        {/* 图标复制的入口只服务条状/窄面板；面板态已把复制换成文字按钮。 */}
        {copyable && !isPanel ? (
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
        {/* 面板态的重试已经在正文里，这里不再放第二个入口。 */}
        {onRetry && !isPanel ? (
          <IconButton name="refresh" label="重试" size="sm" onClick={onRetry} />
        ) : null}
      </div>
    </div>
  );
}
