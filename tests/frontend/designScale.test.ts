/**
 * 设计尺度契约。
 *
 * 「统一风格」最容易在后续改动里悄悄退化：某个新按钮又写死 `height: 38px`，
 * 或者某段文字又混一个近白的 #f1f1f6。这里把几条硬约定钉住：
 *
 * - 控件高度只有三档：`--h-chip`（28，chip/小标签）、`--h-control`（34，按钮/输入/下拉）、
 *   `--h-cta`（40，主行动按钮）。想加高度先加 token，不要在规则里写数字。
 * - 字号只用 `base.css` 的 `--fs-*`；页头标题 = `--fs-h1`，设置章节标题 = `--fs-h2`。
 * - 封面信息条/画面上信息条统一用 `--scrim` 压暗，不再逐处调 rgba。
 * - 「上次看到」只是格子右上角绿点，不再往格子里塞第二行字。
 * - 简介按信息列的可用宽度限读（em，汉字宽度），不用 ch —— ch 量的是西文「0」，
 *   中文字体下会把简介压成三十多字一行的窄条；收起用行数裁切，展开不再内嵌滚动。
 *
 * 读的是模块拼接后的级联文本（`readCss()`），与产物规则序一致。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

const root = resolve(__dirname, "../..");
const css = readCss();
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

/** 取出某个选择器（含一个花括号块）的声明体，找不到就失败。
 *  按「行首选择器」匹配，避免命中 `.live-chip .chip` 这类复合选择器的尾部。 */
function block(selector: string): string {
  const index = css.indexOf(`\n${selector} {`);
  expect(index, `缺少选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", index);
  return css.slice(index, end);
}

describe("design scale contract", () => {
  it("defines the three control heights as tokens", () => {
    expect(block(":root")).toContain("--fs-h1: 21px");
    expect(css).toContain("--h-chip: 28px");
    expect(css).toContain("--h-control: 34px");
    expect(css).toContain("--h-cta: 40px");
    expect(css).toContain("--scrim: rgba(8, 10, 15, 0.76)");
  });

  it("lets the synopsis use the info column and clamps by lines", () => {
    const intro = block(".detail-content");
    expect(intro).toContain("max-width: min(100%, 72em)");
    expect(intro).not.toContain("max-height");
    expect(intro).not.toContain("var(--line-measure)");
    const clamped = block(".detail-content.is-clamped");
    expect(clamped).toContain("-webkit-line-clamp: 4");
    expect(clamped).not.toContain("max-height: 84px");
    // 展开开关紧贴正文、带文案；箭头方向由 aria-expanded 翻转。
    expect(css).toContain(".detail-content__toggle {");
    expect(css).toContain('.detail-content__toggle[aria-expanded="true"] svg');
  });

  it("keeps controls on those tokens instead of hardcoded heights", () => {
    expect(block(".btn")).toContain("min-height: var(--h-control)");
    expect(block(".input")).toContain("height: var(--h-control)");
    expect(block(".chip")).toContain("min-height: var(--h-chip)");
    expect(block(".app-select__trigger")).toContain("height: var(--h-control)");
    expect(block(".refresh-bar .app-select__trigger")).toContain("height: var(--h-control)");
    expect(block(".gh-proxy-custom .input,\n.gh-proxy-custom .btn")).toContain(
      "height: var(--h-control)",
    );
    expect(block(".live-rail__search")).toContain("height: var(--h-control)");
    expect(block(".detail-actions--inline .btn--primary")).toContain("height: var(--h-cta)");
  });

  it("keeps the horizontal chip tabs as the only intentional overflow row", () => {
    expect(block(".chip-row--tabs")).toContain("overflow-x: auto");
    expect(block(".chip-row--tabs")).toContain("mask-image");
    expect(source("src/pages/HomePage.tsx")).toContain('className="chip-row chip-row--tabs"');
  });

  it("uses the type scale for page and section headings", () => {
    expect(block(".page-title")).toContain("font-size: var(--fs-h1)");
    expect(block(".settings-block .section-title")).toContain("font-size: var(--fs-h2)");
  });

  it("marks the last-watched episode with a dot instead of a second text line", () => {
    expect(css).toContain(".episode.is-seen::after");
    expect(css).not.toContain(".episode__flag");
    expect(source("src/pages/DetailPage.tsx")).not.toContain("episode__flag");
  });

  it("keeps the cover meta readable and on the shared tokens", () => {
    // 角标/清晰度贴在封面上，用共享压暗色；信息条本身是渐变（顶部必须透明），
    // 但仍要求它把文字压到 --text / --text-soft 上，并保持 12px 字号。
    expect(block(".vod-card__badge")).toContain("var(--scrim)");
    expect(block(".vod-card__res")).toContain("var(--scrim)");
    expect(block(".vod-card__meta-line")).toContain("font-size: var(--fs-xs)");
    expect(block(".vod-card__meta-line--dim")).toContain("color: var(--text-soft)");
  });

  it("keeps the settings nav consistent with the sidebar active state", () => {
    const nav = block(".settings-nav__item.is-active");
    expect(nav).toContain("var(--accent-softer)");
    expect(nav).toContain("inset 2px 0 0 var(--accent)");
  });
});
