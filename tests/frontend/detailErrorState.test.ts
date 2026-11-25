/**
 * 详情页整页失败时的呈现（`ErrorBar size="panel"`）。
 *
 * 问题形态：失败时页面上只有一条贴顶的红横幅，下面 ~500px 全是空的——视觉上
 * 像「页面没渲染完」，而不是「这个源这次不行」。修法不是给横幅加装饰，而是
 * 让**错误成为这一屏的内容**：与详情空态共用同一套居中容器，同一套解剖结构
 * （主文案 / 归因 / 技术详情 / 复制 / 重试）换一张卡片承载。
 *
 * 表现层没有 dom 环境，所以钉住三件重构时最容易丢的事：
 * 1. 容器与空态一致（`.detail-empty-wrap`），不能再退回贴顶横幅；
 * 2. 处置动作给真按钮（重试是主目标动作），不是只有一个图标；
 * 3. 类名不换（探针靠 `.error-bar__text` / `.error-bar__actions button` 定位）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";
import { blockAfter, blockFrom } from "./readSource";

const read = (path: string) => readFileSync(resolve(__dirname, "../../", path), "utf8");

describe("详情页整页失败", () => {
  it("renders the error as the page content, not a strip above a void", () => {
    const detail = read("src/pages/DetailPage.tsx");
    const branch = blockAfter(detail, "{error ? (", ") : doubanMeta ? (");
    // 与空态同一个居中容器：上下留白对称，卡片落在视线中心。
    expect(branch).toContain('className="detail-empty-wrap"');
    expect(branch).toContain('size="panel"');
    expect(branch).toContain('message="详情加载失败"');
  });

  it("offers the next steps as real buttons", () => {
    const detail = read("src/pages/DetailPage.tsx");
    const branch = blockAfter(detail, "{error ? (", ") : doubanMeta ? (");
    // 重试由 ErrorBar 面板态给（主按钮）；换源与全站搜索由页面给。
    expect(branch).toContain("onRetry={retry}");
    expect(branch).toContain("换源");
    expect(branch).toContain("全站搜索此片");
    // 处置说明由归类结果拼出来，不写死一句笼统的「出错了」。
    expect(branch).toContain("reason.label");
    expect(branch).toContain("${reason.hint}。可以先重试；一直不稳的话，换一个有片源的站点。");
  });

  it("keeps the classified reason single-sourced", () => {
    const detail = read("src/pages/DetailPage.tsx");
    const branch = blockAfter(detail, "{error ? (", ") : doubanMeta ? (");
    expect(detail).toContain('const reason = classifyFailure(undefined, error ?? "");');
    // 面板里归因与处置说明共用同一次分类：两处各调一次 classify 会在改规则时漂移。
    expect(branch).not.toContain("classifyFailure");
  });
});

describe("ErrorBar 的面板态", () => {
  it("swaps the strip for a centered card", () => {
    const css = readCss();
    expect(css).toContain(".error-bar--panel {");
    const rule = blockAfter(css, ".error-bar--panel {", "}", ".error-bar--panel");
    // 比详情空态（900，海报 + 文案两列）窄：错误卡片只有一列文字，
    // 撑到 900 会变成「左边一小撮字 + 右半张卡全空」。
    expect(rule).toContain("max-width: 640px;");
    expect(rule).toContain("margin: 0 auto;");
    // 中性面板底 + 常规边框：红色大块会把「源站波动」渲染成「客户端崩了」。
    expect(rule).toContain("background: var(--panel);");
    expect(rule).toContain("border: 1px solid var(--border);");
  });

  it("promotes retry to a labelled button and skips the icon twin", () => {
    const bar = read("src/components/ErrorBar.tsx");
    const panel = blockAfter(bar, "{isPanel && onRetry ? (", "{actions}", "panel retry");
    expect(panel).toContain('className="btn btn--primary"');
    expect(panel).toContain("重试");
    // 同一个动作只留一个入口：图标重试在面板态必须关掉。
    expect(bar).toContain("{onRetry && !isPanel ? (");
  });

  it("keeps the class names the probes locate", () => {
    const bar = read("src/components/ErrorBar.tsx");
    // tools/probes 用 `.error-bar` / `.error-bar__text` 判定「当前是错误态」。
    expect(bar).toContain('"error-bar error-bar--panel"');
    expect(bar).toContain('className="error-bar__text"');
    expect(bar).toContain('className="error-bar__hint"');
    expect(bar).toContain('className="error-bar__actions"');
    // 面板态仍要能复制错误、能看到技术详情。
    expect(bar).toContain("技术详情");
    expect(bar).toContain('data-copy-state={copyState}');
  });

  it("pairs the copy affordance with the technical detail, not the actions", () => {
    const bar = read("src/components/ErrorBar.tsx");
    const css = readCss();
    // 复制是诊断动作，和「换源」并排会被读成同一类处置；面板态把它挂在
    // 技术详情那一行，动作行只留真正要做的事。
    expect(bar).toContain('className="error-bar__tech"');
    expect(bar).toContain('className="btn btn--ghost error-bar__copy"');
    expect(bar).toContain("{copyable && !isPanel ? (");
    expect(css).toContain(".error-bar--panel .error-bar__tech {");
    expect(css).toContain(".error-bar--panel .error-bar__copy {");
    const rule = blockAfter(css, ".error-bar--panel .error-bar__copy {", "}", ".error-bar__copy");
    // 比处置按钮轻一档，不抢「换源」的视觉重量。
    expect(rule).toContain("height: 26px;");
    // 展开后代码块要占满整行：不写这条，pre 会被挤成一个窄方块贴在行中间。
    expect(css).toContain(".error-bar--panel .error-bar__detail[open] {");
    const open = blockAfter(css, ".error-bar--panel .error-bar__detail[open] {", "}", "detail[open]");
    expect(open).toContain("flex: 1;");
  });

  it("only grows the type scale in panel mode", () => {
    const css = readCss();
    const panel = blockFrom(css, ".error-bar--panel {");
    expect(panel).toContain(".error-bar--panel .error-bar__text {");
    expect(panel).toContain("font-size: var(--fs-h1);");
    // 条状（bar）的字号不能被面板规则带跑。
    const base = blockAfter(css, ".error-bar__text {", "}", ".error-bar__text");
    expect(base).not.toContain("--fs-h1");
  });
});
