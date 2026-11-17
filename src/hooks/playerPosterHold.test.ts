/**
 * 海报保持的行为契约：钉的是「首帧前不许露黑屏」与「失败路径必须立刻撤干净」
 * 两条产品事实与两个坑（暂停态 timeupdate 不能渐隐、
 * 重复 hold 不能叠加监听）。假元素 + 假时钟，不需要 jsdom。
 */
import { describe, expect, it } from "vitest";
import { createPosterHold } from "./playerPosterHold";
import type { PosterElement, PosterVideo } from "./playerPosterHold";

function harness() {
  let clock = 0;
  const timers: Array<{ at: number; cb: () => void }> = [];
  const events = new Map<string, Array<() => void>>();
  const poster: PosterElement = { style: { transition: "", opacity: "", backgroundImage: "", display: "none" } };
  poster.style.backgroundImage = 'url("a.jpg")';
  const state = { paused: true, readyState: 1 };
  const video: PosterVideo = {
    get paused() {
      return state.paused;
    },
    get readyState() {
      return state.readyState;
    },
    addEventListener: ((type: string, handler: () => void) => {
      events.set(type, [...(events.get(type) ?? []), handler]);
    }) as PosterVideo["addEventListener"],
    removeEventListener: ((type: string, handler: () => void) => {
      events.set(type, (events.get(type) ?? []).filter((item) => item !== handler));
    }) as PosterVideo["removeEventListener"],
  };
  // ArtPlayer 的 video:play：我们自己维护一份，方便断言撤销后不再抬 display
  const artPlay: Array<() => void> = [];
  const hold = createPosterHold({
    poster,
    video,
    onPlay: (cb) => {
      artPlay.push(cb);
      return () => {
        const at = artPlay.indexOf(cb);
        if (at >= 0) {
          artPlay.splice(at, 1);
        }
      };
    },
    timer: (cb, ms) => {
      timers.push({ at: clock + ms, cb });
      return timers.length - 1;
    },
    clearTimer: (handle) => {
      timers[handle] = { at: -1, cb: () => undefined };
    },
  });
  const fireVideo = (type: string) => {
    for (const handler of [...(events.get(type) ?? [])]) {
      handler();
    }
  };
  const fireArtPlay = () => {
    for (const handler of [...artPlay]) {
      handler();
    }
  };
  const runTimers = (ms: number) => {
    clock += ms;
    for (const item of [...timers]) {
      if (item.at !== -1 && item.at <= clock) {
        timers.splice(timers.indexOf(item), 1);
        item.cb();
      }
    }
  };
  const listenerCount = (type: string) => (events.get(type) ?? []).length;
  return { hold, poster, video, state, fireVideo, fireArtPlay, runTimers, listenerCount, artPlay };
}

describe("poster hold", () => {
  it("hold 让 poster 显示出来，并盖过 ArtPlayer 的 play 退场", () => {
    const h = harness();
    h.hold.hold();
    expect(h.poster.style.display).toBe("");
    // ArtPlayer 会把 display 设成 none，我们的回调必须抬回来
    h.poster.style.display = "none";
    h.fireArtPlay();
    expect(h.poster.style.display).toBe("");
  });

  it("playing 之后才渐隐，渐隐结束才清图", () => {
    const h = harness();
    h.hold.hold();
    h.state.paused = false;
    h.state.readyState = 4;
    h.fireVideo("playing");
    // 淡出中：图还在（只是透明度归零），不能提前清 —— 会闪一帧黑底
    expect(h.poster.style.transition).toBe("opacity 250ms ease");
    expect(h.poster.style.opacity).toBe("0");
    expect(h.poster.style.backgroundImage).toBe('url("a.jpg")');
    h.runTimers(300);
    expect(h.poster.style.backgroundImage).toBe("");
    expect(h.poster.style.display).toBe("none");
    expect(h.hold.active).toBe(false);
  });

  it("暂停态的 timeupdate 不能触发渐隐", () => {
    const h = harness();
    h.hold.hold();
    h.state.paused = true;
    h.state.readyState = 4;
    h.fireVideo("timeupdate");
    expect(h.poster.style.transition).toBe("");
    // 解除暂停、时钟在走之后才允许兜底退场
    h.state.paused = false;
    h.fireVideo("timeupdate");
    expect(h.poster.style.opacity).toBe("0");
  });

  it("finish(false) 立即硬撤：不留定时器、不留监听、不留 art 订阅", () => {
    const h = harness();
    h.hold.hold();
    h.hold.finish(false);
    expect(h.poster.style.display).toBe("none");
    expect(h.poster.style.backgroundImage).toBe("");
    expect(h.hold.active).toBe(false);
    expect(h.listenerCount("playing")).toBe(0);
    expect(h.listenerCount("timeupdate")).toBe(0);
    expect(h.artPlay.length).toBe(0);
    // 撤销之后再推进时钟也不该有任何后续动作
    h.runTimers(1000);
    expect(h.poster.style.opacity).toBe("");
  });

  it("重复 hold 不叠加监听（连续快速换集）", () => {
    const h = harness();
    h.hold.hold();
    h.hold.hold();
    h.hold.hold();
    expect(h.listenerCount("playing")).toBe(1);
    expect(h.listenerCount("timeupdate")).toBe(1);
    expect(h.artPlay.length).toBe(1);
  });

  it("dispose 幂等：卸载两次不抛、不留残留", () => {
    const h = harness();
    h.hold.hold();
    h.hold.dispose();
    h.hold.dispose();
    expect(h.listenerCount("playing")).toBe(0);
    expect(h.artPlay.length).toBe(0);
  });
});
