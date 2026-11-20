import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 播放页的两条「出路」契约：
 *
 * 1. 加载过久 / 解析失败时，舞台中间直接给出「换下一条线路」，不要让用户
 *    自己去右侧线路列表里翻；按钮必须能点到（overlay 是 pointer-events:none）。
 * 2. 从点播页切回直播页时，直播接管声音：先按停后台点播，再重新起播；否则
 *    点播还在后台播，直播被让路逻辑按停，画面就停在黑屏。
 *
 * 组件测试环境没装 jsdom，这里按项目惯例读源码断言关键结构，避免为了两个
 * 条件渲染引入整套 DOM 渲染测试。
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = (path: string) =>
  readFileSync(resolve(here, "../../src", path), "utf8");
const styles = (path: string) =>
  readFileSync(resolve(here, "../../src/styles", path), "utf8");

describe("player stage fallback action", () => {
  const stage = source("components/player/PlayerStage.tsx");

  it("offers a next-line button on failure and after a short wait", () => {
    expect(stage).toContain("onNextLine?: () => void;");
    expect(stage).toContain("nextLineBusy?: boolean;");
    // busy / error 两条出路缺一不可：转圈等待超过阈值给出口、失败立即给出口。
    // 之前是一条 `overlay.kind === "error" || waited >= 5` 的合并条件，重构后
    // 拆进两个分支（busy 用 waited >= 4、error 无条件），两处都要钉住。
    expect(stage).toContain("{onNextLine && waited >= 4 ? (");
    expect(stage).toContain("{onNextLine ? (");
    expect(stage).toContain("换下一条线路");
    expect(stage).toContain("正在切换线路…");
    expect(stage).toContain("player-status__action");
  });

  it("keeps the control bar visible while the line is broken or slow", () => {
    const css = styles("player.css");
    // 锚点必须先存在：`not.toContain` 在锚丢失（indexOf=-1 → slice(-1)
    // 只剩一个字符）时会静默通过，正是这类契约测试最危险的漏报面。
    const busyAnchor = css.indexOf(".player-stage.is-busy .art-video-player .art-bottom {");
    expect(busyAnchor, "锚点丢失：.is-busy 的 .art-bottom 规则改名/挪走了？").toBeGreaterThanOrEqual(0);
    expect(css).toContain(".player-stage.is-error .art-video-player .art-bottom,");
    expect(css).toContain(".player-stage.is-busy .art-video-player .art-bottom {");
    const block = css.slice(busyAnchor);
    const body = block.slice(0, block.indexOf("}"));
    expect(body).toContain("opacity: 1 !important;");
    expect(body).toContain("visibility: visible !important;");
    // .art-bottom 是 inset:0 的全幅层：给它放开 pointer-events 会在后台
    // 播放时把整个页面的点击吞光（2026-11-16 实测搜索页错误条点不到）。
    // 可点权限只给进度条 / 控制栏两行。
    expect(body).not.toContain("pointer-events");
    const progressAnchor = css.indexOf(".player-stage.is-busy .art-video-player .art-progress,");
    expect(progressAnchor, "锚点丢失：进度条/控制栏的可点规则没了？").toBeGreaterThanOrEqual(0);
    const clickable = css.slice(progressAnchor);
    expect(clickable.slice(0, clickable.indexOf("}"))).toContain(
      "pointer-events: auto !important;",
    );
  });

  it("keeps the button clickable inside a pointer-events-none overlay", () => {
    const css = styles("player.css");
    const block = css.slice(css.indexOf(".player-status__action {"));
    expect(block.slice(0, block.indexOf("}"))).toContain("pointer-events: auto;");
  });

  it("wires the button to the line switcher on both pages", () => {
    // 「换下一条线路」的执行体在编排 controller；播放页只负责把回调递给 PlayerStage。
    const page = source("pages/PlayerPage.tsx");
    expect(source("hooks/playback/usePlaybackController.ts")).toContain("const nextLine = useCallback(() => {");
    expect(source("hooks/playback/usePlaybackController.ts")).toContain("void tryNextLine()");
    expect(page).toContain("onNextLine={nextLine}");
    const live = source("pages/LivePage.tsx");
    expect(live).toContain("onNextLine={() => {");
  });
});

describe("live page takes the sound back when it becomes visible", () => {
  const live = source("pages/LivePage.tsx");

  it("only yields to vod while the user is somewhere else", () => {
    expect(live).toContain("if (!liveActive && (vodActive || vodPlaying))");
  });

  it("never resurrects live audio on a neutral route (ghost-sound regression)", () => {
    // 「直播→点播→暂停点播→切首页」路径上，旧代码会在中立路由把为点播让路而
    // 暂停的直播直接 play() 回来——用户听到一个看不见、停不掉的后台声音。
    // 恢复必须绑定 liveActive；被抑制的恢复要留 INFO 可诊断。
    expect(live).toContain("if (liveActive && pausedForVod.current) {");
    expect(live).toContain('log.info("live resume deferred: not on live route"');
  });

  it("pauses background vod and restarts itself on entering the live route", () => {
    expect(live).toContain("if (!liveActive) {\n      return;\n    }");
    expect(live).toContain("pauseVodMedia();");
    expect(live).toContain('setMediaPlaying("vod", false);');
    expect(live).toContain("pausedForVod.current = false;");
    expect(live).toContain("void video.play().catch(() => {");
  });

  it("gets the live route flag from the shell", () => {
    const shell = source("AppShell.tsx");
    expect(shell).toContain("liveActive={isLiveRoute}");
  });
});

describe("live auto-failover ignores a stale-round resolve error", () => {
  // P1 竞态（CDP 实测：点 CCTV5 后 169ms，上一台「解析超时」的残留错误把新台
  // 第一条线路自动跳走）：resolveError 是 state，换台那次渲染仍是旧错误串，
  // 自动换线必须按「错误归属地址」放行。契约 = hook 配对写入 + 页面守卫文本。
  const live = source("pages/LivePage.tsx");
  const resolution = source("hooks/usePlayResolution.ts");

  it("hook commits errorPlayUrl paired with every resolveError write", () => {
    // 每个写错误的分支都必须同时写归属：catch / no-url 写当前 playUrl，清除路径写空串。
    // 同一同步块的双 setter 保证「任一渲染里两值一致」，消费方才能放心比对。
    expect(resolution).toContain("const [errorPlayUrl, setErrorPlayUrl]");
    expect(resolution).toContain("setErrorPlayUrl(playUrl);"); // catch + no-url
    expect(resolution).toContain("setErrorPlayUrl(\"\")"); // 缓存命中 / 常规清除
    expect(resolution).toContain("errorPlayUrl,"); // 出现在 return
  });

  it("page defers auto line switch unless the error belongs to current playUrl", () => {
    expect(live).toContain("if (errorPlayUrl !== playUrl)");
  });
});
