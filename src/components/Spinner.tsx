interface SpinnerProps {
  label?: string;
  /** 页面级加载：垂直水平居中、环形更大、文案更清晰（首页 / 搜索 / 收藏 / 历史）。 */
  center?: boolean;
}

/** 加载指示，所有异步请求期间展示。 */
export default function Spinner({ label = "加载中…", center = false }: SpinnerProps) {
  return (
    <div
      className={center ? "spinner spinner--center" : "spinner"}
      role="status"
      aria-live="polite"
    >
      <span className="spinner__ring" aria-hidden="true" />
      <span className="spinner__label">{label}</span>
    </div>
  );
}
