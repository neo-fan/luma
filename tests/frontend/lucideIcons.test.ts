/**
 * 图标统一走开源图标库（Lucide）的源码契约。
 *
 * 之前三处各自手写 path：粗细/留白不一致，`settings` 甚至画成了「太阳」而不是
 * 齿轮。这类退化不会报错、探针也照样绿，只有肉眼能发现 —— 用源码不变量守住：
 * 只允许在一处定义风格参数，三个入口都必须从 lucide-react 取图。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("one open-source icon set for the whole app", () => {
  it("declares lucide-react as a runtime dependency", () => {
    expect(read("package.json")).toContain('"lucide-react"');
  });

  it("keeps a single shared geometry baseline", () => {
    const baseline = read("src/components/icons.ts");
    expect(baseline).toContain("export const ICON_STROKE_WIDTH");
    expect(baseline).toContain("export const ICON_PROPS");
    expect(baseline).toContain('"aria-hidden": true');
  });

  it("uses Lucide in nav, toolbar and favourite star; no hand-drawn paths", () => {
    for (const file of [
      "src/components/NavIcon.tsx",
      "src/components/Icon.tsx",
      "src/components/FavStar.tsx",
    ]) {
      const source = read(file);
      expect(source, file).toContain('from "lucide-react"');
      expect(source, file).toContain("{...ICON_PROPS}");
      expect(source, file).not.toContain("<path");
      expect(source, file).not.toContain("viewBox=");
    }
  });

  it("maps settings to the gear, not the old sun/asterisk", () => {
    const nav = read("src/components/NavIcon.tsx");
    expect(nav).toContain("settings: Settings");
    expect(nav).not.toContain("M12 3.2v2.3");
  });

  it("keeps every public icon name mapped", () => {
    const nav = read("src/components/NavIcon.tsx");
    for (const name of ["home", "live", "search", "favorites", "history", "settings", "collapse"]) {
      expect(nav).toContain(`${name}:`);
    }
    const icons = read("src/components/Icon.tsx");
    for (const name of [
      "back", "next", "refresh", "swap", "external", "sort", "chevron",
      "close", "trash", "copy", "check", "play", "search", "pencil",
    ]) {
      expect(icons).toContain(`${name}:`);
    }
  });

  it("filled favourite state still wins over Lucide's fill=none", () => {
    const css = readCss();
    expect(css).toContain(".fav-star.is-on svg");
    expect(css).toContain("fill: currentColor");
  });
});
