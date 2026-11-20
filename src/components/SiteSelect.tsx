import Icon from "./Icon";
import AppSelect, { type AppSelectOption } from "./AppSelect";
import { favoriteFirst, useFavoriteSites } from "../lib/siteFavorites";
import type { Site } from "../types/luma";

/**
 * 「全部站点」聚合项的取值。搜索页用它做聚合检索，首页不提供。
 * 单一来源：调用方从这里 import，不再各自写 `__all__` 字面量。
 */
export const ALL_SITES = "__all__";

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
 * 站点选择：`AppSelect` 的领域适配层。
 *
 * 只负责「站点」这件事特有的语义，渲染与交互一律交给通用下拉：
 * - 「全部站点」聚合项（allowAll）；
 * - 收藏源置顶（favoriteFirst 是稳定排序，同组内保持配置原顺序）；
 * - jvm 源标「jar 源」、禁用/屏蔽源置灰并给出原因。
 *
 * DOM 契约（含探针依赖的 `data-value` 定位）统一写在 `AppSelect`，这里直接复用
 * 同一套类名、不自定义别名，见 docs/TESTING.md §6。
 */
export default function SiteSelect({
  sites,
  value,
  onChange,
  allowAll = true,
  disabledKeys,
  disabledHints,
}: SiteSelectProps) {
  const favorites = useFavoriteSites();
  const ordered = favoriteFirst(sites, (site) => site.key);
  const current = sites.find((item) => item.key === value);
  const triggerLabel =
    value === ALL_SITES ? "全部站点" : current?.name ?? "选择站点";

  const options: AppSelectOption[] = [
    ...(allowAll
      ? [
          {
            value: ALL_SITES,
            label: "全部站点",
            icon: <Icon name="globe" />,
          },
        ]
      : []),
    ...ordered.map((site) => {
      const blocked = disabledKeys?.has(site.key) ?? false;
      return {
        value: site.key,
        label: site.name,
        disabled: blocked,
        disabledHint: disabledHints?.get(site.key) ?? "不可选",
        tag: blocked ? undefined : site.runtime === "jvm" ? "jar 源" : undefined,
        note: favorites.includes(site.key) ? "★" : undefined,
      };
    }),
  ];

  return (
    <AppSelect
      options={options}
      value={value}
      onChange={onChange}
      ariaLabel={triggerLabel}
      triggerTitle={triggerLabel}
      triggerIcon={<Icon name="globe" />}
      // 语义修饰符：一个页面可能同时存在多个下拉（首页站点 + 常驻直播层的频道组），
      // 调用方要能指认「这是站点选择」。只加一个修饰类，不再另起一套 BEM 命名。
      className="app-select--site"
      // 菜单是 Portal 到 body 的，根类覆盖不到；用常量无障碍名定位弹层。
      // 原先这里就是写死的「选择站点」，不能跟着选中项漂移。
      menuAriaLabel="选择站点"
      // value 不在 options 里时（例如首页偏好残留了 `__all__`）仍按站点语义回显，
      // 不用通用组件的「请选择」占位——那是表单场景的文案，不是这里的。
      placeholder={triggerLabel}
    />
  );
}
