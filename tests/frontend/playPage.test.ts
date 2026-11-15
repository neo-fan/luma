/**
 * `/player` 续播页的源码契约（需求 2026-11-15：「播放路由始终展示吧，取最新历史，
 * 空态美化也做一下」）。
 *
 * 这里只锁三件容易在重构里丢掉的事：
 * 1. 侧栏「播放」不再按会话过滤，没有会话时指向 `/player`；
 * 2. `/player` 有独立路由且排在 `/player/:siteKey/:vodId` 之前；
 * 3. 续播页有美化过的空态（图标 + 两个去处），并且真的用最新一条历史。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("/player resume page", () => {
  it("keeps the sidebar entry no matter what", () => {
    const shell = read("src/AppShell.tsx");
    expect(shell).toContain("const navItems = NAV_ITEMS;");
    expect(shell).toContain('pathname: "/player"');
    expect(shell).not.toContain('item.key !== "player"');
  });

  it("routes /player before the parameterised player route", () => {
    const routes = read("src/routes.tsx");
    const index = routes.indexOf('{ path: "player", element: <PlayPageRoute /> }');
    const paramIndex = routes.indexOf('path: "player/:siteKey/:vodId"');
    expect(index).toBeGreaterThan(-1);
    expect(paramIndex).toBeGreaterThan(-1);
    expect(index).toBeLessThan(paramIndex);
  });

  it("resumes from the latest history and degrades to detail without playUrl", () => {
    const page = read("src/pages/PlayPage.tsx");
    expect(page).toContain("api.historyList()");
    expect(page).toContain("historyCoverMeta");
    expect(page).toContain("function canResume(");
    expect(page).toContain('name: "player"');
  });

  it("ships a styled empty state instead of bouncing home", () => {
    const page = read("src/pages/PlayPage.tsx");
    expect(page).toContain('emptyTitle="还没有播放记录"');
    expect(page).toContain("emptyIcon={PlayCircle}");
    expect(page).toContain("去逛逛");
    expect(page).toContain("搜索影片");
    expect(page).toContain("<AsyncBoundary");
    const css = readCss();
    expect(css).toContain(".resume-hero {");
    expect(css).toContain(".resume-live {");
    expect(css).toContain(".resume-section {");
  });
});
