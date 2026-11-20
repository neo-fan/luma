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

  it("reports the failure without promising an automatic switch", () => {
    // 自动换线/换源已停用：判死文案只能陈述失败，不能写成「正在切换」。
    for (const cause of ["hlsFatal", "probeDead", "probeUnresponsive", "linesExhausted"] as FailoverCause[]) {
      const { message } = failoverCopy(cause, "detail");
      expect(message, `${cause} 不应承诺自动切换`).not.toContain("正在切换");
      expect(message, `${cause} 不应承诺自动换源`).not.toContain("其它源");
    }
    // 探活/穷尽这两类没有原始报错可展示，文案要给出用户可执行的出口。
    expect(failoverCopy("probeDead").message).toContain("换线路或换源");
    expect(failoverCopy("linesExhausted").message).toContain("换线路或换源");
  });
});
