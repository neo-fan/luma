import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { LIVE_UNRESPONSIVE_LIMIT, liveSessionMachine } from "./liveSessionMachine";

function fresh() {
  const actor = createActor(liveSessionMachine);
  actor.start();
  return actor;
}

function toLivePlaying(actor: ReturnType<typeof fresh>, url = "line1.m3u8") {
  actor.send({ type: "LOAD", url, lineIndex: 0 });
  actor.send({ type: "RESOLVED", url });
  actor.send({ type: "ATTACHED" });
  actor.send({ type: "MEDIA_ALIVE" });
}

/**
 * 把机器推到「解码器已挂上、首帧还没来」（buffering，hasPlayed=false）。
 * 直播的看门狗与现实一样只在这一段判死换线路。
 */
function toLiveWaiting(actor: ReturnType<typeof fresh>, url = "line1.m3u8") {
  actor.send({ type: "LOAD", url, lineIndex: 0 });
  actor.send({ type: "RESOLVED", url });
  actor.send({ type: "ATTACHED" });
}

describe("liveSessionMachine", () => {
  it("换台链路 idle→…→playing", () => {
    const a = fresh();
    a.send({ type: "LOAD", url: "c1.m3u8", lineIndex: 0 });
    expect(a.getSnapshot().matches("tuning")).toBe(true);
    a.send({ type: "RESOLVED", url: "c1.m3u8" });
    a.send({ type: "ATTACHED" });
    a.send({ type: "MEDIA_ALIVE" });
    const s = a.getSnapshot();
    expect(s.matches("playing")).toBe(true);
    expect(s.context.hasPlayed).toBe(true);
    expect(s.context.targetUrl).toBe("c1.m3u8");
  });

  it("换台 = 全新 LOAD，自增会话、复位首帧", () => {
    const a = fresh();
    toLivePlaying(a, "c1.m3u8");
    const before = a.getSnapshot().context.sessionId;
    a.send({ type: "LOAD", url: "c2.m3u8", lineIndex: 0 });
    const s = a.getSnapshot();
    expect(s.matches("tuning")).toBe(true);
    expect(s.context.sessionId).toBe(before + 1);
    expect(s.context.hasPlayed).toBe(false);
    expect(s.context.targetUrl).toBe("c2.m3u8");
  });

  it("手动换线路 LINE_SWITCH 重连", () => {
    const a = fresh();
    toLivePlaying(a, "line1");
    a.send({ type: "LINE_SWITCH", url: "line2", lineIndex: 1 });
    expect(a.getSnapshot().matches("tuning")).toBe(true);
    expect(a.getSnapshot().context.lineIndex).toBe(1);
  });

  it("出画前探活判死 → 请求换线路（recovering），换线后重连", () => {
    const a = fresh();
    toLiveWaiting(a, "line1");
    a.send({ type: "STALL" });
    expect(a.getSnapshot().matches("probing")).toBe(true);
    a.send({ type: "PROBE", verdict: "dead" });
    expect(a.getSnapshot().matches("recovering")).toBe(true);
    a.send({ type: "LINE_SWITCH", url: "line2", lineIndex: 1 });
    expect(a.getSnapshot().matches("tuning")).toBe(true);
  });

  it(`unknown 探测累计到 ${LIVE_UNRESPONSIVE_LIMIT} 次才换线`, () => {
    const a = fresh();
    toLiveWaiting(a);
    for (let i = 0; i < LIVE_UNRESPONSIVE_LIMIT - 1; i++) {
      a.send({ type: "STALL" });
      a.send({ type: "PROBE", verdict: "unknown" });
      expect(a.getSnapshot().matches("playing")).toBe(true);
    }
    a.send({ type: "STALL" });
    a.send({ type: "PROBE", verdict: "unknown" });
    expect(a.getSnapshot().matches("recovering")).toBe(true);
  });

  it("红线：出过画之后 STALL 进不了 probing，不自动换线路", () => {
    // 与点播同一条产品红线（「已经能播放了 就不要切」），写在转换表上而不是
    // 只写在解释器的 if 里；直播出画后的卡顿交给用户手动换线/换台。
    const a = fresh();
    toLivePlaying(a);
    a.send({ type: "STALL" });
    expect(a.getSnapshot().matches("playing")).toBe(true);
    a.send({ type: "PROBE", verdict: "dead" });
    expect(a.getSnapshot().matches("playing")).toBe(true);
  });

  it("ok 探测复位计数；反代字节在涨也复位", () => {
    const a = fresh();
    toLiveWaiting(a);
    a.send({ type: "STALL" });
    a.send({ type: "PROBE", verdict: "unknown" });
    expect(a.getSnapshot().context.unresponsiveProbes).toBe(1);
    a.send({ type: "FRAG_GROWTH" });
    expect(a.getSnapshot().context.unresponsiveProbes).toBe(0);
    a.send({ type: "STALL" });
    a.send({ type: "PROBE", verdict: "dead" });
    expect(a.getSnapshot().matches("recovering")).toBe(true);
    const b = fresh();
    toLiveWaiting(b);
    b.send({ type: "STALL" });
    b.send({ type: "PROBE", verdict: "unknown" });
    b.send({ type: "STALL" });
    b.send({ type: "PROBE", verdict: "ok" });
    expect(b.getSnapshot().context.unresponsiveProbes).toBe(0);
  });

  it("所有线路失败 → failed；再换台可恢复", () => {
    const a = fresh();
    toLiveWaiting(a);
    a.send({ type: "STALL" });
    a.send({ type: "PROBE", verdict: "dead" }); // recovering
    a.send({ type: "FAILED", reason: "all lines tried" });
    expect(a.getSnapshot().matches("failed")).toBe(true);
    a.send({ type: "LOAD", url: "c3", lineIndex: 0 });
    expect(a.getSnapshot().matches("tuning")).toBe(true);
  });
});
