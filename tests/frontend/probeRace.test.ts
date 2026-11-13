/**
 * 线路探活竞速：把「一条一条试」换成小并发，取第一个能播的。
 *
 * 真实场景：布布追剧一部片有 6 条线路，其中 2 条是网盘 token、1 条 CDN 已死，
 * 串行探完要 16 秒才出画。这里的用例锁住三件事：快者胜、全失败返回 null、
 * 成功后立刻中止其余在飞的请求。
 */
import { describe, expect, it } from "vitest";
import { firstPlayable } from "../../src/lib/probeRace";
import type { RaceCandidate } from "../../src/lib/probeRace";

const candidate = (line: string): RaceCandidate => ({ line, name: line, url: `https://x/${line}` });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("firstPlayable", () => {
  it("返回最先探通的那条，而不是顺序第一条", async () => {
    let aborted = 0;
    const picked = await firstPlayable(
      [candidate("slow"), candidate("fast")],
      async (item, signal) => {
        if (item.line === "slow") {
          await sleep(120);
        } else {
          await sleep(10);
        }
        if (signal.aborted) {
          aborted += 1;
          return false;
        }
        return item.line === "fast";
      },
      { concurrency: 2 },
    );
    expect(picked?.line).toBe("fast");
    // 慢的那条要么被 signal 叫停、要么自然返回 false，总之不能影响结果。
    expect(aborted).toBeLessThanOrEqual(1);
  });

  it("失败（含抛异常）的候选被跳过", async () => {
    const picked = await firstPlayable(
      [candidate("boom"), candidate("dead"), candidate("ok")],
      async (item) => {
        if (item.line === "boom") {
          throw new Error("network");
        }
        return item.line === "ok";
      },
      { concurrency: 3 },
    );
    expect(picked?.line).toBe("ok");
  });

  it("全部失败返回 null", async () => {
    const picked = await firstPlayable(
      [candidate("a"), candidate("b")],
      async () => false,
      { concurrency: 2 },
    );
    expect(picked).toBeNull();
  });

  it("空列表立刻返回 null，不调用 probe", async () => {
    let calls = 0;
    const picked = await firstPlayable([], async () => {
      calls += 1;
      return true;
    });
    expect(picked).toBeNull();
    expect(calls).toBe(0);
  });

  it("并发数受 concurrency 限制（不把源站打爆）", async () => {
    let running = 0;
    let peak = 0;
    const list = Array.from({ length: 8 }, (_, index) => candidate(`c${index}`));
    const picked = await firstPlayable(
      list,
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await sleep(15);
        running -= 1;
        return false;
      },
      { concurrency: 3 },
    );
    expect(picked).toBeNull();
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("命中后中止其余候选", async () => {
    const seen: string[] = [];
    const picked = await firstPlayable(
      [candidate("a"), candidate("b"), candidate("c"), candidate("d"), candidate("e")],
      async (item, signal) => {
        seen.push(item.line);
        if (item.line === "a") {
          await sleep(5);
          return true;
        }
        await sleep(80);
        // 被中止的候选：内部应能看到 signal 已 abort。
        return !signal.aborted && item.line === "z";
      },
      { concurrency: 2 },
    );
    expect(picked?.line).toBe("a");
    // 并发 2：只会有 a 与 b 同时起跑，c/d/e 不该被启动。
    expect(seen).toEqual(["a", "b"]);
  });
});
