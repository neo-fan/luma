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
    // 切换只有「下一张」一个入口：不再单独放上一张/下一张两个箭头按钮。
    expect(hero).toContain("home-hero__next");
    expect(hero).toContain("下一张推荐");
    expect(hero).not.toContain("上一张推荐");
    expect(hero).not.toContain("home-hero__arrow");
    expect(hero).not.toContain("ChevronLeft");
    // 激活圆点同时充当自动轮播进度条，时长跟 ROTATE_MS 同步。
    expect(hero).toContain("home-hero__dot-fill");
    expect(hero).toContain("animationDuration: `${ROTATE_MS}ms`");
    // 头图只接管横向滑动（触控板双指横滑 / Shift+滚轮）：原生监听才能
    // preventDefault，纵向滚动留给页面，不被头图吃掉。
    expect(hero).toContain('addEventListener("wheel", onWheel, { passive: false })');
    expect(hero).toContain("event.preventDefault();");
    expect(hero).toContain("Math.abs(event.deltaX) >= Math.abs(event.deltaY)");
    expect(hero).toContain("if (!horizontal && !event.shiftKey) return;");
    expect(hero).toContain("delta > 0 ? 1 : -1");
    // 站点小字整行去掉，不再渲染 eyebrow。
    expect(hero).not.toContain("home-hero__eyebrow");
    // 头图补豆瓣数据：评分 / 评价人数 / 年份 / 类型，主海报缺失时用豆瓣海报兜底。
    // 只认终态（useDoubanFullMeta）：头图是封面与简介同屏的位置，读中间态会让
    // meta 行和简介在 cover→full 之间各跳一次。
    expect(hero).toContain("useDoubanFullMeta(");
    expect(hero).not.toContain("useDoubanMeta(");
    expect(hero).toContain("formatVotes(");
    expect(hero).toContain("rating.toFixed(1)");
    expect(hero).toContain("useProxiedImage(douban?.pic)");
    // 海报地址还没拼出来（proxy_status 冷启动）时，评分/简介也不动：否则文字先跳
    // 一帧、海报后跳一帧，同屏还是两段。
    expect(hero).toContain("doubanReady && doubanPicWanted");
    expect(hero).toContain("plainText(doubanShown?.intro)");
    // 封面换来源要淡入，不能就地硬切（源站海报 → 豆瓣海报是同屏唯一的一次变化）。
    expect(hero).toContain('origin: useDoubanPoster ? "douban" : "source"');
    expect(hero).toContain("frames[activeFrame].origin !== frame.origin");
    // 来源同时暴露给窗口探针：URL 判不出「这是不是豆瓣给的图」（源站也常挂豆瓣域名）。
    expect(hero).toContain("data-origin={frame.origin}");
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
    // 指向（悬停 / 聚焦 / 按下）才拉豆瓣，避免一屏十几张同时打豆瓣搜索；命中评分时显示 ★ 分。
    expect(tile).toContain("onPointerEnter={armDouban}");
    expect(tile).toContain("onFocus={armDouban}");
    expect(tile).toContain("useDoubanMeta(vod.vod_name, vod.vod_year, doubanArmed, false, vod.vod_douban_id)");
    expect(tile).not.toContain("new IntersectionObserver(");
    expect(tile).toContain("poster-tile__rating");
  });

  it("styles the hero full-bleed and the rail as a horizontal scroller", () => {
    const css = readCss();
    expect(css).toContain("--cover-w-rail: 156px;");
    expect(css).toContain("--home-hero-h: clamp(320px, 46vh, 460px);");
    expect(css).toContain(".home-hero {");
    expect(css).toContain(".home-hero__backdrop img");
    // 电影感暗底：近乎去色 + 压暗，避免浅色海报糊成脏棕（旧 saturate(1.35) 是「泥」根因）。
    expect(css).toContain("filter: blur(72px) saturate(0.18) brightness(0.24);");
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
    // 轮播控件：圆点进度 + 右缘「下一张」热区（常驻可见 + 圆底衬，不再靠 hover 显形）
    expect(css).toContain(".home-hero__controls {");
    const nextStart = css.indexOf(".home-hero__next {");
    expect(nextStart).toBeGreaterThan(-1);
    const nextBlock = css.slice(nextStart, css.indexOf("}", nextStart));
    // 常驻可见：旧版 `opacity: 0` + hover 才显形「不明显」，现在按钮块里不该再有 opacity:0
    expect(nextBlock).not.toContain("opacity: 0");
    expect(css).toContain(".home-hero__next::before {");
    expect(css).toContain("@keyframes hero-dot-fill");
    expect(css).toContain(".home-hero__dot-fill {");
    expect(css).toContain("animation-play-state: paused;");
    expect(css).not.toContain(".home-hero__arrow");
    // 评分角标与已删除的站点小字
    expect(css).toContain(".poster-tile__rating {");
    expect(css).not.toContain(".home-hero__eyebrow");
  });
});
