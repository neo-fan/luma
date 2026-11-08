interface SpinnerProps {
  label?: string;
}

/** 加载指示，所有异步请求期间展示。 */
export default function Spinner({ label = "加载中…" }: SpinnerProps) {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner__ring" aria-hidden="true" />
      <span className="spinner__label">{label}</span>
    </div>
  );
}
