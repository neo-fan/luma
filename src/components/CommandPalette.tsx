import { useEffect, useState } from "react";
import { Command } from "cmdk";
import type { Site } from "../types/tvbox";
import type { Navigate } from "../lib/nav";

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

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="全局命令面板"
      loop
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="搜索影片、跳转页面、切换站点…"
        aria-label="命令面板输入"
      />
      <Command.List>
        <Command.Empty>没有匹配的命令</Command.Empty>

        {query.trim() ? (
          <Command.Group heading="搜索">
            <Command.Item
              value={`搜索影片 ${query.trim()}`}
              onSelect={run(() => navigate({ name: "search", keyword: query.trim() }))}
            >
              全站搜索「{query.trim()}」
            </Command.Item>
          </Command.Group>
        ) : null}

        <Command.Group heading="页面">
          {NAV_ITEMS.map((item) => (
            <Command.Item
              key={item.key}
              value={`导航 ${item.label}`}
              onSelect={run(() => navigate({ name: item.key }))}
            >
              打开{item.label}
            </Command.Item>
          ))}
        </Command.Group>

        {pickable.length > 0 ? (
          <Command.Group heading="切换首页站点">
            {pickable.map((site) => (
              <Command.Item
                key={site.key}
                value={`站点 ${site.name} ${site.key}`}
                keywords={[site.name, site.key]}
                onSelect={run(() => onPickHomeSite(site.key))}
              >
                {site.name}
                {site.key === homeSite ? <span className="cmdk-current">当前</span> : null}
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}
