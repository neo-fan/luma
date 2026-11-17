/**
 * 偏好写入的行为契约：钉的是「ArtPlayer 的噪声不能毁掉用户偏好」这一整族问题。
 * 假时钟 + 假定时器，顺序与节流窗口都能精确断言。
 */
import { describe, expect, it } from "vitest";
import { createPrefsWriter } from "./playerPrefsWriter";
import type { PrefsFaderView, PrefsSnapshot, PrefsVideoView } from "./playerPrefsWriter";

function harness(overrides: Partial<{ silenceMs: number; throttleMs: number; replayMs: number }> = {}) {
  let clock = 1_000;
  const video = { volume: 1, muted: false, playbackRate: 1 } as PrefsVideoView & {
    volume: number;
    muted: boolean;
    playbackRate: number;
  };
  let prefs: PrefsSnapshot = { volume: 0.4, rate: 1.5, muted: false };
  const writes: Array<Partial<PrefsSnapshot>> = [];
  const timers: Array<{ at: number; cb: () => void }> = [];
  const faderState = { silentUntil: 0, lastAudible: 0.4 };
  const fader: PrefsFaderView = {
    get silentUntil() {
      return faderState.silentUntil;
    },
    get lastAudible() {
      return faderState.lastAudible;
    },
    noteAudible: () => undefined,
  };
  const state = { current: true };
  const writer = createPrefsWriter({
    video,
    isCurrent: () => state.current,
    fader,
    read: () => prefs,
    write: (patch) => writes.push(patch),
    now: () => clock,
    timer: (cb, ms) => {
      timers.push({ at: clock + ms, cb });
      return timers.length - 1;
    },
    clearTimer: (handle) => {
      timers[handle] = { at: -1, cb: () => undefined };
    },
    ...overrides,
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const item of [...timers]) {
      const at = timers.indexOf(item);
      if (item.at !== -1 && item.at <= clock) {
        timers.splice(at, 1);
        item.cb();
      }
    }
  };
  return { writer, video, faderState, state, writes, advance, setPrefs: (p: Partial<PrefsSnapshot>) => (prefs = { ...prefs, ...p }) };
}

describe("player prefs writer", () => {
  it("静默期内的音量回写不落盘，而是纠正回记忆值", () => {
    const h = harness();
    h.video.volume = 1; // ArtPlayer 把自己缓存的 100% 写回来了
    h.writer.onVolumeChange();
    expect(h.writes).toEqual([]);
    expect(h.video.volume).toBe(0.4);
  });

  it("静默期内的倍速回写同理，且绝不顺手动 volume", () => {
    const h = harness();
    h.video.volume = 0.75; // 用户此刻的音量与偏好不同：静默期纠正不该覆盖它以外的字段
    h.video.playbackRate = 1;
    h.writer.onRateChange();
    expect(h.writes).toEqual([]);
    expect(h.video.playbackRate).toBe(1.5);
    expect(h.video.volume).toBe(0.75);
  });

  it("淡入静默窗内整段不落盘（ramp 的中间值不是用户意图）", () => {
    const h = harness();
    h.advance(3_000); // 过了实例静默期
    h.faderState.silentUntil = 10_000;
    h.video.volume = 0.1;
    h.writer.onVolumeChange();
    expect(h.writes).toEqual([]);
  });

  it("节流：连发只写第一次，最后一次由 trailing 补上", () => {
    const h = harness();
    h.advance(3_000);
    h.video.volume = 0.5;
    h.writer.onVolumeChange();
    expect(h.writes).toEqual([{ volume: 0.5, muted: false }]);
    h.video.volume = 0.6;
    h.writer.onVolumeChange();
    h.video.volume = 0.7;
    h.writer.onVolumeChange();
    expect(h.writes.length).toBe(1); // 窗口内不重复写
    h.advance(600);
    expect(h.writes.at(-1)).toEqual({ volume: 0.7, muted: false }); // 补最终值
  });

  it("倍速是低频事件：立即落盘，且只写 rate 字段", () => {
    const h = harness();
    h.advance(3_000);
    h.video.playbackRate = 2;
    h.writer.onRateChange();
    expect(h.writes).toEqual([{ rate: 2 }]);
  });

  it("取消静音但音量还是 0 → 恢复到最近有声值，且不落盘", () => {
    const h = harness();
    h.advance(3_000);
    h.faderState.lastAudible = 0.55;
    h.video.muted = false;
    h.video.volume = 0;
    h.writer.onVolumeChange();
    expect(h.video.volume).toBe(0.55);
    expect(h.writes).toEqual([]);
  });

  it("失格的旧实例（isCurrent=false）什么都不写、也不纠正", () => {
    const h = harness();
    h.advance(3_000);
    h.state.current = false;
    h.video.volume = 0.9;
    h.writer.onVolumeChange();
    h.writer.onRateChange();
    expect(h.writes).toEqual([]);
  });

  it("replay 定时器把 ArtPlayer 覆盖掉的音量与倍速一起回正", () => {
    const h = harness({ replayMs: 1_200 });
    h.video.volume = 1;
    h.video.playbackRate = 1;
    h.advance(1_300);
    expect(h.video.volume).toBe(0.4);
    expect(h.video.playbackRate).toBe(1.5);
  });

  it("dispose 取消 trailing：卸载后不再补写中间值", () => {
    const h = harness();
    h.advance(3_000);
    h.video.volume = 0.5;
    h.writer.onVolumeChange();
    h.video.volume = 0.8;
    h.writer.onVolumeChange();
    h.writer.dispose();
    h.advance(1_000);
    expect(h.writes.length).toBe(1);
  });
});
