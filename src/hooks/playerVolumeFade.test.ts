/**
 * 音量淡入的行为契约（2026-11 这一簇出过 4 个 bug，逐条钉住）。
 *
 * 不依赖 jsdom：`FadeTarget` 是结构最小接口，这里用带调用记录的假对象 +
 * 手动时钟 / 手动帧队列，能把「谁先发生」这类顺序问题精确断言出来。
 */
import { describe, expect, it } from "vitest";
import {
  createVolumeFader,
  FADE_IN_MS,
  POST_FADE_SILENCE_MS,
  FALLBACK_MS,
} from "./playerVolumeFade";
import type { FadeTarget } from "./playerVolumeFade";

type Phase = "setVolume" | "setMuted";

function harness(initial: { volume: number; muted: boolean }, stored = { volume: 0.6, muted: false }) {
  let clock = 1_000;
  const frames: Array<() => void> = [];
  const timers: Array<{ at: number; cb: () => void }> = [];
  const events = new Map<string, Array<{ cb: (e: unknown) => void; once: boolean }>>();
  const log: Array<{ phase: Phase; value: number | boolean; at: number; silentUntil: number }> = [];

  const backing = {
    _volume: initial.volume,
    _muted: initial.muted,
    paused: true,
  };
  const target: FadeTarget = {
    get volume() {
      return backing._volume;
    },
    set volume(v: number) {
      backing._volume = v;
      log.push({
        phase: "setVolume",
        value: v,
        at: clock,
        silentUntil: faderRef.current?.silentUntil ?? 0,
      });
    },
    get muted() {
      return backing._muted;
    },
    set muted(v: boolean) {
      backing._muted = v;
      log.push({
        phase: "setMuted",
        value: v,
        at: clock,
        silentUntil: faderRef.current?.silentUntil ?? 0,
      });
    },
    get paused() {
      return backing.paused;
    },
    set paused(v: boolean) {
      backing.paused = v;
    },
    addEventListener: ((type: string, handler: (e: unknown) => void, opts?: unknown) => {
      const list = events.get(type) ?? [];
      list.push({ cb: handler, once: Boolean((opts as { once?: boolean })?.once) });
      events.set(type, list);
    }) as FadeTarget["addEventListener"],
    removeEventListener: ((type: string, handler: (e: unknown) => void) => {
      const list = (events.get(type) ?? []).filter((item) => item.cb !== handler);
      events.set(type, list);
    }) as FadeTarget["removeEventListener"],
  };

  const faderRef: { current: ReturnType<typeof createVolumeFader> | null } = { current: null };
  const writes: Array<{ volume: number; muted: boolean }> = [];
  const fader = createVolumeFader({
    target,
    isCurrent: () => true,
    readStored: () => stored,
    writePrefs: (prefs) => writes.push(prefs),
    now: () => clock,
    raf: (cb) => frames.push(cb),
    timer: (cb, ms) => {
      timers.push({ at: clock + ms, cb });
      return timers.length - 1;
    },
    clearTimer: (handle) => {
      timers[handle] = { at: -1, cb: () => undefined };
    },
  });
  faderRef.current = fader;

  const fire = (type: string) => {
    const list = events.get(type) ?? [];
    for (const item of [...list]) {
      item.cb({});
      if (item.once) {
        events.set(type, (events.get(type) ?? []).filter((entry) => entry !== item));
      }
    }
  };
  /** 把淡入跑到结束：按 50ms 步进推时钟并排空帧队列。 */
  const runFrames = (ms = FADE_IN_MS + 60) => {
    const until = clock + ms;
    while (clock <= until) {
      const pending = frames.splice(0, frames.length);
      for (const frame of pending) {
        frame();
      }
      clock += 10;
    }
  };
  const runFallback = () => {
    clock += FALLBACK_MS + 1;
    for (const item of [...timers]) {
      if (item.at !== -1 && item.at <= clock) {
        item.cb();
      }
    }
  };
  return { fader, target, fire, runFrames, runFallback, clock: () => clock, writes, log };
}

