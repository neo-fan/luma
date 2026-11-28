import { describe, expect, it } from "vitest";
import { resolvePanelLine } from "./playbackTarget";
import type { PlaybackTarget } from "./playbackTarget";
import type { PlayLine } from "../../lib/format";

/**
 * 面板线路是**派生值**：`resolvePanelLine(browse, display)`。
 *
 * 这里钉住的是一条整体不变式——**只要播放目标线路变了，面板必须跟过去**，
 * 不管变化来自换线、换集、换源还是目录重建。以前靠四处 `setPanelLineState`
 * 手动补，漏一处就退化成「播放器切了线路、选集区还列着旧线路」。
 */

const line = (name: string, count: number): PlayLine => ({
  name,
  episodes: Array.from({ length: count }, (_, i) => ({
    name: `第${i + 1}集`,
    url: `${name}-${i + 1}`,
  })),
});

const target = (lineIndex: number, lines: PlayLine[] = []): PlaybackTarget => ({
  siteKey: "s",
  siteName: "源",
  vodId: "1",
  vodName: "片",
  lines: lines.length > 0 ? lines : [line("A", 3), line("B", 3), line("C", 3)],
  lineIndex,
  episodeIndex: 0,
});

describe("resolvePanelLine", () => {
  it("follows the playback line when nothing is being browsed", () => {
    expect(resolvePanelLine(null, target(2))).toBe(2);
  });

  it("lets the user browse another line without touching playback", () => {
    const display = target(0);
    expect(resolvePanelLine({ line: 2, anchor: 0 }, display)).toBe(2);
  });

  it("drops the browse override as soon as the playback line moves", () => {
    // 用户在浏览 C（锚在线 A），播放器「换下一条线路」把目标挪到 B。
    const display = target(1);
    expect(resolvePanelLine({ line: 2, anchor: 0 }, display)).toBe(1);
  });

  it("keeps the panel on the target when browsing the playing line itself", () => {
    expect(resolvePanelLine({ line: 1, anchor: 1 }, target(1))).toBe(1);
  });

  it("never returns an index the new source does not have", () => {
    // 换源后剧集表只剩两条线，而浏览覆盖指向第 3 条（锚恰好还相等）。
    const display = target(0, [line("X", 2), line("Y", 2)]);
    expect(resolvePanelLine({ line: 2, anchor: 0 }, display)).toBe(0);
  });
});
