/**
 * IPC 耗时缓冲：有界、可取走、不泄漏业务数据。
 *
 * 这是性能链路分析的数据源，错误行为会直接污染报告（例如缓冲无限增长、
 * 多次采样重复统计），所以单独钉住。
 */
import { describe, expect, it } from "vitest";
import {
  drainIpcSamples,
  drainSiteTimings,
  recordIpcSample,
  recordSiteTiming,
} from "./perfTrace";

describe("perfTrace IPC samples", () => {
  it("records cmd / ms / outcome without args or payload", () => {
    drainIpcSamples();
    recordIpcSample("history_remove", 100, "ok");
    const samples = drainIpcSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ cmd: "history_remove", outcome: "ok" });
    expect(typeof samples[0].at).toBe("number");
    expect(typeof samples[0].ms).toBe("number");
    // 只有失败码，没有任何可能含播放直链 / 配置地址的字段。
    expect(Object.keys(samples[0]).sort()).toEqual(["at", "cmd", "ms", "outcome"]);
  });

  it("keeps the failure code for a timed-out command", () => {
    drainIpcSamples();
    recordIpcSample("spider_invoke", 50, "err", "IPC_TIMEOUT");
    expect(drainIpcSamples()[0].code).toBe("IPC_TIMEOUT");
  });

  it("drains completely so repeated sampling never double-counts", () => {
    drainIpcSamples();
    recordIpcSample("a", 0, "ok");
    recordIpcSample("b", 0, "ok");
    expect(drainIpcSamples()).toHaveLength(2);
    expect(drainIpcSamples()).toHaveLength(0);
  });

  it("caps the buffer at 500 and drops the oldest", () => {
    drainIpcSamples();
    for (let i = 0; i < 520; i += 1) {
      recordIpcSample(`cmd${i}`, 0, "ok");
    }
    const samples = drainIpcSamples();
    expect(samples).toHaveLength(500);
    expect(samples[0].cmd).toBe("cmd20");
    expect(samples[samples.length - 1]?.cmd).toBe("cmd519");
  });
});

describe("perfTrace site timings", () => {
  const timing = { queueMs: 30_000, runMs: 860, doneMs: 30_872, status: "ok" as const };

  it("keeps the queue / run / done split for one site", () => {
    drainSiteTimings();
    recordSiteTiming({ siteKey: "量子", timing });
    const [row] = drainSiteTimings();
    expect(row).toMatchObject({ siteKey: "量子", queueMs: 30_000, runMs: 860, doneMs: 30_872 });
    expect(typeof row?.at).toBe("number");
  });

  it("ignores rows from an older backend without timing", () => {
    drainSiteTimings();
    recordSiteTiming({ siteKey: "老后端" });
    expect(drainSiteTimings()).toHaveLength(0);
  });

  it("drains and caps independently of the IPC buffer", () => {
    drainSiteTimings();
    drainIpcSamples();
    recordIpcSample("spider_invoke", 0, "ok");
    for (let i = 0; i < 420; i += 1) {
      recordSiteTiming({ siteKey: `s${i}`, timing });
    }
    const rows = drainSiteTimings();
    expect(rows).toHaveLength(400);
    expect(rows[0]?.siteKey).toBe("s20");
    // 两种采样互不影响：IPC 那条还在。
    expect(drainIpcSamples()).toHaveLength(1);
  });
});
