/**
 * 样式模块的级联顺序契约。
 *
 * 样式拆成 `src/styles/` 多个模块后，**顺序本身就是语义**：`index.css` 的
 * `@import` 行序 = 打包产物里的规则序，后面的模块可以覆盖前面的规则。所以：
 * 入口只能有 `@import`（不能夹带规则），`polish.css`（简约设计语言 v2 的覆盖层）
 * 必须留在最后。这两点一旦被改，样式会在不同页面以奇怪的方式互相覆盖。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss, styleModules } from "./readCss";

const root = resolve(__dirname, "../..");
const indexCss = readFileSync(resolve(root, "src/styles/index.css"), "utf8");

describe("style module cascade", () => {
  it("keeps the entry file free of rules", () => {
    const withoutComments = indexCss.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const line of withoutComments.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      expect(trimmed.startsWith("@import")).toBe(true);
    }
    expect(withoutComments).not.toContain("{");
  });

  it("keeps polish.css last because it overrides earlier modules", () => {
    const modules = styleModules();
    expect(modules[0]).toBe("base.css");
    expect(modules.at(-1)).toBe("polish.css");
    expect(modules).toContain("player.css");
  });

  it("reads modules back in the cascade order", () => {
    const css = readCss();
    expect(css).toContain("--cover-w-grid-min");
    expect(css).toContain("[data-sonner-toast].notice-toast.notice-toast::after");
    // 拼接顺序 = 模块顺序：第一块 token 必须早于最后一块的覆盖规则。
    expect(css.indexOf("--cover-w-grid-min")).toBeLessThan(css.indexOf(".sidebar__dev"));
  });
});