describe("volume fader", () => {
  it("冷启动：先静音起播，playing 后淡入到存储偏好", () => {
    const h = harness({ volume: 1, muted: false }, { volume: 0.6, muted: false });
    h.fader.armColdStart();
    expect(h.target.volume).toBe(0);
    expect(h.target.muted).toBe(true);
    expect(h.fader.fadeDone).toBe(false);

    h.fire("playing");
    expect(h.fader.fadeDone).toBe(true);
    h.runFrames();
    expect(h.target.volume).toBeCloseTo(0.6, 5);
    expect(h.target.muted).toBe(false);
  });

  it("静默窗必须先于 muted=false 立起来（否则 0 会被写成用户偏好）", () => {
    // 2026-11-15 实测：顺序反了会让 persistVolume 把此刻的 0 当用户意图落盘，
    // 整机从此默认静音。这条断言就是那个顺序本身。
    const h = harness({ volume: 1, muted: false }, { volume: 0.6, muted: false });
    h.fader.armColdStart();
    h.fire("playing");
    const unmute = h.log.find((entry) => entry.phase === "setMuted" && entry.value === false);
    expect(unmute, "没有发生取消静音").toBeDefined();
    expect(unmute!.silentUntil).toBeGreaterThan(unmute!.at);
  });

  it("换集会作废在途的冷启动 ramp（不往旧目标回写音量）", () => {
    // 冷启动淡入还没走完就换集：旧那一轮的帧闭包必须停手。
    const h = harness({ volume: 1, muted: false }, { volume: 0.2, muted: false });
    h.fader.armColdStart();
    h.fire("playing");
    // 只推进半程，让冷启动的 ramp 还在跑
    h.runFrames(80);
    const partial = h.target.volume;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(0.2);
    h.fader.armSwitch({ volume: 0.9, muted: false });
    h.fire("playing");
    h.runFrames(FADE_IN_MS + POST_FADE_SILENCE_MS + 60);
    expect(h.target.volume).toBeCloseTo(0.9, 5);
  });

  it("存储是静音（或音量≈0）→ 保持 muted，绝不淡入成「没静音但没声」", () => {
    const h = harness({ volume: 1, muted: false }, { volume: 0, muted: true });
    h.fader.armColdStart();
    h.fire("playing");
    expect(h.target.muted).toBe(true);
    expect(h.target.volume).toBe(0);
    h.runFrames();
    expect(h.target.muted).toBe(true);
  });

  it("淡入只发生一次：playing 之外再来事件不重复", () => {
    const h = harness({ volume: 1, muted: false }, { volume: 0.6, muted: false });
    h.fader.armColdStart();
    h.fire("playing");
    const after = h.target.volume;
    h.fire("canplay");
    h.fire("timeupdate");
    expect(h.target.volume).toBe(after);
  });

  it("playing 不来时 1.5s 兜底解静音", () => {
    const h = harness({ volume: 1, muted: false }, { volume: 0.6, muted: false });
    h.fader.armColdStart();
    // 让兜底判定认为已经在播（直播偶发只走 canplay 不走 playing）
    h.target.paused = false;
    h.runFallback();
    h.runFrames();
    expect(h.target.muted).toBe(false);
    expect(h.target.volume).toBeCloseTo(0.6, 5);
  });

  it("换集：淡入到切换前的有效音量，完成后正式落盘并追加静默窗", () => {
    // 与冷启动的差别是这条的存在：拖音量到 0.9 后换集，目标必须是 0.9，
    // 而不是存储里那份（2026-11-16 实测「拖音量后换集丢音量」）。
    const h = harness({ volume: 0.9, muted: false }, { volume: 0.2, muted: false });
    h.fader.armColdStart();
    h.fire("playing");
    h.runFrames();
    const undo = h.fader.armSwitch({ volume: 0.9, muted: false });
    expect(h.target.volume).toBe(0);
    expect(h.target.muted).toBe(true);
    expect(h.fader.fadeDone).toBe(false);
    h.fire("playing");
    h.runFrames(FADE_IN_MS + POST_FADE_SILENCE_MS + 60);
    expect(h.target.volume).toBeCloseTo(0.9, 5);
    expect(h.writes).toEqual([{ volume: 0.9, muted: false }]);
    undo();
  });

  it("撤销函数摘掉监听：换下一集后旧一轮淡入不会复活", () => {
    const h = harness({ volume: 1, muted: false }, { volume: 0.6, muted: false });
    const undo = h.fader.armSwitch({ volume: 0.8, muted: false });
    undo();
    h.fire("playing");
    h.runFrames();
    expect(h.target.muted).toBe(true);
    expect(h.target.volume).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it("换集时静音意图如实沿用（用户在静音态换集不该被取消静音）", () => {
    const h = harness({ volume: 0.5, muted: true }, { volume: 0.5, muted: false });
    h.fader.armSwitch({ volume: 0.5, muted: true });
    h.fire("playing");
    h.runFrames();
    expect(h.target.muted).toBe(true);
  });

  it("lastAudible：只有真正有声的音量会被记住", () => {
    const h = harness({ volume: 0.4, muted: false }, { volume: 0.4, muted: false });
    expect(h.fader.lastAudible).toBe(0.4);
    h.fader.noteAudible(0);
    expect(h.fader.lastAudible).toBe(0.4);
    h.fader.noteAudible(0.85);
    expect(h.fader.lastAudible).toBe(0.85);
  });
});
