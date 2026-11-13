import * as Select from "@radix-ui/react-select";
import Icon from "./Icon";

export interface AppSelectOption {
  /** 选项值（字符串；数字调用方自行 String()）。 */
  value: string;
  /** 菜单与触发器上的文案。 */
  label: string;
  /** 不可选：菜单里置灰、不可点。 */
  disabled?: boolean;
  /** 不可选原因（触发器旁的置灰小标签，如「无列表」）。 */
  disabledHint?: string;
  /** 可选项的附加小标签（如「jar 源」）。 */
  tag?: string;
}

interface AppSelectProps {
  options: AppSelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** 无障碍名（触发器 aria-label/title）。 */
  ariaLabel: string;
  /** value 不在 options 里时的触发器占位文案。 */
  placeholder?: string;
  /** 触发器悬浮提示（可选）。 */
  triggerTitle?: string;
  /** 整控禁用（如保存中）：触发器置灰、菜单打不开。 */
  disabled?: boolean;
}

/**
 * 通用下拉：与 SiteSelect 同一套 Radix + 视觉（搜索页下拉风格）。
 *
 * 定位/碰撞翻转、焦点管理、键盘导航、Esc/点外关闭全部交给 Radix popper。
 * 触发器宽度随内容自适应、max-width 封顶（超长文案省略号）；菜单项
 * 选中高亮（.is-active）、禁用置灰。
 */
export default function AppSelect({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder = "请选择",
  triggerTitle,
  disabled,
}: AppSelectProps) {
  const current = options.find((item) => item.value === value);
  const triggerLabel = current?.label ?? placeholder;

  return (
    <div className="app-select" data-value={value}>
      <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
        <Select.Trigger
          asChild
          aria-label={ariaLabel}
          title={triggerTitle ?? triggerLabel}
        >
          <button type="button" className="app-select__trigger">
            <span className="app-select__label">{triggerLabel}</span>
            <Icon name="chevron" />
          </button>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="app-select__menu"
            role="listbox"
            aria-label={ariaLabel}
            position="popper"
            sideOffset={8}
            collisionPadding={8}
          >
            <Select.Viewport>
              {options.map((item) => (
                <Select.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled}
                  aria-disabled={item.disabled || undefined}
                  title={item.label}
                  className={
                    (item.value === value
                      ? "app-select__item is-active"
                      : "app-select__item") +
                    (item.disabled ? " is-disabled" : "")
                  }
                >
                  <Select.ItemText asChild>
                    <span className="app-select__name">{item.label}</span>
                  </Select.ItemText>
                  {item.disabled ? (
                    <small className="app-select__tag">
                      {item.disabledHint ?? "不可选"}
                    </small>
                  ) : item.tag ? (
                    <small className="app-select__tag">{item.tag}</small>
                  ) : null}
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
