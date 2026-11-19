import { describe, expect, it } from "vitest";
import { createSwitchToken, createCommitGate } from "./switchToken";
import { firstPlayable } from "./probeRace";

describe("switch token", () => {
  it("begin 推进代次并让更早的 attempt 立即失效", () => {
    const token = createSwitchToken();
    const a = token.begin();
    expect(token.isCurrent(a.gen)).toBe(true);
    expect(a.signal.aborted).toBe(false);

    const b = token.begin();
    // 旧代次从此永不为当前，旧探活信号被抢占中止。
    expect(token.isCurrent(a.gen)).toBe(false);
    expect(a.signal.aborted).toBe(true);
    expect(token.isCurrent(b.gen)).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it("current 反映最新代次，abortCurrent 只中止不推进", () => {
    const token = createSwitchToken();
    const a = token.begin();
    const genAfterA = token.current();
    token.abortCurrent();
    expect(a.signal.aborted).toBe(true);
    // 代次不变：同一次意图被卸载中止，不该把「上一轮」误判成最新。
    expect(token.current()).toBe(genAfterA);
    expect(token.isCurrent(a.gen)).toBe(true);
  });

  it("旧任务即便最后完成，也绝不落地（不可能出现两次 navigate）", async () => {
    const token = createSwitchToken();
    const landed: string[] = [];
    // 模拟一次切换：begin → 异步解析 → 解析回来后用「落地前校验」决定是否 navigate。
    const attempt = (name: string, ms: number) => {
      const { gen } = token.begin();
      return new Promise<void>((done) => {
        setTimeout(() => {
          if (token.isCurrent(gen)) {
            landed.push(name); // 唯一的落地副作用：记录这次「真的 navigate 了」
          }
          done();
        }, ms);
      });
    };

    // 先发起 A，再发起 B（抢占）；故意让 A 比 B 更晚完成。
    const a = attempt("A", 40);
    const b = attempt("B", 10);
    await Promise.all([a, b]);

    // A 完成时已是过期代次 → 丢弃；只有最新意图 B 落地。
    expect(landed).toEqual(["B"]);
  });

  it("连续快速点三次，只有最后一次落地", async () => {
    const token = createSwitchToken();
    const landed: string[] = [];
    const seq = ["ep1", "ep2", "ep3"].map((name, i) => {
      const { gen } = token.begin();
      return new Promise<void>((done) => {
        // 完成顺序与发起顺序相反：旧的不该赢。
        setTimeout(() => {
          if (token.isCurrent(gen)) landed.push(name);
          done();
        }, (3 - i) * 5);
      });
    });
    await Promise.all(seq);
    expect(landed).toEqual(["ep3"]);
  });

  it("abortCurrent 抢占 firstPlayable 的在途探活：旧一次立即停、不返回候选", async () => {
    const token = createSwitchToken();
    const stale = token.begin(); // 一次过期意图的探活
    token.begin(); // 新意图诞生 → stale.signal 被 abort

    const seenAborted: boolean[] = [];
    const candidates = Array.from({ length: 5 }, (_, i) => ({ line: `l${i}`, name: `n${i}`, url: `u${i}` }));
    const picked = await firstPlayable(
      candidates,
      async (_c, signal) => {
        seenAborted.push(signal.aborted);
        return false; // 都不快成功，靠 signal 提前退出循环
      },
      { concurrency: 2, signal: stale.signal },
    );

    // 外部 signal 已 abort：firstPlayable 直接判空、worker 不继续探活。
    expect(picked).toBeNull();
    expect(seenAborted.length).toBeLessThanOrEqual(1);
  });
});

describe("commit gate", () => {
  it("并发提交：被更新意图抢占的旧提交根本不碰画面", async () => {
    const token = createSwitchToken();
    const gate = createCommitGate(token);
    const calls: string[] = [];
    const run = (label: string, ms: number) => async () => {
      calls.push(`${label}:start`);
      await new Promise<void>((r) => setTimeout(r, ms));
      calls.push(`${label}:end`);
    };

    const a = token.begin(); // gen1
    const p1 = gate.commit(a.gen, run("A", 30));
    const b = token.begin(); // gen2 抢占 A —— 即便 A 的解析更早完成也不该落地
    const p2 = gate.commit(b.gen, run("B", 5));

    await Promise.all([p1, p2]);
    // A 进锁时 isCurrent(a.gen)=false → 跳过；只有最新一次 B 改画面。
    expect(calls).toEqual(["B:start", "B:end"]);
  });

  it("同一意图的多次提交严格串行、不重叠", async () => {
    const token = createSwitchToken();
    const gate = createCommitGate(token);
    const calls: string[] = [];
    const gen = token.begin().gen;
    const p1 = gate.commit(
      gen,
      async () => {
        calls.push("1:start");
        await new Promise<void>((r) => setTimeout(r, 10));
        calls.push("1:end");
      },
    );
    const p2 = gate.commit(
      gen,
      async () => {
        calls.push("2:start");
        calls.push("2:end");
      },
    );
    await Promise.all([p1, p2]);
    // 串行：1 完整结束后才轮到 2，绝不交叠（避免双 switchSource 竞态）。
    expect(calls).toEqual(["1:start", "1:end", "2:start", "2:end"]);
  });
});
