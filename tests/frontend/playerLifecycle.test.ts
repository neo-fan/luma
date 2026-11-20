/**
 * Regression guard for the "换源后只有声音没画面 / 双流双声" bug.
 *
 * The defect was a DOM/lifecycle mismatch, not a pure-function bug, so it
 * cannot be reproduced in the current node-only vitest environment (no jsdom).
 * These source-level invariants mirror the app's existing freshness self-check
 * (`tools/probe_playback_ux.mjs`) and fail loudly if any of the four fixes is
 * accidentally reverted.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

// tests/frontend -> project root
const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("player lifecycle contract", () => {
  it("keeps the ArtPlayer container mounted and visible while resolving", () => {
    const stage = read("src/components/player/PlayerStage.tsx");
    // 容器必须无条件渲染且不再按 resolving 隐藏：条件卸载会让正在播的
    // <video> 脱离 DOM（只有声音没画面），visibility:hidden 又会连带把
    // 控制栏一起藏掉（视频异常时用户连暂停/刷新都点不到）。
    expect(stage).toMatch(/<div\s+ref=\{containerRef\}/);
    expect(stage).not.toMatch(/!resolving && playable \?/);
    expect(stage).not.toContain("player-art--hidden");
    expect(stage).toContain("player-status");
  });

  it("blocks engine creation during resolving and for non-builtin kinds", () => {
    const engine = read("src/hooks/usePlayerEngine.ts");
    expect(engine).toContain("resolving ||");
    expect(engine).toContain("!BUILTIN_KINDS.includes(resolved.kind)");
    // resolving must participate in the effect deps, otherwise the engine is
    // recreated from the *previous* source's resolved value.
    // `vodName` 曾被列进依赖却从未被 effect 使用：一旦有人让原地换源同步片名，
    // 这条死依赖就会把换源变成整实例销毁 + 黑屏数秒，已移除。
    expect(engine).toMatch(/\}, \[resolved, resolving, siteKey\]\);/);
    expect(engine).not.toMatch(/\[resolved, resolving, siteKey, vodName\]/);
  });

  it("hard-stops media and decoders before destroying ArtPlayer", () => {
    const engine = read("src/hooks/usePlayerEngine.ts");
    // 硬停收在幂等的 hardStop() 里：cleanup 与全局唯一实例登记表共用，
    // 这样 HMR / 换集漏掉 cleanup 时，新实例创建前也能收回游离的 <video>。
    const cleanup = engine.slice(engine.lastIndexOf("return () => {"));
    expect(cleanup).toContain("hardStop()");
    expect(cleanup).toContain("unregister()");
    expect(engine).toContain("stopActivePlayer(container)");
    expect(engine).toContain("registerPlayer(hardStop)");
    const hardStop = engine.slice(engine.indexOf("const hardStop = () => {"));
    expect(hardStop.slice(0, 700)).toContain("video.pause()");
    expect(hardStop.slice(0, 700)).toContain('video.removeAttribute("src")');
    expect(hardStop.slice(0, 700)).toContain("teardownDecoders?.()");
    expect(hardStop.slice(0, 700)).toContain("art.destroy()");
    // 解码器自己同时做两件事：把 teardown 交给内核（硬停路径直接调），
    // 并订阅 ArtPlayer 的 destroy 事件。少任一条都会留一个还在灌数据的 MSE 源。
    // 订阅必须用 `once`：原地换集/换台复用同一实例，`on` 会在实例上累积处理器。
    const decoders = read("src/hooks/playerDecoders.ts");
    expect(decoders).toContain("host.lifecycle.setTeardown(destroy);");
    expect(decoders).toContain('instance.once("destroy", destroy);');
  });

  it("status overlay never blocks the controls", () => {
    const css = readCss();
    const overlay = css.slice(css.indexOf(".player-overlay {"));
    expect(overlay.slice(0, 400)).toContain("pointer-events: none");
    expect(overlay.slice(0, 400)).toContain("background: transparent");
  });

  it("keeps a cross-HMR global registry so two players can never play at once", () => {
    const registry = read("src/lib/playerRegistry.ts");
    expect(registry).toContain("globalThis");
    expect(registry).toContain("previous.stop()");
    expect(registry).toContain("video.pause()");
    expect(registry).toContain("document.querySelectorAll(\"video\")");
  });

  it("remounts the player page on source / episode / line changes", () => {
    // 播放页独立导航后，PlayerPage 的挂载点移到常驻层 PlayerHost（路由只负责
    // 开会话）；key 必须仍由 siteKey:vodId:playUrl 派生，切源/切集/切线路时
    // 整页干净卸载，不会出现双流双声。
    const host = read("src/components/player/PlayerHost.tsx");
    expect(host).toMatch(
      /key=\{`\$\{session\.siteKey\}:\$\{session\.vodId\}:\$\{session\.playUrl\}`\}/,
    );
  });

  it("idle host keeps the DOM (no unmount / display:none) so background play survives", () => {
    const host = read("src/components/player/PlayerHost.tsx");
    // 隐藏必须用 visibility（媒体继续解码），不能 display:none 或按条件卸载，
    // 否则切回播放页时 hls.js 重新拉流、进度归零。
    expect(host).toContain('active ? "player-host" : "player-host is-idle"');
    const css = readCss();
    const idle = css.slice(css.indexOf(".player-host.is-idle"));
    expect(idle.slice(0, 300)).toContain("visibility: hidden");
    expect(idle.slice(0, 300)).not.toMatch(/display:\s*none/);
  });
});

describe('history writer attaches after the player instance exists', () => {
  // 2026-11-20 实测回归：usePlaybackHistory 排在 usePlayerEngine 之前，resolved
  // 那拍 videoRef.current 还是 null → 进度 effect 早退且永不重跑 → 在播不写历史。
  // 契约：effect 依赖必须带「挂载信号」，页面必须把 playerRoot 喂进来。
  const hist = read('src/hooks/usePlaybackHistory.ts');
  const page = read('src/pages/PlayerPage.tsx');

  it('progress effect deps include the attach signal', () => {
    expect(hist).toMatch(/\[resolved, activeSiteKey, activeVodId, activeVodName, playUrl, ledgerKey, attachSignal\]/);
  });

  it('PlayerPage wires playerRoot as the attach signal', () => {
    expect(page).toContain('attachSignal: playerRoot,');
  });
});

describe("episode panel follows an in-flight line switch", () => {
  // 2026-11-20 CDP 实测：点播放器里的「换下一条线路」后，候选要并发探活
  // （实测 ~9s）才知道切到哪条线。这期间播放器写着「正在切换线路…」，底部
  // 选集区却因为 `nextLine` 把 phase 收回 idle 而毫无反馈、仍停在旧线路，
  // 用户读到的就是「点了没反应 / panel 没立刻切换」。
  // 契约：面板在途态必须把 nextLineBusy 也算进去。
  const page = read("src/pages/PlayerPage.tsx");
  const panel = read("src/components/player/EpisodePanel.tsx");

  it("PlayerPage feeds nextLineBusy into the panel loading state", () => {
    expect(page).toMatch(
      /const panelBusy = switching \|\| engine\.switching \|\| nextLineBusy;/,
    );
    expect(page).toMatch(/loading=\{panelBusy\}/);
  });

  it("EpisodePanel renders the loading state it is fed", () => {
    expect(panel).toContain('player-episodes is-loading');
    expect(panel).toContain("aria-busy={loading || undefined}");
  });
});
