/**
 * 原地切换后的路由同步：刷新必须重建到新会话，且不能破坏 router 的栈语义。
 *
 * `replacePlayTarget` 走 `replaceState` 而非 `navigate`：后者会让 PlayerPageRoute
 * 重跑 → 重挂载播放器。这里钉住纯函数产出的 state / hash，等于钉住这条约束的
 * 可验证部分（window.history 本身由浏览器保证）。
 */
import { describe, expect, it } from "vitest";
import { playTargetHistoryPatch, type PlayTarget } from "./nav";

const target: PlayTarget = {
  siteKey: "py_new",
  vodId: "92593",
  vodName: "信号",
  playUrl: "https://cdn.example/ep04.m3u8",
  episodeName: "第04集",
  playFrom: "线路二",
};

describe("playTargetHistoryPatch", () => {
  it("writes the new session into usr and the hash path", () => {
    const patch = playTargetHistoryPatch(target, null);
    expect(patch.url).toBe("#/player/py_new/92593");
    expect(patch.state).toEqual({ usr: target });
  });

  it("keeps router-owned key/idx/masked and only replaces usr", () => {
    const patch = playTargetHistoryPatch(target, {
      usr: { siteKey: "old" },
      key: "abc123",
      idx: 7,
      masked: { pathname: "/masked", search: "", hash: "" },
    });
    expect(patch.state).toEqual({
      usr: target,
      key: "abc123",
      idx: 7,
      masked: { pathname: "/masked", search: "", hash: "" },
    });
  });

  it("ignores non-object history state instead of spreading it", () => {
    expect(playTargetHistoryPatch(target, "garbage").state).toEqual({ usr: target });
    expect(playTargetHistoryPatch(target, undefined).state).toEqual({ usr: target });
  });

  it("drops optional fields that are absent", () => {
    const patch = playTargetHistoryPatch(
      { siteKey: "s", vodId: "1", vodName: "n", playUrl: "u", episodeName: "e" },
      null,
    );
    expect(patch.state.usr).toEqual({
      siteKey: "s",
      vodId: "1",
      vodName: "n",
      playUrl: "u",
      episodeName: "e",
    });
  });
});
