import { describe, expect, it } from "vitest";
import { createSwitchQueue } from "./switchQueue";
import type { SwitchQueue } from "./switchQueue";

interface Target {
  episodeIndex: number;
}

const sameEpisode = (a: Target, b: Target) => a.episodeIndex === b.episodeIndex;

/** 手动控制的执行器：测试自己决定什么时候收口。 */
function controllable() {
  const calls: Target[] = [];
  const gates: Array<() => void> = [];
  const run = (target: Target) =>
    new Promise<void>((resolve) => {
      calls.push(target);
      gates.push(resolve);
    });
  /** 让最近一次执行收口，并排干队列推进用的微任务。 */
  const settle = async () => {
    const done = gates.shift();
    if (!done) {
      throw new Error("没有在执行的任务");
    }
    done();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { calls, settle, run };
}

function harness() {
  const exec = controllable();
  const errors: unknown[] = [];
  const queue: SwitchQueue<Target> = createSwitchQueue({
    run: exec.run,
    equals: sameEpisode,
    onError: (error) => errors.push(error),
  });
  return { queue, exec, errors };
}

describe("switch queue", () => {
  it("空闲时请求立即开始执行", () => {
    const { queue, exec } = harness();
    queue.request({ episodeIndex: 3 });
    expect(exec.calls).toEqual([{ episodeIndex: 3 }]);
    expect(queue.isBusy()).toBe(true);
    expect(queue.peekPending()).toBeNull();
  });

  it("执行中的新请求排队，收口后只跑最后一个", async () => {
    const { queue, exec } = harness();
    queue.request({ episodeIndex: 1 });
    queue.request({ episodeIndex: 2 });
    queue.request({ episodeIndex: 3 });
    queue.request({ episodeIndex: 4 });
    // burst 内只执行首个与最后一个：中间集不解析、不闪画面
    expect(exec.calls.map((c) => c.episodeIndex)).toEqual([1]);
    expect(queue.peekPending()).toEqual({ episodeIndex: 4 });
    await exec.settle();
    expect(exec.calls.map((c) => c.episodeIndex)).toEqual([1, 4]);
    expect(queue.peekPending()).toBeNull();
  });

  it("重复点正在执行的同一集不再排队", async () => {
    const { queue, exec } = harness();
    queue.request({ episodeIndex: 5 });
    queue.request({ episodeIndex: 5 });
    queue.request({ episodeIndex: 5 });
    await exec.settle();
    expect(exec.calls.length).toBe(1);
    expect(queue.isBusy()).toBe(false);
  });

  it("队列里已有的同一目标不重复累积", async () => {
    const { queue, exec } = harness();
    queue.request({ episodeIndex: 1 });
    queue.request({ episodeIndex: 9 });
    queue.request({ episodeIndex: 9 });
    await exec.settle();
    expect(exec.calls.map((c) => c.episodeIndex)).toEqual([1, 9]);
  });

  it("执行器抛错不卡队列：onError 收到，pending 继续跑", async () => {
    const calls: number[] = [];
    const errors: unknown[] = [];
    const queue = createSwitchQueue<Target>({
      run: (target) => {
        calls.push(target.episodeIndex);
        return target.episodeIndex === 1 ? Promise.reject(new Error("坏线路")) : Promise.resolve();
      },
      equals: sameEpisode,
      onError: (error) => errors.push(error),
    });
    queue.request({ episodeIndex: 1 });
    queue.request({ episodeIndex: 2 });
    // 排干整条 catch/finally 链：宏任务一次到位
    await new Promise((resolve) => setTimeout(resolve, 0));
    {
      expect(errors).toHaveLength(1);
      expect(calls).toEqual([1, 2]);
      expect(queue.isBusy()).toBe(false);
    }
  });

  it("cancelPending 只丢未执行的意图，不影响正在跑的那次", async () => {
    const { queue, exec } = harness();
    queue.request({ episodeIndex: 1 });
    queue.request({ episodeIndex: 7 });
    queue.cancelPending();
    await exec.settle();
    expect(exec.calls.map((c) => c.episodeIndex)).toEqual([1]);
    expect(queue.isBusy()).toBe(false);
  });

  it("取消后可以再排同一个目标", async () => {
    const { queue, exec } = harness();
    queue.request({ episodeIndex: 1 });
    queue.request({ episodeIndex: 7 });
    queue.cancelPending();
    await exec.settle();
    queue.request({ episodeIndex: 7 });
    expect(exec.calls.map((c) => c.episodeIndex)).toEqual([1, 7]);
  });

  it("连续多轮请求都能收口，不留悬挂状态", async () => {
    const { queue, exec } = harness();
    for (let i = 1; i <= 4; i += 1) {
      queue.request({ episodeIndex: i });
      queue.request({ episodeIndex: i + 10 });
      await exec.settle();
    }
    await exec.settle();
    expect(queue.isBusy()).toBe(false);
    expect(queue.peekPending()).toBeNull();
  });
});
