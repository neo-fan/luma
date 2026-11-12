/**
 * 图标按钮：UI 里所有「一看就懂」的操作都走这里，不再用文字按钮。
 *
 * 状态全在图标本身：`pressed` 打开 `aria-pressed` + `.is-on`（颜色提亮、
 * 需要时整枚图标翻转），`busy` 让图标转起来（刷新/重试），`disabled` 只降
 * 透明度。语义靠 `label` 落到 aria-label 与悬浮提示，视觉上不占地方。
 *
 * 提示条是 CSS 伪元素（`data-tip`），不用原生 title：原生气泡要悬停一秒
 * 才出现、样式跟随系统，和这套深色界面不搭。靠近容器边缘时传 `tip="none"`
 * 退回 title，避免被 `overflow:hidden` 裁掉（播放器舞台就是这种容器）。
 */
import type { ButtonHTMLAttributes } from "react";
import Icon, { type IconName } from "./Icon";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  name: IconName;
  /** 唯一语义来源：aria-label / 悬浮提示 / 探针定位都用它。 */
  label: string;
  /** 开关型按钮的当前状态（倒序、展开…）。 */
  pressed?: boolean;
  /** 展开型按钮用 aria-expanded 而不是 aria-pressed。 */
  expanded?: boolean;
  /** 进行中：图标自转，用于刷新/重试。 */
  busy?: boolean;
  tone?: "plain" | "danger";
  size?: "sm" | "md";
  /** 提示条方向；`none` 表示不画伪元素气泡，退回原生 title。 */
  tip?: "down" | "up" | "none";
}

export default function IconButton({
  name,
  label,
  pressed,
  expanded,
  busy = false,
  tone = "plain",
  size = "md",
  tip = "down",
  className = "",
  ...rest
}: IconButtonProps) {
  const classes = [
    "icon-btn",
    `icon-btn--${size}`,
    tone === "danger" ? "icon-btn--danger" : "",
    pressed ? "is-on" : "",
    busy ? "is-busy" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      aria-expanded={expanded}
      data-tip={tip === "none" ? undefined : label}
      data-tip-pos={tip === "up" ? "up" : undefined}
      title={tip === "none" ? label : undefined}
      {...rest}
    >
      <Icon name={name} />
    </button>
  );
}
