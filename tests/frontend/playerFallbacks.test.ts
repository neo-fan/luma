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
    expect(stage).toContain("hasNextLine?: boolean;");
    expect(stage).toContain("nextLineBusy?: boolean;");
    // busy / error 两条出路缺一不可：转圈等待超过阈值给出口、失败立即给出口。
    // 之前是一条 `overlay.kind === "error" || waited >= 5` 的合并条件，重构后
    // 拆进两个分支（busy 用 waited >= 4、error 无条件），两处都要钉住。
    // 两处都必须带 `hasNextLine`：单线路频道上摆出这个按钮是假出口——点下去
    // 只有一句「该频道只有一条线路」，而那句话会被归类成「播放失败」盖在还在
    // 解析的画面上（2026-11-27 用户截图）。出口应该是左侧换频道。
    expect(stage).toContain("{onNextLine && hasNextLine && waited >= 4 ? (");
    expect(stage).toContain("{onNextLine && hasNextLine ? (");
    expect(stage).toContain("换下一条线路");
    expect(stage).toContain("正在切换线路…");
    expect(stage).toContain("player-status__action");
  });

  it("restarts the wait clock when the attempt changes, not when busy flips", () => {
    // 「已等待 Ns」是这一次尝试的时长。换台/换线时 busy 一直是 true，只看 busy
    // 会把上一个台的 9s 带过来——刚点下去就写「已等待 9s」（2026-11-27 截图）。
    expect(stage).toContain("attemptKey?: string;");
    expect(stage).toContain("}, [busy, attemptKey]);");
    expect(stage).toContain("startedAt.current = Date.now();");
  });

  it("renders the caller's classified failure once, instead of a second synonym title", () => {
    // 调用方（直播页）已经用 classifyLiveFailure 给出「主文案 + 归因」，卡片
    // 直接用它：标题＝主文案、副行＝归因。若这里再套一句「无法解析播放地址」，
    // 同一件事就被说了两遍，而且两句话都没有下一步动作。
    expect(stage).toContain("resolveFailure?: { message: string; hint: string } | null;");
    expect(stage).toContain("title: resolveFailure.message,");
    expect(stage).toContain("desc: resolveFailure.hint || EXTERNAL_PLAY_FALLBACK.desc,");
    // 没有归类结论时才回落到通用标题。
    expect(stage).toContain("const fallbackTitle = resolveError");
  });

  it("never lets a layout squeeze the error bar (half-visible message)", () => {
    // `.error-bar` 为了裁倒计时线用了 `overflow: hidden`，这会把 flex 自动
    // 最小高度归零；直播页 `.live-main` 是定高列，于是这条被压成 26px，用户
    // 只看到半行「错误信息」（2026-11-27）。必须显式禁止被压缩。
    const css = styles("feedback.css");
    const anchor = css.indexOf(".error-bar {");
    expect(anchor, "锚点丢失：.error-bar 基础规则改名/挪走了？").toBeGreaterThanOrEqual(0);
    const block = css.slice(anchor);
    expect(block.slice(0, block.indexOf("}"))).toContain("flex: none;");
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
    // 「换下一条线路」是乐观切换：直接切同序集，不做可用性预检。
    const page = source("pages/PlayerPage.tsx");
    const controller = source("hooks/playback/usePlaybackController.ts");
    expect(controller).toContain("const nextLine = useCallback(() => {");
    expect(controller).toMatch(/selectEpisode\(targetLine, index, "正在切换线路…"\)/);
    expect(page).toContain("onNextLine={nextLine}");
    const live = source("pages/LivePage.tsx");
    expect(live).toContain("const selectNextLine = useCallback(");
    expect(live).toContain("selectNextLine();");
  });
});

