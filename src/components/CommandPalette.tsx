import { useEffect, useState } from "react";
import { Command } from "cmdk";
import type { Site } from "../types/tvbox";
import type { Navigate } from "../lib/nav";
import Icon from "./Icon";
import NavIcon from "./NavIcon";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  navigate: Navigate;
  /** 首页站点切换候选；已屏蔽的 jvm 源与禁用站不进面板。 */
  sites: Site[];
  /** 当前首页选中站点（空串 = 默认站）。 */
  homeSite: string;
  onPickHomeSite: (siteKey: string) => void;
}

const NAV_ITEMS: { key: "home" | "live" | "search" | "favorites" | "history" | "settings"; label: string }[] = [
  { key: "home", label: "首页" },
  { key: "live", label: "直播" },
  { key: "search", label: "搜索" },
  { key: "favorites", label: "收藏" },
  { key: "history", label: "历史" },
  { key: "settings", label: "设置" },
];

/** 站点类型标注：只在能一眼看出差别的地方给，cms 占绝大多数就不写了。 */
function runtimeLabel(site: Site): string | null {
  if (!site.runtime || site.runtime === "cms") {
    return null;
  }
  if (site.runtime === "python") {
    return "PY";
  }
  if (site.runtime === "quickjs") {
    return "JS";
  }
  return site.runtime.toUpperCase();
}

/**
 * 全局命令面板（Ctrl / Cmd + K）。
 *
 * cmdk 的 Dialog 自带 Radix Dialog 容器：焦点陷阱、Esc、点遮罩关闭、
 * aria 都是现成的；过滤输入直接用 cmdk 内置的 fuzzy 匹配。站点切换把
 * 「101 个站点的原生下拉」补成纯键盘可达的第三入口（下拉、命令面板、
 * 首页 SiteSelect 各走各的场景，互不替代）。
 */
export default function CommandPalette({
  open,
  onOpenChange,
  navigate,
  sites,
  homeSite,
  onPickHomeSite,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");

  // 每次打开都从空词开始：上一次的过滤词不应残留到下一次意图。
  useEffect(() => {
    if (open) {
      setQuery("");
    }
  }, [open]);

  // 面板关闭后焦点要回到触发元素上——Radix 自动处理「打开时聚焦输入框」，
  // 这里只负责把 Ctrl/Cmd+K 变成全局开关。探针照旧用 DOM 查询，不受影响。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange]);

  const run = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };

  const pickable = sites.filter((site) => site.enabled && site.runtime !== "jvm");
  const keyword = query.trim();

  return (
    <Command.Dialog open={open} onOpenChange={onOpenChange} label="全局命令面板" loop>
      <div className="palette__bar">
        <Icon name="search" size={15} />
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="搜索影片、跳转页面、切换站点…"
          aria-label="命令面板输入"
        />
        <kbd className="palette__esc">esc</kbd>
      </div>

      <Command.List>
        <Command.Empty>
          <span className="palette__empty">
            <Icon name="search" size={16} />
            <span>没有匹配的结果</span>
            <small>换个关键词，或直接回车全站搜索</small>
          </span>
        </Command.Empty>

        {keyword ? (
          <Command.Group heading={<span className="palette__heading">搜索</span>}>
            <Command.Item
              value={`搜索影片 ${keyword}`}
              onSelect={run(() => navigate({ name: "search", keyword }))}
            >
              <Icon name="search" size={15} />
              <span className="palette__label">
                全站搜索「<strong>{keyword}</strong>」
              </span>
              <span className="palette__hint">
                <kbd>↵</kbd>
              </span>
            </Command.Item>
          </Command.Group>
        ) : null}

        <Command.Group
          heading={
            <span className="palette__heading">
              页面
              <span className="palette__count">{NAV_ITEMS.length}</span>
            </span>
          }
        >
          {NAV_ITEMS.map((item) => (
            <Command.Item
              key={item.key}
              value={`导航 ${item.label}`}
              onSelect={run(() => navigate({ name: item.key }))}
            >
              <NavIcon name={item.key} />
              <span className="palette__label">{item.label}</span>
              <span className="palette__hint">打开</span>
            </Command.Item>
          ))}
        </Command.Group>

        {pickable.length > 0 ? (
          <Command.Group
            heading={
              <span className="palette__heading">
                切换首页站点
                <span className="palette__count">{pickable.length}</span>
              </span>
            }
          >
            {pickable.map((site) => {
              const runtime = runtimeLabel(site);
              return (
                <Command.Item
                  key={site.key}
                  value={`站点 ${site.name} ${site.key}`}
                  keywords={[site.name, site.key]}
                  onSelect={run(() => onPickHomeSite(site.key))}
                >
                  <span className="palette__site-mark" aria-hidden="true">
                    {site.name.slice(0, 1)}
                  </span>
                  <span className="palette__label">{site.name}</span>
                  {runtime ? <span className="palette__badge">{runtime}</span> : null}
                  {site.key === homeSite ? (
                    <span className="cmdk-current">当前</span>
                  ) : null}
                  <span className="palette__hint">切换</span>
                </Command.Item>
              );
            })}
          </Command.Group>
        ) : null}
      </Command.List>

      <div className="palette__foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> 选择
        </span>
        <span>
          <kbd>↵</kbd> 打开
        </span>
        <span>
          <kbd>ctrl</kbd>
          <kbd>k</kbd> 关闭
        </span>
      </div>
    </Command.Dialog>
  );
}
