/**
 * toast 进度线的选择器契约。
 *
 * sonner 的样式是运行时用 <style> 追加进 head 的：产物里它排在打包好的
 * <link> 之后，而它自带一条 `[data-sonner-toast][data-expanded=true]::after`
 * （gap+1 高的悬停间隙桥，贴 toast 上方、整宽、无背景）与我们那条**特异性
 * 相同 (0,2,1)**。1.0.3 正式包里 sonner 的顺序在后，进度线被顶成「toast 上方
 * 11px 灰条」（dev 因为样式顺序不同看不出来，所以只能靠源码契约守）。
 *
 * 这里的断言就是那次的结论：选择器必须靠重复类名把特异性抬到 (0,3,1)。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("toast progress line", () => {
  it("outranks sonner's expanded gap bridge", () => {
    const css = readCss();
    expect(css).toContain("[data-sonner-toast].notice-toast.notice-toast::after");
    // 单类版本会被 sonner 的 (0,2,1) 规则按顺序压掉，不能留。
    expect(css).not.toContain("[data-sonner-toast].notice-toast::after");
  });

  it("keeps the line geometry pinned to the toast bottom edge", () => {
    const css = readCss();
    const start = css.indexOf("[data-sonner-toast].notice-toast.notice-toast::after");
    expect(start).toBeGreaterThan(0);
    const block = css.slice(start, start + 600);
    expect(block).toContain("bottom: 1px;");
    expect(block).toContain("height: 2px;");
    expect(block).toContain("animation: notice-life");
  });

  it("drives the duration from the shared NOTICE_TTL table", () => {
    const notify = read("src/lib/notify.ts");
    expect(notify).toContain('"--notice-life"');
    expect(notify).toContain("NOTICE_TTL");
  });
});