describe("live page never shows two contradicting conclusions", () => {
  const live = source("pages/LivePage.tsx");

  it("hides the stale failure bar while a new attempt is still connecting", () => {
    // 画面中央写「正在连接播放地址… 已等待 Ns」，顶上再挂一条上一轮的「播放失败」
    // 就是两个互相否决的结论同屏（2026-11-27 用户截图）。
    expect(live).toContain("const attemptInFlight = resolving || reloading;");
    expect(live).toContain("!attemptInFlight && (videoError || videoStage === \"single-line\")");
  });

  it("routes a single-line channel to a toast, never to a failure bar", () => {
    const start = live.indexOf("const selectNextLine = useCallback(");
    expect(start, "锚点丢失：selectNextLine 改名/挪走了？").toBeGreaterThanOrEqual(0);
    const body = live.slice(start, live.indexOf("switchOrFailoverRef.current", start));
    // 「只有一条线路」不是播放失败：写进 videoError 会被归类成
    // 「播放失败，原因未能确定」，压在仍在解析的画面上。
    expect(body).not.toContain('setVideoError("该频道只有一条线路。")');
    expect(body).toContain("notify.warn(");
    // 舞台上也不给假出口。
    expect(live).toContain("hasNextLine={channel.lines.length > 1}");
    expect(live).toContain("attemptKey={playUrl}");
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

describe("first-open player chunk preload", () => {
  it("warms PlayerPage from the detail page, not from app boot", () => {
    const loader = source("components/player/playerPageLoader.ts");
    const host = source("components/player/PlayerHost.tsx");
    const detail = source("pages/DetailPage.tsx");
    const shell = source("AppShell.tsx");
    // 单一 import 点：路由层与预热方共用同一个 loader，Vite 才会去重。
    expect(loader).toContain("export const loadPlayerPage");
    expect(loader).toContain('import("../../pages/PlayerPage")');
    expect(host).toContain('from "./playerPageLoader"');
    expect(host).toContain("lazy(loadPlayerPage)");
    // 详情页是进播放页的必经之路，在这里预热：读简介的几秒足够拉完 chunk。
    expect(detail).toContain("loadPlayerPage()");
    // 启动时就预热会让从不点播的人白付 835 KiB 的解析，必须是详情页触发。
    expect(shell).not.toContain("loadPlayerPage");
    // 预热失败不能变成未捕获异常：真正进播放页时 loadWithRetry 会再试。
    expect(detail).toContain("void loadPlayerPage().catch");
  });

  it("holds the route switch until the player chunk is in memory", () => {
    const detail = source("pages/DetailPage.tsx");
    const start = detail.indexOf("const playEpisode = (");
    expect(start, "锚点丢失：playEpisode 改名/挪走了？").toBeGreaterThanOrEqual(0);
    const body = detail.slice(start, detail.indexOf("const toggleFavorite"));
    // 顺序是契约：先拿内核、再 navigate。反过来就是先切路由、由 PlayerHost 的
    // Suspense 兜一块黑底 spinner——那正是用户反馈的「播放页首次 loading」。
    const goAt = body.indexOf("const go = () =>");
    const loadAt = body.indexOf("void loadPlayerPage().then(go, go);");
    expect(goAt).toBeGreaterThanOrEqual(0);
    expect(loadAt).toBeGreaterThan(goAt);
    // 等内核期间要留在详情页，并明确在等什么；重复点击只认第一次。
    expect(detail).toContain("正在打开播放器…");
    expect(body).toContain("bootPlayingRef.current");
  });

  it("fallback is centered with the film name, not a bare spinner in the corner", () => {
    const host = source("components/player/PlayerHost.tsx");
    expect(host).toContain('className="page player-boot"');
    expect(host).toContain("<Spinner center");
    expect(host).toContain("player-boot__name");
    const css = styles("player.css");
    expect(css).toContain(".player-boot {");
    expect(css).toContain(".player-boot__name {");
  });
});

describe("live page never auto-switches on resolve errors", () => {
  const live = source("pages/LivePage.tsx");
  const resolution = source("hooks/usePlayResolution.ts");

  it("hook commits errorPlayUrl paired with every resolveError write", () => {
    // 错误归属仍是可观测字段（诊断/未来手动提示要用），但页面不再据此自动换线。
    expect(resolution).toContain("const [errorPlayUrl, setErrorPlayUrl]");
    expect(resolution).toContain("setErrorPlayUrl(playUrl);"); // catch + no-url
    expect(resolution).toContain("setErrorPlayUrl(\"\")"); // 缓存命中 / 常规清除
    expect(resolution).toContain("errorPlayUrl,"); // 出现在 return
  });

  it("page no longer defers an auto line switch by error ownership", () => {
    expect(live).not.toContain("if (errorPlayUrl !== playUrl)");
    expect(live).not.toContain("void switchOrFailoverRef.current()");
  });
});
