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

  it("rotates the hero and keeps a single play action", () => {
    expect(hero).toContain("const ROTATE_MS = 6500;");
    expect(hero).toContain("window.setInterval");
    expect(hero).toContain("prefers-reduced-motion: reduce");
    expect(hero).toContain('className="home-hero__backdrop"');
    expect(hero).toContain('className="home-hero__scrim"');
    expect(hero).toContain('className="home-hero__title"');
    expect(hero).toContain("立即观看");
    // 「立即观看」本身就是进详情/播放页，不再重复一个「查看详情」按钮。
    expect(hero).not.toContain("查看详情");
    expect(hero).toContain("home-hero__dot");
    // 站点小字整行去掉，不再渲染 eyebrow。
    expect(hero).not.toContain("home-hero__eyebrow");
    // 头图补豆瓣数据：评分 / 评价人数 / 年份 / 类型，主海报缺失时用豆瓣海报兜底。
    expect(hero).toContain("useDoubanMeta(");
    expect(hero).toContain("formatVotes(");
    expect(hero).toContain("rating.toFixed(1)");
    expect(hero).toContain("useProxiedImage(douban?.pic)");
  });

  it("scrolls rails horizontally with arrows only when content overflows", () => {
    expect(rail).toContain('className="poster-rail__track"');
    expect(rail).toContain("scrollBy({ left: direction * track.clientWidth * 0.82");
    expect(rail).toContain("track.scrollWidth > track.clientWidth + 4");
    expect(rail).toContain("向左翻");
    expect(rail).toContain("向右翻");
    expect(rail).toContain("<PosterTile");
  });

  it("hints scrollable edges, disables spent arrows and supports keyboard paging", () => {
    // 到头之后箭头置灰，而不是让人点了没反应
    expect(rail).toContain("disabled={atStart}");
    expect(rail).toContain("disabled={atEnd}");
    // 左右边缘渐隐提示，滚到那一侧就收起
    expect(rail).toContain('className="poster-rail__fade poster-rail__fade--start"');
    expect(rail).toContain('className="poster-rail__fade poster-rail__fade--end"');
    expect(rail).toContain("is-overflow");
    // 横排本身可聚焦，左右方向键翻页
    expect(rail).toContain("tabIndex={0}");
    expect(rail).toContain('event.key === "ArrowLeft"');
    expect(rail).toContain('event.key === "ArrowRight"');
    // 只有文字层随片重挂，封面不重挂（避免换片时图片闪一下）
    expect(hero).toContain('className="home-hero__text" key={current.vod_id}');
  });

  it("keeps poster tiles shared between wall and rail", () => {
    expect(tile).toContain('className="poster-tile__frame"');
    expect(tile).toContain('className="poster-tile__title"');
    expect(tile).toContain('className="poster-tile__meta"');
    expect(tile).toContain("useProxiedImage(vod.vod_pic)");
    expect(tile).toContain("|| site ||");
    // 卡片进视口才拉豆瓣；命中评分时在海报右上角显示 ★ 分。
    expect(tile).toContain("new IntersectionObserver(");
    expect(tile).toContain("useDoubanMeta(");
    expect(tile).toContain("poster-tile__rating");
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
    // 可滚动的视觉提示与键盘焦点
    expect(css).toContain(".poster-rail__fade {");
    expect(css).toContain(".poster-rail__fade--end");
    expect(css).toContain(".poster-rail__arrow:disabled");
    expect(css).toContain(".poster-rail__track:focus-visible");
    // 换片时只让文字入场
    expect(css).toContain("@keyframes hero-text-in");
    // 评分角标与已删除的站点小字
    expect(css).toContain(".poster-tile__rating {");
    expect(css).not.toContain(".home-hero__eyebrow");
  });
});
