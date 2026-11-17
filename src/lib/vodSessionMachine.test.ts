import { createActor } from "xstate";
import { describe, expect, it, vi } from "vitest";
import { UNRESPONSIVE_LIMIT, vodSessionMachine } from "./vodSessionMachine";

function fresh() {
  const actor = createActor(vodSessionMachine);
  actor.start();
  return actor;
}

/** 把机器推到 playing（首帧已到）。 */
function toPlaying(actor: ReturnType<typeof fresh>, url = "e1") {
  actor.send({ type: "LOAD", url });
  actor.send({ type: "RESOLVED", url });
  actor.send({ type: "ATTACHED" });
  actor.send({ type: "MEDIA_ALIVE" });
}

/**
 * 把机器推到「解码器已挂上、首帧还没来」（buffering，hasPlayed=false）。
 * 看门狗在现实里只在这一段判决：出画之后 `stallCheck` 直接让路，不再探活。
 */
function toWaiting(actor: ReturnType<typeof fresh>, url = "e1") {
  actor.send({ type: "LOAD", url });
  actor.send({ type: "RESOLVED", url });
  actor.send({ type: "ATTACHED" });
}

describe("vodSessionMachine", () => {
  it("idle → playing 走通完整首帧链路", () => {
    const a = fresh();
    expect(a.getSnapshot().matches("idle")).toBe(true);
    a.send({ type: "LOAD", url: "a.m3u8" });
    expect(a.getSnapshot().matches("resolving")).toBe(true);
    a.send({ type: "RESOLVED", url: "a.m3u8" });
    a.send({ type: "ATTACHED" });
    expect(a.getSnapshot().matches("buffering")).toBe(true);
    a.send({ type: "MEDIA_ALIVE" });
    const s = a.getSnapshot();
    expect(s.matches("playing")).toBe(true);
    expect(s.context.hasPlayed).toBe(true);
    expect(s.context.targetUrl).toBe("a.m3u8");
  });

  it("USER_SWITCH 自增会话、进 switching、带续播意图", () => {
    const a = fresh();
    toPlaying(a);
    const before = a.getSnapshot().context.sessionId;
    a.send({ type: "USER_SWITCH", url: "e2", resumeIntent: true });
    const sw = a.getSnapshot();
    expect(sw.matches("switching")).toBe(true);
    expect(sw.context.sessionId).toBe(before + 1);
    expect(sw.context.resumeIntent).toBe(true);
    expect(sw.context.hasPlayed).toBe(false); // bumpSession 复位
    a.send({ type: "MEDIA_ALIVE" });
    expect(a.getSnapshot().matches("playing")).toBe(true);
    expect(a.getSnapshot().context.hasPlayed).toBe(true);
  });

  it("换集前暂停（resumeIntent=false）被如实携带", () => {
    const a = fresh();
    toPlaying(a);
    a.send({ type: "USER_SWITCH", url: "e2", resumeIntent: false });
    expect(a.getSnapshot().context.resumeIntent).toBe(false);
    a.send({ type: "MEDIA_ALIVE" });
    expect(a.getSnapshot().matches("playing")).toBe(true);
  });

  it("AUTOPLAY_BLOCKED 在 switching 里回 playing 且不自动续播", () => {
    const a = fresh();
    toPlaying(a);
    a.send({ type: "USER_SWITCH", url: "e2", resumeIntent: true });
    a.send({ type: "AUTOPLAY_BLOCKED" });
    expect(a.getSnapshot().matches("playing")).toBe(true);
  });

  it("AUTOPLAY_BLOCKED 置 resumeAborted，下次换集复位", () => {
    const a = fresh();
    toPlaying(a);
    a.send({ type: "USER_SWITCH", url: "e2", resumeIntent: true });
    expect(a.getSnapshot().context.resumeAborted).toBe(false);
    a.send({ type: "AUTOPLAY_BLOCKED" });
    expect(a.getSnapshot().context.resumeAborted).toBe(true);
    // 新一轮换集 bumpSession 复位，不带着上一轮的「已放弃续播」
    a.send({ type: "USER_SWITCH", url: "e3", resumeIntent: true });
    expect(a.getSnapshot().context.resumeAborted).toBe(false);
  });

  it("switching 有 15s 兜底超时：漏喂退出事件也绝不会让转环卡死", () => {
    vi.useFakeTimers();
    try {
      const a = fresh();
      toPlaying(a);
      a.send({ type: "USER_SWITCH", url: "e2", resumeIntent: true });
      expect(a.getSnapshot().matches("switching")).toBe(true);
      // 不发 MEDIA_ALIVE/AUTOPLAY_BLOCKED/FAILED —— 只靠兜底超时
      vi.advanceTimersByTime(15_000);
      expect(a.getSnapshot().matches("switching")).toBe(false);
      expect(a.getSnapshot().matches("playing")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("出画前探活：dead 一次即判死换线；ok 复位计数", () => {
    // 看门狗只在「还没出画」这一段判决（现实中 stallCheck 出画后直接让路）。
    const a = fresh();
    toWaiting(a);
    a.send({ type: "STALL" });
    expect(a.getSnapshot().matches("probing")).toBe(true);
    a.send({ type: "PROBE", verdict: "ok" });
    expect(a.getSnapshot().matches("playing")).toBe(true);
    expect(a.getSnapshot().context.unresponsiveProbes).toBe(0);
    a.send({ type: "STALL" });
    a.send({ type: "PROBE", verdict: "dead" });
    expect(a.getSnapshot().matches("recovering")).toBe(true);
  });

  it(`unknown 探测累计到 ${UNRESPONSIVE_LIMIT} 次才判死换线`, () => {
    const a = fresh();
    toWaiting(a);
    for (let i = 0; i < UNRESPONSIVE_LIMIT - 1; i++) {
      a.send({ type: "STALL" });
      a.send({ type: "PROBE", verdict: "unknown" });
      expect(a.getSnapshot().matches("playing")).toBe(true);
    }
    expect(a.getSnapshot().context.unresponsiveProbes).toBe(UNRESPONSIVE_LIMIT - 1);
    a.send({ type: "STALL" });
    a.send({ type: "PROBE", verdict: "unknown" });
    expect(a.getSnapshot().matches("recovering")).toBe(true);
  });

  it("红线：出过画之后 STALL 进不了 probing，坏到底也不自动换线", () => {
    // 这条原先只活在解释器的一个 if 里（删掉就破）。现在写在转换表上：
    // 「已经能播放了就不要切源」是产品要求，不是调用方的自觉。
    const a = fresh();
    toPlaying(a);
    a.send({ type: "STALL" });
    expect(a.getSnapshot().matches("playing")).toBe(true);
    a.send({ type: "PROBE", verdict: "dead" });
    expect(a.getSnapshot().matches("playing")).toBe(true);
  });

  it("反代字节在涨 = 极慢但活着，复位 unknown 累计", () => {
    // 1~2 KB/s 的源若不复位会被三次超时熬死；现实中这条证据来自 /meter。
    const a = fresh();
    toWaiting(a);
    a.send({ type: "STALL" });
    a.send({ type: "PROBE", verdict: "unknown" });
    expect(a.getSnapshot().context.unresponsiveProbes).toBe(1);
    a.send({ type: "FRAG_GROWTH" });
    expect(a.getSnapshot().context.unresponsiveProbes).toBe(0);
  });

  it("判死交棒后的现实恢复路径：LOAD 开新会话、USER_SWITCH 进切换", () => {
    const a = fresh();
    toWaiting(a);
    a.send({ type: "STALL" });
    a.send({ type: "PROBE", verdict: "dead" });
    expect(a.getSnapshot().matches("recovering")).toBe(true);
    const before = a.getSnapshot().context.sessionId;
    // 上层换源成功 → 重建实例 → 新的 LOAD。
    a.send({ type: "LOAD", url: "e1-other.m3u8" });
    expect(a.getSnapshot().matches("resolving")).toBe(true);
    expect(a.getSnapshot().context.sessionId).toBe(before + 1);
    expect(a.getSnapshot().context.unresponsiveProbes).toBe(0);
    // 另一条恢复路径：recovering 期间用户直接点下一集。
    const b = fresh();
    toWaiting(b);
    b.send({ type: "STALL" });
    b.send({ type: "PROBE", verdict: "dead" });
    b.send({ type: "USER_SWITCH", url: "e2", resumeIntent: false });
    expect(b.getSnapshot().matches("switching")).toBe(true);
  });

  it("复核在途时用户换集：跟新会话走，旧结论不再判死", () => {
    const a = fresh();
    toWaiting(a);
    a.send({ type: "STALL" });
    a.send({ type: "USER_SWITCH", url: "e2", resumeIntent: true });
    expect(a.getSnapshot().matches("switching")).toBe(true);
    // 迟到的 dead 落在 switching 上：没有 PROBE 转换，不会把新集判死。
    a.send({ type: "PROBE", verdict: "dead" });
    expect(a.getSnapshot().matches("switching")).toBe(true);
  });

  it("复核在途解码器直接报错 = 最硬的证据，直接 recovering", () => {
    const a = fresh();
    toWaiting(a);
    a.send({ type: "STALL" });
    a.send({ type: "FAILED", cause: "mediaDecode" });
    expect(a.getSnapshot().matches("recovering")).toBe(true);
  });

  it("failed 后 LOAD 开新会话", () => {
    const a = fresh();
    a.send({ type: "LOAD", url: "e1" });
    // 解析阶段就失败（拿不到地址）→ failed；解码阶段失败才走 recovering 换线。
    a.send({ type: "FAILED", cause: "linesExhausted" });
    expect(a.getSnapshot().matches("failed")).toBe(true);
    const before = a.getSnapshot().context.sessionId;
    a.send({ type: "LOAD", url: "e2" });
    expect(a.getSnapshot().matches("resolving")).toBe(true);
    expect(a.getSnapshot().context.sessionId).toBe(before + 1);
  });
});

describe("vodSessionMachine 副作用发起（解释器接线的契约）", () => {
  /**
   * 用 `machine.provide({ actions })` 注入实现，断言「机器到底发起了什么、发起几次」。
   * 这是 actions 落地的证明：交棒的时机与次数只在转换表里决定，解释器只提供
   * 怎么做——所以这里不需要碰 DOM 就能钉住「不会漏交棒、不会重复交棒」。
   */
  function instrumented() {
    const calls: string[] = [];
    const actor = createActor(
      vodSessionMachine.provide({
        actions: {
          navigateFailover: ({ context }) =>
            calls.push(`failover:${String(context.failoverCause)}:${context.failoverDetail}`),
          resumePlayback: () => calls.push("resumePlayback"),
          cancelResume: () => calls.push("cancelResume"),
        },
      }),
    );
    actor.start();
    return { actor, calls };
  }

  it("PROBE dead 只发起一次交棒，原因随事件带出", () => {
    const { actor, calls } = instrumented();
    toWaiting(actor as unknown as ReturnType<typeof fresh>);
    actor.send({ type: "STALL" });
    actor.send({ type: "PROBE", verdict: "dead" });
    expect(calls).toEqual(["failover:probeDead:"]);
  });

  it("unknown 前两次只留证据，第三次才交棒", () => {
    const { actor, calls } = instrumented();
    toWaiting(actor as unknown as ReturnType<typeof fresh>);
    for (let i = 0; i < UNRESPONSIVE_LIMIT - 1; i += 1) {
      actor.send({ type: "STALL" });
      actor.send({ type: "PROBE", verdict: "unknown" });
    }
    // 未达阈值：机器不做任何副作用（记日志是看门狗的事），只把计数累上去
    expect(calls).toEqual([]);
    expect(actor.getSnapshot().context.unresponsiveProbes).toBe(UNRESPONSIVE_LIMIT - 1);
    actor.send({ type: "STALL" });
    actor.send({ type: "PROBE", verdict: "unknown" });
    expect(calls).toEqual(["failover:probeUnresponsive:"]);
  });

  it("PROBE ok 只复位计数，绝不交棒", () => {
    const { actor, calls } = instrumented();
    toWaiting(actor as unknown as ReturnType<typeof fresh>);
    actor.send({ type: "STALL" });
    actor.send({ type: "PROBE", verdict: "unknown" });
    actor.send({ type: "STALL" });
    actor.send({ type: "PROBE", verdict: "ok" });
    expect(calls).toEqual([]);
    expect(actor.getSnapshot().context.unresponsiveProbes).toBe(0);
    expect(actor.getSnapshot().matches("playing")).toBe(true);
  });

  it("红线在副作用层同样成立：出画之后一个副作用都不发", () => {
    const { actor, calls } = instrumented();
    toPlaying(actor as unknown as ReturnType<typeof fresh>);
    actor.send({ type: "STALL" });
    actor.send({ type: "PROBE", verdict: "dead" });
    expect(calls).toEqual([]);
  });

  it("FAILED 的每个来源都带上自己的原因与细节", () => {
    const a = instrumented();
    toWaiting(a.actor as unknown as ReturnType<typeof fresh>);
    a.actor.send({ type: "FAILED", cause: "mediaDecode", detail: "code=3" });
    expect(a.calls).toEqual(["failover:mediaDecode:code=3"]);

    const b = instrumented();
    toWaiting(b.actor as unknown as ReturnType<typeof fresh>);
    b.actor.send({ type: "FAILED", cause: "hlsFatal", detail: "manifestError" });
    expect(b.calls).toEqual(["failover:hlsFatal:manifestError"]);
  });

  it("交棒不重放：离开 recovering 后必须重新取证才会再交一次", () => {
    const { actor, calls } = instrumented();
    toWaiting(actor as unknown as ReturnType<typeof fresh>);
    actor.send({ type: "STALL" });
    actor.send({ type: "PROBE", verdict: "dead" });
    // 上层换源成功 → 新会话；此时 context 里的判死原因必须被清空
    actor.send({ type: "LOAD", url: "e2" });
    expect(actor.getSnapshot().context.failoverCause).toBeNull();
    expect(actor.getSnapshot().matches("recovering")).toBe(false);
    // 新一轮：不重新取证就不会再交棒
    actor.send({ type: "RESOLVED", url: "e2" });
    actor.send({ type: "ATTACHED" });
    expect(calls).toEqual(["failover:probeDead:"]);
    actor.send({ type: "STALL" });
    actor.send({ type: "PROBE", verdict: "dead" });
    expect(calls).toEqual(["failover:probeDead:", "failover:probeDead:"]);
  });

  it("SWITCH_ATTACHED 才发起续播（不是出画之后）", () => {
    // 现实要求 play() 在「新地址刚挂上」时就请求一次，等 MEDIA_ALIVE 再播等于
    // 「等到有画面才播」——那正是 2026-11-15 的「换集后黑屏不动」。
    const { actor, calls } = instrumented();
    toPlaying(actor as unknown as ReturnType<typeof fresh>);
    actor.send({ type: "USER_SWITCH", url: "e2", resumeIntent: true });
    expect(calls).toEqual([]); // 换集本身不播
    actor.send({ type: "MEDIA_ALIVE" });
    expect(calls).toEqual([]); // 出画也不该由机器发起续播
    const b = instrumented();
    toPlaying(b.actor as unknown as ReturnType<typeof fresh>);
    b.actor.send({ type: "USER_SWITCH", url: "e2", resumeIntent: true });
    b.actor.send({ type: "SWITCH_ATTACHED" });
    expect(b.calls).toEqual(["resumePlayback"]);
  });

  it("换集前是暂停态（resumeIntent=false）→ 不抢控制权", () => {
    const { actor, calls } = instrumented();
    toPlaying(actor as unknown as ReturnType<typeof fresh>);
    actor.send({ type: "USER_SWITCH", url: "e2", resumeIntent: false });
    actor.send({ type: "SWITCH_ATTACHED" });
    expect(calls).toEqual([]);
  });

  it("用户中途暂停 → 机器发 cancelResume 撤掉挂起的重试", () => {
    const { actor, calls } = instrumented();
    toPlaying(actor as unknown as ReturnType<typeof fresh>);
    actor.send({ type: "USER_SWITCH", url: "e2", resumeIntent: true });
    actor.send({ type: "SWITCH_ATTACHED" });
    actor.send({ type: "AUTOPLAY_BLOCKED" });
    expect(calls).toEqual(["resumePlayback", "cancelResume"]);
    expect(actor.getSnapshot().context.resumeAborted).toBe(true);
  });

  it("兜底超时之后新地址才挂上，续播照样发起（不能停在暂停态）", () => {
    vi.useFakeTimers();
    try {
      const { actor, calls } = instrumented();
      toPlaying(actor as unknown as ReturnType<typeof fresh>);
      actor.send({ type: "USER_SWITCH", url: "e2", resumeIntent: true });
      // 15s 兜底先把 switching 收掉（模拟慢源），随后 switchUrl 才 resolve
      vi.advanceTimersByTime(15_000);
      expect(actor.getSnapshot().matches("playing")).toBe(true);
      actor.send({ type: "SWITCH_ATTACHED" });
      expect(calls).toEqual(["resumePlayback"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
