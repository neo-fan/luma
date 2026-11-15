/**
 * 沉浸式首页契约（腾讯视频式）。
 *
 * 2026-11-15 用户要求「首页的推荐如果有的话 做成海报墙样式」，随后明确要
 * 「腾讯视频那种首页沉浸」并强调「左右滚动」：推荐区 = 顶部整幅头图轮播 +
 * 横向推荐条（可左右翻），分类 tab 仍保持原来的卡片网格。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

const root = resolve(__dirname, "../..");
const home = readFileSync(resolve(root, "src/pages/HomePage.tsx"), "utf8");
const hero = readFileSync(resolve(root, "src/components/HomeHero.tsx"), "utf8");
const rail = readFileSync(resolve(root, "src/components/PosterRail.tsx"), "utf8");
const tile = readFileSync(resolve(root, "src/components/PosterTile.tsx"), "utf8");

describe("immersive home (hero + horizontal rails)", () => {
  it("routes the recommendation tab through HomeHero and PosterRail", () => {
    expect(home).toContain('import HomeHero from "../components/HomeHero";');
    expect(home).toContain('import PosterRail from "../components/PosterRail";');
    expect(home).toContain("<HomeHero");
    expect(home).toContain("<PosterRail");
    // 头图吃掉前 5 条，剩下的进横排
    expect(home).toContain("const HERO_COUNT = 5;");
    expect(home).toContain("list.slice(0, HERO_COUNT)");
    expect(home).toContain("list.slice(HERO_COUNT)");
    // 分类 tab 仍是原来的卡片网格
    expect(home).toContain('<div className="vod-grid">');
    expect(home).toContain("<VodCard");
  });

  it("rotates the hero and exposes play / detail actions", () => {
    expect(hero).toContain("const ROTATE_MS = 6500;");
    expect(hero).toContain("window.setInterval");
    expect(hero).toContain("prefers-reduced-motion: reduce");
    expect(hero).toContain('className="home-hero__backdrop"');
    expect(hero).toContain('className="home-hero__scrim"');
    expect(hero).toContain('className="home-hero__title"');
    expect(hero).toContain("立即观看");
    expect(hero).toContain("查看详情");
    expect(hero).toContain("home-hero__dot");
  });

  it("scrolls rails horizontally with arrows only when content overflows", () => {
    expect(rail).toContain('className="poster-rail__track"');
    expect(rail).toContain("scrollBy({ left: direction * track.clientWidth * 0.82");
    expect(rail).toContain("track.scrollWidth > track.clientWidth + 4");
    expect(rail).toContain("向左翻");
    expect(rail).toContain("向右翻");
    expect(rail).toContain("<PosterTile");
  });

  it("keeps poster tiles shared between wall and rail", () => {
    expect(tile).toContain('className="poster-tile__frame"');
    expect(tile).toContain('className="poster-tile__title"');
    expect(tile).toContain('className="poster-tile__meta"');
    expect(tile).toContain("useProxiedImage(vod.vod_pic)");
    expect(tile).toContain("|| site ||");
  });

  it("styles the hero full-bleed and the rail as a horizontal scroller", () => {
    const css = readCss();
    expect(css).toContain("--cover-w-rail: 156px;");
    expect(css).toContain("--home-hero-h: clamp(320px, 46vh, 460px);");
    expect(css).toContain(".home-hero {");
    expect(css).toContain(".home-hero__backdrop img");
    expect(css).toContain("filter: blur(36px) saturate(1.35) brightness(0.6);");
    const start = css.indexOf(".poster-rail__track {");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toContain("overflow-x: auto");
    expect(block).toContain("display: flex");
    // 悬停放大 + 其余压暗（沉浸式焦点）
    expect(css).toContain("transform: scale(1.045);");
    expect(css).toContain(".poster-rail__track:has(.poster-tile:hover)");
  });
});
