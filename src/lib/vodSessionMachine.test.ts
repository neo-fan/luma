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
    a.send({ type: "FAILED", reason: "media decode" });
    expect(a.getSnapshot().matches("recovering")).toBe(true);
  });

  it("canPersistVolume 只在 FADE_DONE 后为真（三个时间窗收敛成一条）", () => {
    const a = fresh();
    toPlaying(a);
    expect(a.getSnapshot().context.fadeDone).toBe(false);
    a.send({ type: "FADE_DONE" });
    expect(a.getSnapshot().context.fadeDone).toBe(true);
  });

  it("failed 后 LOAD 开新会话", () => {
    const a = fresh();
    a.send({ type: "LOAD", url: "e1" });
    // 解析阶段就失败（拿不到地址）→ failed；解码阶段失败才走 recovering 换线。
    a.send({ type: "FAILED", reason: "no url" });
    expect(a.getSnapshot().matches("failed")).toBe(true);
    const before = a.getSnapshot().context.sessionId;
    a.send({ type: "LOAD", url: "e2" });
    expect(a.getSnapshot().matches("resolving")).toBe(true);
    expect(a.getSnapshot().context.sessionId).toBe(before + 1);
  });
});
