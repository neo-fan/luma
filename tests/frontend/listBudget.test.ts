/**
 * 长列表预算的源码契约：单测覆盖纯函数，这里钉住页面确实接了上限，
 * 防止后续改动只在 helper 里留着容量，页面又把全量结果塞回 renderer。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("renderer list budgets are wired into pages", () => {
  it("caps search hits through a single commit path", () => {
    const page = read("src/pages/SearchPage.tsx");
    expect(page).toContain("const MAX_SEARCH_HITS = 1200;");
    expect(page).toContain("const commitHits = useCallback(");
    expect(page).toContain("capItems(ranked, MAX_SEARCH_HITS)");
    // 三条写入路径都必须走 commitHits，不能绕过截断。
    expect(page).not.toContain("setHits(ranked)");
    expect(page).not.toContain("setHits(deduped)");
    expect(page).toContain("仅显示前");
  });

  it("bounds category pages and keeps a small site-snapshot LRU", () => {
    const page = read("src/pages/HomePage.tsx");
    expect(page).toContain("const MAX_CAT_PAGES = 20;");
    expect(page).toContain("const MAX_CAT_ITEMS = 1200;");
    expect(page).toContain("const MAX_HOME_SNAPSHOTS = 6;");
    expect(page).toContain('"home:data:v3"');
    expect(page).toContain("clampLoadedPages(");
    expect(page).toContain("putLru(");
    expect(page).toContain("dropLru(");
  });
});
