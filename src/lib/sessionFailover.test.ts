/**
 * 交棒文案表的契约：每个判死原因都必须有「人话 + 日志 stage」。
 *
 * 这条约束的意义在于**新增原因就编译不过 / 测试不过**：`failoverCopy` 的 switch
 * 覆盖整个联合类型（少一个 case 时 TS 会因缺少返回值报错），这里再把「文案非空、
 * stage 唯一」钉住，避免出现交棒时挂一条空红条、或两条不同原因共用一个 stage
 * 让日志 grep 分不开。
 */
import { describe, expect, it } from "vitest";
import { failoverCopy } from "./sessionFailover";
import type { FailoverCause } from "./sessionFailover";

const CAUSES: FailoverCause[] = [
  "probeDead",
  "probeUnresponsive",
  "mediaDecode",
  "hlsFatal",
  "flvFatal",
  "flvInterrupted",
  "linesExhausted",
];

describe("failover copy table", () => {
  it("covers every cause with a message and a stage", () => {
    for (const cause of CAUSES) {
      const { message, stage } = failoverCopy(cause, "detail-x");
      expect(message, `${cause} 缺用户文案`).not.toBe("");
      expect(stage, `${cause} 缺日志 stage`).not.toBe("");
    }
  });

  it("keeps stages distinct so logs stay separable", () => {
    const stages = CAUSES.map((cause) => failoverCopy(cause).stage);
    expect(new Set(stages).size).toBe(CAUSES.length);
  });

  it("does not promise a source switch when it is only switching lines", () => {
    // 用户看到「跳到别的源」会以为逻辑错了：换线阶段的文案只能说切换线路。
    expect(failoverCopy("hlsFatal", "manifestError").message).toContain("正在切换线路");
    expect(failoverCopy("probeDead").message).not.toContain("源");
    expect(failoverCopy("probeUnresponsive").message).not.toContain("源");
  });
});
