/**
 * 首页推荐区海报墙契约。
 *
 * 2026-11-15 用户要求「首页的推荐如果有的话 做成海报墙样式」，并选了
 * 「推荐区改成纯海报墙」：只显示海报、片名压封面、悬停再出集数/年份/地区。
 * 分类 tab 保持原来的卡片（`.vod-grid` + `VodCard`）不变。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

const root = resolve(__dirname, "../..");
const home = readFileSync(resolve(root, "src/pages/HomePage.tsx"), "utf8");
const wall = readFileSync(resolve(root, "src/components/PosterWall.tsx"), "utf8");

describe("home recommendation poster wall", () => {
  it("routes the recommendation tab through PosterWall", () => {
    expect(home).toContain('import PosterWall from "../components/PosterWall";');
    expect(home).toContain("<PosterWall");
    expect(home).toContain("onOpen={openVod}");
    // 推荐条目常常没有宽高信息，悬停用站点名兜底
    expect(home).toContain("site={site?.name ?? siteKey}");
    // 分类 tab 仍是原来的卡片网格
    expect(home).toContain('<div className="vod-grid">');
    expect(home).toContain("<VodCard");
  });

  it("renders poster-only tiles that reveal meta on hover", () => {
    expect(wall).toContain('className="poster-wall"');
    expect(wall).toContain('className="poster-tile__frame"');
    expect(wall).toContain('className="poster-tile__title"');
    expect(wall).toContain('className="poster-tile__meta"');
    expect(wall).toContain("vod.vod_remarks, vod.vod_year, vod.vod_area");
    // 推荐条目没有集数/年份/地区时退回站点名
    expect(wall).toContain("|| site ||");
    // 复用同一套封面代理/缓存链路
    expect(wall).toContain("useProxiedImage(vod.vod_pic)");
  });

  it("fits eight columns at 1440 without hover-only layout shifts", () => {
    const css = readCss();
    expect(css).toContain("--cover-w-wall-min: 150px;");
    const start = css.indexOf(".poster-wall {");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toContain("repeat(auto-fill, minmax(var(--cover-w-wall-min), 1fr))");
    expect(css).toContain(".poster-tile:hover .poster-tile__meta");
    // 骨架静止：不再给海报墙加扫光动画
    expect(css).not.toContain("@keyframes poster");
  });
});
