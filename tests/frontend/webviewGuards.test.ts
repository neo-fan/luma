import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WebView 收口契约：桌面应用不该带浏览器的默认行为。
 *
 * 这里不做真实事件派发（vitest 跑在 node 环境，没有 DOM），只钉住三件事：
 * 入口装了守卫、守卫挡住的是浏览器快捷键、Ctrl+R 仍然放行。
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("webview guards", () => {
  it("installs the guards before React mounts", () => {
    const main = read("../../src/main.tsx");
    expect(main).toContain('import { installWebviewGuards } from "./lib/webviewGuards";');
    expect(main).toContain("installWebviewGuards();");
    expect(main.indexOf("installWebviewGuards();")).toBeLessThan(
      main.indexOf("ReactDOM.createRoot"),
    );
  });

  it("blocks the browser context menu and the usual browser keys", () => {
    const guards = read("../../src/lib/webviewGuards.ts");
    expect(guards).toContain('"contextmenu"');
    expect(guards).toContain('"dragover"');
    expect(guards).toContain('"drop"');
    expect(guards).toContain('case "F5"');
    expect(guards).toContain("event.preventDefault();");
    // Ctrl+F / Ctrl+P / Ctrl+S 这类「页内浏览器动作」在拦截名单里。
    for (const key of ["f", "p", "s", "u"]) {
      expect(guards).toContain(`\n  "${key}", //`);
    }
    // 缩放与开发者工具也要收，否则 Ctrl+滚轮还能把界面缩放成手机版。
    expect(guards).toContain("ZOOM_KEYS");
    expect(guards).toContain('lower === "i"');
  });

  it("keeps Ctrl+R as the only refresh entry", () => {
    const guards = read("../../src/lib/webviewGuards.ts");
    // 有修饰键的分支里不能出现 "r"：Ctrl+R 必须落到宿主默认刷新。
    expect(guards).toContain("保留的强制刷新入口");
    expect(guards).not.toContain('\n  "r", //');
  });

  it("keeps selection off the chrome but on for body text", () => {
    const css = read("../../src/styles/base.css");
    expect(css).toContain("user-select: none;");
    expect(css).toContain(".detail-content,");
    expect(css).toContain("user-select: text;");
  });
});
