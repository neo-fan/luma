import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
 * 站点选择：图标触发器 + 可点选下拉菜单，替代原生 `<select>`。
 *
 * 原生 select 是操作系统控件，样式与软件设计语言脱节，且选项里塞不下
 * 图标与标记。语义由 aria（haspopup/listbox/option）承担；点击菜单外
 * 区域 / Esc 关闭。
 *
 * DOM 契约（探针依赖，勿改）：
 * - 根节点 `.site-select` 带 `data-value={value}`
 * - 菜单项 `.site-select__item` 带 `data-key={site.key}`
 */
export default function SiteSelect({
  sites,
  value,
  onChange,
  allowAll = true,
  disabledKeys,
  disabledHints,
}: SiteSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 菜单打开后量测一次，clamp 到视口内：触发器贴窗口左缘时菜单不能伸出
  // 屏幕外（行首文字被裁），贴右缘时同理。CSS 默认左对齐，这里做边界兜底。
  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    const menu = menuRef.current;
    const host = ref.current;
    if (!menu || !host) {
      return;
    }
    menu.style.left = "0px";
    menu.style.right = "auto";
    const rect = menu.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    let viewportLeft = hostRect.left;
    const overRight = viewportLeft + rect.width - (window.innerWidth - 8);
    if (overRight > 0) {
      viewportLeft -= overRight;
    }
    if (viewportLeft < 8) {
      viewportLeft = 8;
    }
    menu.style.left = `${viewportLeft - hostRect.left}px`;
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDocPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isAll = value === ALL_SITES;
  const current = isAll ? null : sites.find((item) => item.key === value);
  const triggerLabel = isAll ? "全部站点" : current?.name ?? "选择站点";

  const pick = (key: string) => {
    onChange(key);
    setOpen(false);
  };

  return (
    <div className="site-select" ref={ref} data-value={value}>
      <button
        type="button"
        className={open ? "site-select__trigger is-on" : "site-select__trigger"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <Icon name="globe" />
        <span className="site-select__label">{triggerLabel}</span>
        <Icon name="chevron" />
      </button>
      {open ? (
        <div
          className="site-select__menu"
          ref={menuRef}
          role="listbox"
          aria-label="选择站点"
        >
          {allowAll ? (
            <button
              type="button"
              role="option"
              aria-selected={isAll}
              className={isAll ? "site-select__item is-active" : "site-select__item"}
              onClick={() => pick(ALL_SITES)}
            >
              <Icon name="globe" />
              <span className="site-select__name">全部站点</span>
            </button>
          ) : null}
          {sites.map((site) => {
            const blocked = disabledKeys?.has(site.key) ?? false;
            return (
              <button
                type="button"
                role="option"
                aria-selected={site.key === value}
                aria-disabled={blocked || undefined}
                key={site.key}
                data-key={site.key}
                className={
                  (site.key === value ? "site-select__item is-active" : "site-select__item") +
                  (blocked ? " is-disabled" : "")
                }
                title={site.name}
                onClick={() => {
                  if (!blocked) pick(site.key);
                }}
              >
                <span className="site-select__name">{site.name}</span>
                {blocked ? (
                  <small className="site-select__tag">
                    {disabledHints?.get(site.key) ?? "不可选"}
                  </small>
                ) : site.runtime === "jvm" ? (
                  <small className="site-select__tag">jar 源</small>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
