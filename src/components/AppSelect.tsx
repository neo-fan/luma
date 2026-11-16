import * as Select from "@radix-ui/react-select";
import Icon from "./Icon";
import type { ReactNode } from "react";

export interface AppSelectOption {
  /**
   * 选项值，同时落到菜单项的 `data-value` 上（见下方 DOM 契约）。
   * 数字调用方自行 String()。
   */
  value: string;
  /** 菜单与触发器上的文案。 */
  label: string;
  /** 不可选：菜单里置灰、不可点。 */
  disabled?: boolean;
  /** 不可选原因（触发器旁的置灰小标签，如「无列表」）。 */
  disabledHint?: string;
  /** 可选项的附加小标签（如「jar 源」）。 */
  tag?: string;
  /** 文案前置图标（如「全部站点」的地球）。 */
  icon?: ReactNode;
  /** 文案后置内容（如收藏 ★）。与 tag 互不冲突：note 紧跟文案，tag 靠右。 */
  note?: ReactNode;
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
  /** 触发器文案前的图标（如站点选择的地球）。 */
  triggerIcon?: ReactNode;
  /**
   * 追加在根节点上的语义类名，供调用方做局部排版微调与定位（不用于状态样式）。
   *
   * 注意它只覆盖到根：菜单是 Radix Portal 到 body 的，不在根节点子树内。
   * 定位弹层请用 `role="listbox"` + `menuAriaLabel`（见下）。
   */
  className?: string;
  /**
   * 菜单的无障碍名。默认取 `ariaLabel`（= 当前项文案，会随选择变化）。
   * 需要让弹层可被稳定定位的调用方应显式给一个**常量**（如「选择站点」）——
   * 否则名字随选中项漂移，测试网与读屏软件都无法稳定指认这个列表。
   */
  menuAriaLabel?: string;
}

/**
 * 通用下拉：定位/碰撞翻转、焦点管理、键盘导航（↑↓/Home/End/首字母 typeahead）、
 * Esc 与点外关闭全部交给 Radix popper，不自己量测。触发器宽度随内容自适应、
 * max-width 封顶（超长省略号）；菜单项选中高亮 `.is-active`、禁用置灰 `.is-disabled`。
 *
 * ---------------------------------------------------------------------------
 * DOM 契约（探针依赖，改这里必须同步 docs/TESTING.md §6 与探针）
 *
 * 契约只写在这一处，各调用方不再自定命名——历史上 SiteSelect 为了迁就探针另起了
 * 一套 `.site-select*` 双类名，结果多养了一个 105 行的平行组件和一套只为契约存在
 * 的类名。通用组件补齐能力（`data-value`、图标、后置内容）之后，那条路已经不需要。
 *
 * - 根节点      `.app-select[data-value="<当前值>"]`
 * - 触发器      `.app-select__trigger`，`aria-label` = 当前项文案
 * - 菜单        `.app-select__menu`，`role="listbox"`
 * - 选项        `.app-select__item[data-value="<选项值>"]`
 *               选中 `.is-active`；不可选 `.is-disabled` + `aria-disabled="true"`
 * - 可程序化操作：`.click()` 能开菜单、能选中（Radix 的 pointerTypeRef 初值是
 *   "touch"，没有 pointerdown 的 click 会正常走 onClick → handleOpen）。
 *
 * 需要按身份定位的**非选项**列表行（如站点体检结果行）另用语义主键属性
 * （`data-site-key`），同样登记在契约文档里。
 */
export default function AppSelect({
  options,
  value,
  onChange,
  ariaLabel,
  placeholder = "请选择",
  triggerTitle,
  disabled,
  triggerIcon,
  className,
  menuAriaLabel,
}: AppSelectProps) {
  const current = options.find((item) => item.value === value);
  const triggerLabel = current?.label ?? placeholder;

  return (
    <div className={className ? `app-select ${className}` : "app-select"} data-value={value}>
      <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
        <Select.Trigger
          asChild
          aria-label={ariaLabel}
          title={triggerTitle ?? triggerLabel}
        >
          <button type="button" className="app-select__trigger">
            {triggerIcon}
            <span className="app-select__label">{triggerLabel}</span>
            <Icon name="chevron" />
          </button>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="app-select__menu"
            role="listbox"
            aria-label={menuAriaLabel ?? ariaLabel}
            position="popper"
            sideOffset={8}
            collisionPadding={8}
          >
            <Select.Viewport>
              {options.map((item) => (
                <Select.Item
                  key={item.value}
                  value={item.value}
                  data-value={item.value}
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
                  {item.icon}
                  <Select.ItemText asChild>
                    <span className="app-select__name">{item.label}</span>
                  </Select.ItemText>
                  {item.note ? (
                    <small className="app-select__note" aria-hidden="true">
                      {item.note}
                    </small>
                  ) : null}
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
