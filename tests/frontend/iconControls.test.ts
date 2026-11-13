/**
 * 图标化操作面的源码契约（DSH 风格：图标表达操作，状态靠图标本身）。
 *
 * 这类退化很隐蔽：把图标按钮改回文字按钮，功能一切正常，只有肉眼才看得出
 * 风格散了；图标按钮丢了 aria-label 更糟——读屏与窗口探针同时失效。
 * 用源码不变量守住三件事：图标按钮必须有语义、开关状态必须走 aria、关键
 * 动作不再以文案呈现。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("icon-first controls", () => {
  it("IconButton always exposes a label, tooltip and pressed state", () => {
    const source = read("src/components/IconButton.tsx");
    expect(source).toContain("aria-label={label}");
    expect(source).toContain("data-tip=");
    expect(source).toContain("aria-pressed=");
    expect(source).toContain("aria-expanded={expanded}");
    // 提示条走 CSS 伪元素；tip="none" 时才退回原生 title。
    expect(source).toContain('tip === "none"');
  });

  it("icon buttons have hover / on / busy / danger states in CSS", () => {
    const css = read("src/styles.css");
    expect(css).toContain(".icon-btn {");
    expect(css).toContain(".icon-btn:hover:not(:disabled)");
    expect(css).toContain(".icon-btn.is-on");
    expect(css).toContain(".icon-btn.is-busy svg");
    expect(css).toContain(".icon-btn--danger:hover:not(:disabled)");
    // 倒序/展开靠图形方向表达状态，不换图标也不换文案。
    expect(css).toContain('.icon-btn--flip[aria-pressed="true"] svg');
    expect(css).toContain('.icon-btn--rotate[aria-expanded="true"] svg');
    // 悬浮提示气泡
    expect(css).toContain(".icon-btn[data-tip]::after");
  });

  it("detail header uses icon buttons instead of text labels", () => {
    const page = read("src/pages/DetailPage.tsx");
    expect(page).toContain('name="swap"');
    expect(page).toContain('name="refresh"');
    expect(page).not.toContain("⇄ 换源");
    expect(page).not.toContain("↻ 刷新");
    // 倒序改成带 aria-pressed 的排序图标（label 只是语义，不渲染成文字）
    expect(page).toContain('className="icon-btn--flip"');
    expect(page).toContain('name="sort"');
    expect(page).toContain("pressed={reverse}");
  });

  it("player stage navigation is icon-only", () => {
    const stage = read("src/components/player/PlayerStage.tsx");
    expect(stage).toContain('name="back"');
    expect(stage).toContain('name="next"');
    expect(stage).toContain('label="上一集"');
    expect(stage).toContain('label="下一集"');
    expect(stage).not.toContain("‹ 上一集");
  });

  it("episode panel order toggle and now-playing dot use state, not text", () => {
    const panel = read("src/components/player/EpisodePanel.tsx");
    expect(panel).toContain('name="sort"');
    expect(panel).toContain("pressed={reverse}");
    // 正在播放：视觉上是一枚点，文字只留给读屏
    expect(panel).toContain("sr-only");
  });

  it("destructive and retry actions are icons with danger/busy states", () => {
    expect(read("src/pages/HistoryPage.tsx")).toContain('name="trash"');
    expect(read("src/pages/HistoryPage.tsx")).toContain('tone="danger"');
    expect(read("src/components/ErrorBar.tsx")).toContain('name="refresh"');
    // 配置重命名图标随「配置列表」section 一起迁到了 ConfigListSection。
    expect(read("src/components/settings/ConfigListSection.tsx")).toContain('name="pencil"');
  });
});
