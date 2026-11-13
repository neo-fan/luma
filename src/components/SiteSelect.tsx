import { useEffect, useRef, useState } from "react";
import Icon from "./Icon";
import type { Site } from "../types/tvbox";

const ALL_SITES = "__all__";

interface SiteSelectProps {
  /** 可搜索的站点（已按 enabled 过滤）。 */
  sites: Site[];
  /** 当前选中：ALL_SITES 表示全部站点聚合搜索。 */
  value: string;
  onChange: (value: string) => void;
}

/**
 * 搜索页站点选择：globe 图标按钮 + 下拉菜单，替代原生 `<select>`。
 *
 * 原生 select 在桌面端是操作系统控件，样式与软件设计语言脱节（用户反馈
 * 「全部站点下拉风格不搭」），且选项里塞不下图标。这里用图标触发器表达
 * 「全部站点」，下拉里列出各站点供单站检索——语义仍由 aria-label 承担。
 * 点击非菜单区域 / Esc 关闭。
 */
export default function SiteSelect({ sites, value, onChange }: SiteSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <div className="site-select" ref={ref}>
      <button
        type="button"
        className={open ? "icon-btn icon-btn--md is-on" : "icon-btn icon-btn--md"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="globe" />
        {/* 选中具体站点后在地球图标右上角回显首字徽标；全部站点只显示地球。 */}
        {!isAll && current?.name ? (
          <span className="site-select__badge" aria-hidden="true">
            {current.name.charAt(0)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="site-select__menu" role="listbox" aria-label="选择搜索范围">
          <button
            type="button"
            role="option"
            aria-selected={isAll}
            className={isAll ? "site-select__item is-active" : "site-select__item"}
            onClick={() => {
              onChange(ALL_SITES);
              setOpen(false);
            }}
          >
            <Icon name="globe" />
            <span className="site-select__name">全部站点</span>
          </button>
          {sites.map((site) => (
            <button
              type="button"
              role="option"
              aria-selected={site.key === value}
              key={site.key}
              className={site.key === value ? "site-select__item is-active" : "site-select__item"}
              title={site.name}
              onClick={() => {
                onChange(site.key);
                setOpen(false);
              }}
            >
              <span className="site-select__name">{site.name}</span>
              {site.runtime === "jvm" ? (
                <small className="site-select__tag">jar 源</small>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
