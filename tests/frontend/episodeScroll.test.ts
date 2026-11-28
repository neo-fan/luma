/**
 * 选集格子的长集名约定：单行裁切，悬停 / 键盘聚焦时横向滚到末尾。
 *
 * 竖屏短剧与综艺的集名常常 10+ 字（如「20260515特别企划」），格子宽度固定，
 * 折行会让整行网格高低不齐，所以统一由 `EpisodeButton` 负责「激活就滚动」。
 * 详情页和播放页的选集区都必须走这个组件，别再各自手写 `<button class="episode">`。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("episode button", () => {
  it("scrolls to the end on activation and resets when leaving", () => {
    const source = read("src/components/EpisodeButton.tsx");
    expect(source).toContain("el.scrollWidth - el.clientWidth");
    expect(source).toContain('behavior: "smooth"');
    expect(source).toContain("onPointerEnter={scrollToEnd}");
    expect(source).toContain("onPointerLeave={reset}");
    expect(source).toContain("onFocus={scrollToEnd}");
    expect(source).toContain("onBlur={reset}");
    // 完整集名仍要能给到原生 tooltip；排队 / 在播 / 上次 / 对应集各有说法。
    expect(source).toContain("title={pending ? `${name}（排队中）` : active ? `${name}（正在播放）` : seen ? `${name}（上次看到）` : corresponding ? `${name}（对应集）` : name}");
  });

  it("distinguishes queued from playing", () => {
    const source = read("src/components/EpisodeButton.tsx");
    // 排队中：独立类名 + aria-busy，不与 is-active 混用（active 只表示真在播）。
    expect(source).toContain('pending ? "is-pending" : ""');
    expect(source).toContain("aria-busy={pending || undefined}");
    expect(source).toContain('className="episode__pending"');
    const panel = read("src/components/player/EpisodePanel.tsx");
    // 排队与在播互斥：同一格同时命中时以在播为准。
    expect(panel).toContain("const pending =");
    expect(panel).toContain("!active &&");
  });

  it("is the only renderer for episode tiles", () => {
    for (const page of ["src/pages/DetailPage.tsx", "src/components/player/EpisodePanel.tsx"]) {
      const source = read(page);
      expect(source).toMatch(/import EpisodeButton from "\.\.\/(components\/)?EpisodeButton"/);
      expect(source).toContain("<EpisodeButton");
      // 别退回手写按钮：一写就又会出现居中裁切的老问题。
      expect(source).not.toContain('className={seen ? "episode is-seen" : "episode"}');
      expect(source).not.toContain('className={active ? "episode is-active" : "episode"}');
    }
  });

  it("keeps the tile single-line and horizontally scrollable", () => {
    const css = readCss();
    const start = css.indexOf("\n.episode {");
    expect(start).toBeGreaterThan(0);
    const block = css.slice(start, css.indexOf("\n}", start));
    expect(block).toContain("overflow-x: auto");
    expect(block).toContain("white-space: nowrap");
    expect(block).toContain("text-align: left");
    expect(block).toContain("line-height: calc(var(--h-control) - 2px)");
    expect(block).not.toContain("overflow-wrap");
  });
});
