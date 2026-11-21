import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import Empty from "./Empty";
import ErrorBar from "./ErrorBar";
import Spinner from "./Spinner";
import { classifyFailure } from "../lib/failureReason";

interface AsyncBoundaryProps {
  /** 正在首次加载（此时通常还没有数据）。 */
  loading: boolean;
  /**
   * 原始错误文案（一般是 `errorMessage(err)`，可能含完整 URL / 解析器
   * 行列号）。组件用 `classifyFailure` 归类：**界面只出归因，原文折叠**。
   * 传空串即不展示。
   */
  error?: string;
  /** 错误主文案：说清是哪一步失败（默认「加载失败」）。 */
  errorTitle?: string;
  /** 没有可展示的数据（初始加载、空结果、加载失败都算）。 */
  isEmpty: boolean;
  loadingLabel?: string;
  /**
   * 长等待期的骨架节点（如搜索的卡片网格）。传了就替代居中 Spinner——
   * 转圈适合几秒内的短等待，10 秒以上的等待需要预示结果形态。
   */
  skeleton?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  /** 空态插图（默认收件箱）；列表页传语义更贴的图标，如 Star / Tv。 */
  emptyIcon?: LucideIcon;
  /** 错误重试回调；传了才显示重试按钮。 */
  onRetry?: () => void;
  /** 错误附带动作（如「换个站点」）。 */
  errorAction?: ReactNode;
  /** 错误栏是否带复制按钮（默认 true）。 */
  errorCopyable?: boolean;
  children: ReactNode;
}

/**
 * 页面级异步态统一容器：把「加载中 / 出错 / 空态 / 内容」四态收敛到一处，
 * 消除每个列表页重复写的 Spinner / ErrorBar / Empty 三段样板。
 *
 * 渲染优先级：
 *   1. error 顶栏（不阻塞已有内容，所以有数据时 ErrorBar 与 children 共存）
 *   2. 首次加载且空 → 居中 Spinner
 *   3. 已结束且空 → 空态
 *   4. 有数据（!isEmpty）→ children
 *
 * 错误文案在这里统一「归类 + 折叠原文」：调用方只传 `errorMessage(err)`，不必各自
 * 判断哪些报错能露脸。各写一份迟早会漏，一次疏漏就会让 `fetch https://… failed`
 * 直出界面。
 */
export default function AsyncBoundary({
  loading,
  error,
  errorTitle = "加载失败",
  isEmpty,
  loadingLabel = "加载中…",
  skeleton,
  emptyTitle = "暂无内容",
  emptyDescription,
  emptyAction,
  emptyIcon,
  onRetry,
  errorAction,
  errorCopyable = true,
  children,
}: AsyncBoundaryProps) {
  const reason = error ? classifyFailure(undefined, error) : null;
  return (
    <>
      {reason ? (
        <ErrorBar
          message={errorTitle}
          hint={reason.kind === "unknown" ? undefined : reason.label}
          detail={reason.raw}
          onRetry={onRetry}
          actions={errorAction}
          copyable={errorCopyable}
        />
      ) : null}
      {!error && loading && isEmpty
        ? (skeleton ?? <Spinner center label={loadingLabel} />)
        : null}
      {!error && !loading && isEmpty ? (
        <Empty
          title={emptyTitle}
          description={emptyDescription}
          action={emptyAction}
          icon={emptyIcon}
        />
      ) : null}
      {!isEmpty ? children : null}
    </>
  );
}
