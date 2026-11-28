import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 「点播放却回到首页」这条用户反馈的契约。
 *
 * 根因不是导航写错，而是兜底把「地址匹配不上」吞成了「回首页」：收藏 / 历史行
 * 只要缺 siteKey 或 vodId，拼出的 `#/detail//123` 就命中 `*`，而 `*` 原本是
 * `<Redirect to="/" replace />`——用户看到的是跳首页，日志里没有任何痕迹。
 *
 * 两处都钉住：入口挡住残缺数据；真的漏到路由层时给可见页面并记日志。
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) => readFileSync(resolve(here, "../../src", path), "utf8");

describe("unknown route is visible instead of a silent jump home", () => {
  const routes = source("routes.tsx");

  it("renders an explanatory page for unmatched paths", () => {
    expect(routes).toContain('{ path: "*", element: <UnknownRoute /> }');
    expect(routes).toContain("这个页面不存在");
    // 静默重定向是这条反馈的来源，不能再回来。
    expect(routes).not.toContain("element: <Redirect");
  });

  it("a player URL without state falls back to that film's detail page, not home", () => {
    // 刷新 / WebView 恢复会丢掉导航 state，会话又只存在内存里；原来这里直接
    // nav("/")，表现就是「点了播放，回到首页」。现在回到同一部片的详情页。
    expect(routes).toContain("/detail/${encodeURIComponent(siteKey)}/${encodeURIComponent(vodId)}");
    expect(routes).not.toContain('nav("/", { replace: true })');
  });

  it("logs the path that failed to match, so it is diagnosable", () => {
    expect(routes).toContain('log.warn("unknown route"');
    expect(routes).toContain("hash: window.location.hash");
  });
});

describe("favorites / history refuse to navigate with half a route", () => {
  for (const [page, label] of [
    ["pages/FavoritesPage.tsx", "收藏"],
    ["pages/HistoryPage.tsx", "记录"],
  ] as const) {
    it(`${page} guards empty siteKey / vodId`, () => {
      const text = source(page);
      expect(text).toContain("if (!target.siteKey || !target.vodId)");
      expect(text).toContain(`缺少片源信息，无法打开`);
      // 守卫必须在 navigate 之前：先挡住，不把残缺数据交给路由。
      const guardAt = text.indexOf("if (!target.siteKey || !target.vodId)");
      const navigateAt = text.indexOf("navigate(target)", guardAt);
      expect(guardAt).toBeGreaterThan(-1);
      expect(navigateAt).toBeGreaterThan(guardAt);
      expect(label.length).toBeGreaterThan(0);
    });
  }
});
