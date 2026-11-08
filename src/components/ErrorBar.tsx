interface ErrorBarProps {
  message: string;
  onRetry?: () => void;
}

/** 内联错误提示：中文文案 + 可选重试。 */
export default function ErrorBar({ message, onRetry }: ErrorBarProps) {
  return (
    <div className="error-bar" role="alert">
      <span className="error-bar__text">{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          重试
        </button>
      ) : null}
    </div>
  );
}
