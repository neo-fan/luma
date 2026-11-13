import * as Select from "@radix-ui/react-select";
import Icon from "./Icon";
import type { Site } from "../types/tvbox";

const ALL_SITES = "__all__";

interface SiteSelectProps {
  /** 站点列表（含禁用/屏蔽项——它们由 disabledKeys 标灰）。 */
  sites: Site[];
  /** 当前选中 key。 */
  value: string;
  onChange: (value: string) => void;
  /** 是否提供「全部站点」聚合项（搜索页 true，首页 false）。 */
  allowAll?: boolean;
  /** 不可选的站点 key：菜单里置灰、不可点（屏蔽的 jvm 源 / 已禁用源）。 */
  disabledKeys?: ReadonlySet<string>;
  /** 不可选原因，逐站可不同（如「已屏蔽」「已禁用」）；缺省「不可选」。 */
  disabledHints?: ReadonlyMap<string, string>;
}

/**
 * 站点选择：基于 @radix-ui/react-select 的下拉。
 *
 * 定位/碰撞翻转（贴窗口边缘不被裁）、焦点管理、键盘导航（↑↓/Home/End/
 * 首字母 typeahead）、Esc/点外关闭全部交给 Radix，不再手写量测 clamp。
 *
 * DOM 契约（探针依赖，勿改）：
 * - 根节点 `.site-select` 带 `data-value={value}`
 * - 菜单项 `.site-select__item` 带 `data-key={site.key}`；
 *   屏蔽项 `aria-disabled="true"` + `.is-disabled`
 * - 程序化 `.click()` 可开菜单与选中（Radix pointerTypeRef 初值 "touch"，
 *   无 pointerdown 的 click 会走 onClick → handleOpen；Item 有 onClick 选中）
 */
export default function SiteSelect({
  sites,
  value,
  onChange,
  allowAll = true,
  disabledKeys,
  disabledHints,
}: SiteSelectProps) {
  const isAll = value === ALL_SITES;
  const current = isAll ? null : sites.find((item) => item.key === value);
  const triggerLabel = isAll ? "全部站点" : current?.name ?? "选择站点";

  return (
    <div className="site-select" data-value={value}>
      <Select.Root value={value} onValueChange={onChange}>
        <Select.Trigger asChild aria-label={triggerLabel} title={triggerLabel}>
          <button type="button" className="site-select__trigger">
            <Icon name="globe" />
            <span className="site-select__label">{triggerLabel}</span>
            <Icon name="chevron" />
          </button>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            className="site-select__menu"
            role="listbox"
            aria-label="选择站点"
            position="popper"
            sideOffset={8}
            collisionPadding={8}
          >
            <Select.Viewport>
              {allowAll ? (
                <Select.Item
                  value={ALL_SITES}
                  className={
                    isAll ? "site-select__item is-active" : "site-select__item"
                  }
                >
                  <Icon name="globe" />
                  <Select.ItemText asChild>
                    <span className="site-select__name">全部站点</span>
                  </Select.ItemText>
                </Select.Item>
              ) : null}
              {sites.map((site) => {
                const blocked = disabledKeys?.has(site.key) ?? false;
                return (
                  <Select.Item
                    key={site.key}
                    value={site.key}
                    data-key={site.key}
                    disabled={blocked}
                    aria-disabled={blocked || undefined}
                    title={site.name}
                    className={
                      (site.key === value
                        ? "site-select__item is-active"
                        : "site-select__item") + (blocked ? " is-disabled" : "")
                    }
                  >
                    <Select.ItemText asChild>
                      <span className="site-select__name">{site.name}</span>
                    </Select.ItemText>
                    {blocked ? (
                      <small className="site-select__tag">
                        {disabledHints?.get(site.key) ?? "不可选"}
                      </small>
                    ) : site.runtime === "jvm" ? (
                      <small className="site-select__tag">jar 源</small>
                    ) : null}
                  </Select.Item>
                );
              })}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </div>
  );
}
