/**
 * 首帧前的海报背景：`ArtPlayer` 的 `.art-poster` 与解析期那层自绘海报必须是
 * 同一套「模糊 + 压暗」语言。
 *
 * 为什么值得钉住：`playerPosterHold` 会把 `.art-poster` 一直盖到首帧
 * （`playing` / `readyState >= 3`）再渐隐，所以它就是「加载中」那几秒的整屏
 * 画面。这里一旦回退成清晰封面，用户看到的就是一张满屏高饱和剧照压在转圈和
 * 00:00 控制条后面——像页面没做完，而且和解析期那张模糊背景不是一套东西。
 *
 * 组件测试环境没有 dom，CSS 断言按项目惯例读源码。
 */
import { readCss } from "./readCss";
import { blockAfter } from "./readSource";
import { describe, expect, it } from "vitest";

const css = readCss();

/** 取规则体（不包含嵌套规则），用于比对两个海报层的处理是否一致。 */
function ruleBody(selector: string): string {
  return blockAfter(css, `${selector} {`, "}", selector);
}

describe("播放器加载期的海报背景", () => {
  it("blurs ArtPlayer's own poster, the one the hold keeps until first frame", () => {
    expect(css).toContain(".player-stage .art-poster {");
    const body = ruleBody(".player-stage .art-poster");
    // blur 会吃出透明边：必须同时放大一圈盖住，否则四周露一圈亮边。
    expect(body).toContain("filter: blur(");
    expect(body).toContain("brightness(");
    expect(body).toContain("transform: scale(1.06);");
  });

  it("keeps the two poster layers on the same treatment", () => {
    const hold = ruleBody(".player-stage-poster");
    const art = ruleBody(".player-stage .art-poster");
    const filterOf = (body: string) => body.match(/filter: ([^;]+);/)?.[1];
    const scaleOf = (body: string) => body.match(/transform: ([^;]+);/)?.[1];
    // 解析期那层与首帧前那层必须同参数：它们是同一屏的两个阶段，参数一漂
    // 用户就会看到「换了个滤镜」。
    expect(filterOf(art)).toBe(filterOf(hold));
    expect(scaleOf(art)).toBe(scaleOf(hold));
  });

  it("does not animate the filter (full-screen repaint per frame)", () => {
    const body = ruleBody(".player-stage .art-poster");
    // 只允许静态 filter；入场/退场交给 playerPosterHold 的 opacity 渐隐。
    expect(body).not.toContain("transition");
    expect(body).not.toContain("animation");
  });
});
