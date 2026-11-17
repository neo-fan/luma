/**
 * 吞吐轮询的契约：基准地址来源、增长判定、取不到时不闪 0。
 * 轮询回调通过注入的 `setInterval` 捕获，手动触发 —— 不需要真等一秒。
 */
import { describe, expect, it } from "vitest";
import { createThroughputMeter } from "./playerThroughputMeter";
import type { MeterReading } from "./playerThroughputMeter";

function harness(responses: Array<MeterReading | Error>) {
  const growth: number[] = [];
  const labels: string[] = [];
  const urls: string[] = [];
  const pending: Array<() => void> = [];
  let cleared = false;
  let index = 0;
  const meter = createThroughputMeter({
    fallbackBase: "http://127.0.0.1:9978",
    status: () => Promise.resolve({ baseUrl: "http://127.0.0.1:53999" }),
    fetchJson: (url) => {
      urls.push(url);
      const next = responses[index++];
      if (next === undefined || next instanceof Error) {
        return next ? Promise.reject(next) : Promise.reject(new Error("no more data"));
      }
      return Promise.resolve(next);
    },
    onGrowth: (total) => growth.push(total),
    render: (label) => labels.push(label),
    format: (bps) => (bps > 0 ? `${Math.round(bps / 1024)} KB/s` : ""),
    setInterval: (cb) => {
      pending.push(cb);
      return 1;
    },
    clearInterval: () => {
      cleared = true;
    },
  });
  const stop = meter.start();
  /** 等 status() 落定：反代基准地址是异步拿到的。 */
  const settleStatus = async () => {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
    }
  };
  const pump = async () => {
    await settleStatus();
    for (const cb of pending) {
      cb();
    }
    // 排干 fetchJson 的 then 链
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  };
  return { growth, labels, urls, pump, meter, stop, cleared: () => cleared };
}

describe("throughput meter", () => {
  it("基准地址取 status() 的 baseUrl，不写死 9978", async () => {
    // debug 构建在 9978 被正式版占用时会回退临时端口，写死会读到别的实例。
    const h = harness([{ bytesTotal: 10, bytesPerSec: 0 }]);
    await h.pump();
    expect(h.urls[0]).toBe("http://127.0.0.1:53999/meter");
    h.stop();
  });

  it("累计字节在涨 → 记活；不涨或倒退就不报", async () => {
    const h = harness([
      { bytesTotal: 100, bytesPerSec: 2048 },
      { bytesTotal: 100, bytesPerSec: 2048 }, // 同值：没动
      { bytesTotal: 40, bytesPerSec: 2048 }, // 倒退（反代重启后重新计数）
      { bytesTotal: 180, bytesPerSec: 2048 },
    ]);
    for (let i = 0; i < 4; i += 1) {
      await h.pump();
    }
    expect(h.growth).toEqual([100, 180]);
    h.stop();
  });

  it("NaN 与缺字段都不算增长，也不渲染空标签", async () => {
    const h = harness([
      { bytesTotal: Number.NaN },
      {},
      { bytesTotal: 900, bytesPerSec: 0 },
    ]);
    for (let i = 0; i < 3; i += 1) {
      await h.pump();
    }
    // NaN / 缺字段不记活；真正在涨的 900 要记（这是「极慢但活着」的证据）
    expect(h.growth).toEqual([900]);
    // format 对 0 返回空串 → 一次都不渲染（不是写一条 "↓ "）
    expect(h.labels).toEqual([]);
    h.stop();
  });

  it("取不到数据（反代重启）：保持上一次读数，不闪 0、不记增长", async () => {
    const h = harness([
      { bytesTotal: 500, bytesPerSec: 4096 },
      new Error("proxy restarting"),
    ]);
    await h.pump();
    await h.pump();
    expect(h.labels).toEqual(["↓ 4 KB/s"]);
    expect(h.growth).toEqual([500]);
    h.stop();
  });

  it("reset（换集）之后同一累计量重新算一次增长", async () => {
    const h = harness([
      { bytesTotal: 300, bytesPerSec: 1024 },
      { bytesTotal: 300, bytesPerSec: 1024 },
      { bytesTotal: 300, bytesPerSec: 1024 },
    ]);
    await h.pump();
    h.meter.reset();
    await h.pump();
    await h.pump();
    // reset 之后同值也算一次新基线（否则新集永远等不到「在动」的证据）
    expect(h.growth).toEqual([300, 300]);
    h.stop();
  });

  it("stop 幂等且真的撤掉定时器", () => {
    const h = harness([]);
    h.stop();
    h.stop();
    expect(h.cleared()).toBe(true);
  });
});
