import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import { UNRESPONSIVE_LIMIT, playerSessionMachine } from "./playerSessionMachine";

function fresh() {
  const actor = createActor(playerSessionMachine);
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

describe("playerSessionMachine", () => {
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

  it("dead 探测一次即换线；alive 探测复位计数", () => {
    const a = fresh();
    toPlaying(a);
    a.send({ type: "STALL" });
    expect(a.getSnapshot().matches("probing")).toBe(true);
    a.send({ type: "PROBE", verdict: "alive" });
    expect(a.getSnapshot().matches("playing")).toBe(true);
    expect(a.getSnapshot().context.unresponsiveProbes).toBe(0);
    a.send({ type: "STALL" });
    a.send({ type: "PROBE", verdict: "dead" });
    expect(a.getSnapshot().matches("recovering")).toBe(true);
  });

  it(`unknown 探测累计到 ${UNRESPONSIVE_LIMIT} 次才判死换线`, () => {
    const a = fresh();
    toPlaying(a);
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
