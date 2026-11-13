import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeAutoNav,
  ledgerBudget,
  ledgerCountSwitch,
  ledgerHasUrl,
  ledgerMarkSite,
  ledgerMarkUrl,
  ledgerReset,
  ledgerSiteSeen,
  ledgerSuccess,
  markAutoNav,
} from "../../src/lib/failoverLedger";

describe("failoverLedger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records urls and sites, dedups sites", () => {
    ledgerReset("片A");
    ledgerMarkUrl("片A", "u1");
    ledgerMarkUrl("片A", "u1");
    expect(ledgerHasUrl("片A", "u1")).toBe(true);
    expect(ledgerHasUrl("片A", "u2")).toBe(false);

    ledgerMarkSite("片A", "s1");
    ledgerMarkSite("片A", "s1");
    expect(ledgerSiteSeen("片A", "s1")).toBe(true);
    expect(ledgerSiteSeen("片A", "s2")).toBe(false);
  });

  it("isolates buckets by key", () => {
    ledgerReset("片A");
    ledgerReset("片B");
    ledgerMarkUrl("片A", "u1");
    expect(ledgerHasUrl("片B", "u1")).toBe(false);
  });

  it("expires entries after TTL", () => {
    ledgerReset("片C");
    ledgerMarkUrl("片C", "u1");
    ledgerCountSwitch("片C");
    expect(ledgerBudget("片C")).toBe(3);
    vi.advanceTimersByTime(6 * 60_000);
    expect(ledgerHasUrl("片C", "u1")).toBe(false);
    // TTL 过期即全新一轮：跳转预算重置。
    expect(ledgerBudget("片C")).toBe(4);
  });

  it("budget counts switches and runs out", () => {
    ledgerReset("片D");
    for (let i = 0; i < 4; i += 1) {
      expect(ledgerBudget("片D")).toBe(4 - i);
      ledgerCountSwitch("片D");
    }
    expect(ledgerBudget("片D")).toBe(0);
  });

  it("success restores budget but keeps url/site memory", () => {
    ledgerReset("片F");
    ledgerMarkUrl("片F", "u1");
    ledgerMarkSite("片F", "s1");
    ledgerCountSwitch("片F");
    ledgerCountSwitch("片F");
    expect(ledgerBudget("片F")).toBe(2);

    // 媒体可解码 → 连续失败链中断，预算恢复满额。
    ledgerSuccess("片F");
    expect(ledgerBudget("片F")).toBe(4);
    // 但试过的地址/站点记账保留：同一地址换个入口还是坏的。
    expect(ledgerHasUrl("片F", "u1")).toBe(true);
    expect(ledgerSiteSeen("片F", "s1")).toBe(true);

    // 恢复后还能继续消费预算。
    ledgerCountSwitch("片F");
    expect(ledgerBudget("片F")).toBe(3);
  });

  it("TTL slides with recent activity, not bucket creation", () => {
    ledgerReset("片G");
    ledgerMarkUrl("片G", "u1");
    // 静默 4 分钟后又有记账动作 → 时间戳刷新。
    vi.advanceTimersByTime(4 * 60_000);
    ledgerMarkUrl("片G", "u2");
    // 距建桶已 8 分钟（> TTL），但距最后一次活动只有 4 分钟 → 桶仍活着。
    vi.advanceTimersByTime(4 * 60_000);
    expect(ledgerHasUrl("片G", "u1")).toBe(true);
    expect(ledgerHasUrl("片G", "u2")).toBe(true);
    // 再静默超过 TTL → 整桶作废，预算重置。
    vi.advanceTimersByTime(6 * 60_000);
    expect(ledgerHasUrl("片G", "u1")).toBe(false);
    expect(ledgerBudget("片G")).toBe(4);
  });

  it("manual navigation flag: consumeAutoNav only true once", () => {
    expect(consumeAutoNav()).toBe(false);
    markAutoNav();
    expect(consumeAutoNav()).toBe(true);
    // 第二次消费为 false：StrictMode 下调用方须用 ref 守卫只消费一次。
    expect(consumeAutoNav()).toBe(false);
  });

  it("reset clears the bucket", () => {
    ledgerReset("片E");
    ledgerMarkUrl("片E", "u1");
    ledgerCountSwitch("片E");
    ledgerReset("片E");
    expect(ledgerHasUrl("片E", "u1")).toBe(false);
    expect(ledgerBudget("片E")).toBe(4);
  });
});
