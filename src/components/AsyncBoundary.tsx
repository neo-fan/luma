import type { ReactNode } from "react";
import Empty from "./Empty";
import ErrorBar from "./ErrorBar";
import Spinner from "./Spinner";

interface AsyncBoundaryProps {
  /** 正在首次加载（此时通常还没有数据）。 */
  loading: boolean;
  /**
   * 错误文案；非空时在顶栏展示 ErrorBar（非阻塞——若已有数据，下方内容照常渲染）。
   * 传空串即不展示。
   */
  error?: string;
  /** 没有可展示的数据（初始加载、空结果、加载失败都算）。 */
  isEmpty: boolean;
  loadingLabel?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  /** 错误重试回调；传了才显示重试按钮。 */
  onRetry?: () => void;
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
 */
export default function AsyncBoundary({
  loading,
  error,
  isEmpty,
  loadingLabel = "加载中…",
  emptyTitle = "暂无内容",
  emptyDescription,
  emptyAction,
  onRetry,
  errorCopyable = true,
  children,
}: AsyncBoundaryProps) {
  return (
    <>
      {error ? (
        <ErrorBar message={error} onRetry={onRetry} copyable={errorCopyable} />
      ) : null}
      {!error && loading && isEmpty ? <Spinner center label={loadingLabel} /> : null}
      {!error && !loading && isEmpty ? (
        <Empty title={emptyTitle} description={emptyDescription} action={emptyAction} />
      ) : null}
      {!isEmpty ? children : null}
    </>
  );
}
