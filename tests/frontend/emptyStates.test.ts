/**
 * 空态视觉的源码契约：所有「这里什么都没有」都必须落到同一个 `Empty`。
 *
 * 之前每页自己写一段占位：首页是整宽虚线框、搜索页是一行 `.search-hint`
 * 段落、收藏/历史各写各的——同一状态三种长相，虚线框还把留白放大成黑洞。
 * 这类退化不报错、单测也不渲染组件，所以用源码不变量守住：
 * 列表页一律走 `Empty`（直接渲染或经 `AsyncBoundary` 透传）并给语义图标，
 * 搜索页不得再退回手写提示段落。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { blockAfter, requireAnchor } from "./readSource";
import { readCss } from "./readCss";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

/** 页面 → 空态该用的 lucide 图标（空态图形要贴合语义，不用默认收件箱）。 */
const pages: Record<string, string> = {
  "src/pages/HomePage.tsx": "FolderOpen",
  "src/pages/LivePage.tsx": "Tv",
  "src/pages/FavoritesPage.tsx": "Star",
  "src/pages/HistoryPage.tsx": "History",
  "src/pages/SearchPage.tsx": "Search",
};

describe("empty states share one visual language", () => {
  it("routes every list page through the Empty component", () => {
    for (const [file, icon] of Object.entries(pages)) {
      const source = read(file);
      // 两种等价入口：直接 <Empty icon=...> 或 AsyncBoundary 的 emptyIcon 透传。
      expect(source, file).toMatch(/components\/(Empty|AsyncBoundary)"/);
      expect(source, file).toMatch(
        new RegExp(`(?:icon|emptyIcon)=\\{${icon}\\}`),
      );
    }
  });

  it("keeps the Empty contract to icon + title + description + action", () => {
    const source = read("src/components/Empty.tsx");
    expect(source).toContain("interface EmptyProps");
    for (const prop of ["title: string", "description?: string", "action?: ReactNode", "icon?: LucideIcon"]) {
      expect(source, "Empty.tsx").toContain(prop);
    }
    expect(source).toContain('className="empty__icon"');
    expect(source).toContain("aria-hidden");
  });

  it("forwards the empty illustration through AsyncBoundary", () => {
    const source = read("src/components/AsyncBoundary.tsx");
    expect(source).toContain("emptyIcon?: LucideIcon");
    expect(source).toContain("icon={emptyIcon}");
  });

  it("does not let the search page fall back to a hand-written hint block", () => {
    const source = read("src/pages/SearchPage.tsx");
    // 只守「统一走 Empty、不再手写提示块」；具体出现几处是布局细节。
    requireAnchor(source, "<Empty", "SearchPage Empty");
    expect(source).not.toContain("search-hint");
    expect(readCss()).not.toContain(".search-hint");
  });

  it("keeps the empty illustration as a soft badge, not a dashed box", () => {
    const css = readCss();
    const rule = blockAfter(css, ".empty {", "}", "empty rule");
    expect(rule).not.toContain("dashed");
    expect(css).toContain(".empty__icon");
  });
});
