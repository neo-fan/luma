/**
 * 首页分类切换的源码契约：只换下方网格，不 push 二级页面。
 *
 * 「不进二级页」这种交互用单测测不了 DOM，但可以用源码不变量防回归：
 * 一旦有人把 chip 的 onClick 改回 navigate({name:'category'})，或者把删掉的
 * CategoryPage 又接回来，这里立刻红。真实窗口的行为由
 * tools/probe_home_category.mjs 断言。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("home category switching is inline", () => {
  it("loads category content in place instead of navigating", () => {
    const home = read("src/pages/HomePage.tsx");
    expect(home).toContain("api.category(");
    expect(home).toContain("selectCategory");
    expect(home).toContain("isCategory");
    expect(home).not.toContain('name: "category"');
    expect(home).not.toContain("navigate({\n                    name: \"category\"");
  });

  it("exposes an active chip, a recommend chip and a pager", () => {
    const home = read("src/pages/HomePage.tsx");
    expect(home).toContain('"chip is-active"');
    expect(home).toContain('aria-pressed={activeTid === item.type_id}');
    expect(home).toContain("推荐");
    expect(home).toContain("pager__label");
    expect(home).toContain('label="上一页"');
    expect(home).toContain('label="下一页"');
  });

  it("removes the now-unreachable category route", () => {
    const app = read("src/App.tsx");
    expect(app).not.toContain("CategoryPage");
    expect(app).not.toContain('case "category"');
    expect(app).not.toContain('| { name: "category"');
    expect(existsSync(resolve(root, "src/pages/CategoryPage.tsx"))).toBe(false);
  });

  it("keeps the selection scoped to a site and forces refresh once", () => {
    const home = read("src/pages/HomePage.tsx");
    expect(home).toContain("selection.siteKey === siteKey");
    expect(home).toContain("catForceRef.current = false");
    expect(home).toContain("refreshVisible");
  });
});
