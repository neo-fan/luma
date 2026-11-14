interface NoticeLifeProps {
  /** 剩余秒数；<=0（常驻提示）不渲染。 */
  left: number;
  /** 剩余比例 0~1。 */
  progress: number;
}

/**
 * 提示的「生命线」：右下角剩余秒数 + 底部进度线。
 *
 * 抽成组件而不是写死在 ErrorBar 里，是因为它同时被页内横幅（ErrorBar）和全局
 * toast（sonner）使用——两处的倒计时外观必须一模一样，否则「同一个系统里的
 * 提示」会呈现出两种气质。配色/粗细/动效只在 `.notice-*` 里定义一次。
 *
 * 全部 `aria-hidden`：读屏用户不需要知道「还有 6 秒消失」，`role=alert` 的
 * 文案已经念过了。
 */
export default function NoticeLife({ left, progress }: NoticeLifeProps) {
  if (left <= 0) {
    return null;
  }
  return (
    <>
      <span className="notice-countdown" aria-hidden="true">
        {left}s
      </span>
      <span
        className="notice-life"
        aria-hidden="true"
        style={{ width: `${Math.min(Math.max(progress, 0), 1) * 100}%` }}
      />
    </>
  );
}
