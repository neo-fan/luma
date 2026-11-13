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

// tests/frontend -> project root
const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("player lifecycle contract", () => {
  it("keeps the ArtPlayer container mounted while resolving", () => {
    const stage = read("src/components/player/PlayerStage.tsx");
    // The container must be rendered unconditionally. A conditional
    // `!resolving && playable ? <div ref=...>` detaches a playing <video>
    // from the DOM (audio keeps going, picture disappears).
    expect(stage).toMatch(/<div\s+ref=\{containerRef\}/);
    expect(stage).not.toMatch(/!resolving && playable \?/);
    expect(stage).toContain("player-art--hidden");
  });

  it("blocks engine creation during resolving and for non-builtin kinds", () => {
    const engine = read("src/hooks/usePlayerEngine.ts");
    expect(engine).toContain("resolving ||");
    expect(engine).toContain("!BUILTIN_KINDS.includes(resolved.kind)");
    // resolving must participate in the effect deps, otherwise the engine is
    // recreated from the *previous* source's resolved value.
    expect(engine).toMatch(/\}, \[resolved, resolving, siteKey, vodName\]\)/);
  });

  it("hard-stops media and decoders before destroying ArtPlayer", () => {
    const engine = read("src/hooks/usePlayerEngine.ts");
    const cleanup = engine.slice(engine.lastIndexOf("return () => {"));
    expect(cleanup).toContain("video.pause()");
    expect(cleanup).toContain('video.removeAttribute("src")');
    expect(cleanup).toContain("teardownDecoders?.()");
    expect(cleanup).toContain("art.destroy()");
    // Direct teardown (not only ArtPlayer's destroy event) is what prevents a
    // detached hls.js/mpegts.js stream from doubling the audio.
    expect(engine).toContain("instance.on(\"destroy\", () => teardownDecoders?.())");
  });

  it("remounts the player page on source / episode / line changes", () => {
    // react-router 迁移后，PlayerPage 的挂载点在路由包装组件里；
    // key 必须由 siteKey:vodId:playUrl 派生，切源/切集/切线路时整页干净卸载。
    const routes = read("src/routes.tsx");
    expect(routes).toMatch(
      /<PlayerPage[\s\S]{0,600}?key=\{`\$\{siteKey\}:\$\{vodId\}:\$\{state\.playUrl\}`\}/,
    );
  });
});
