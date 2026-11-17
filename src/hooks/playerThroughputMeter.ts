/**
 * 反代吞吐轮询。
 *
 * 速率读数取反代 `/meter` 的实际下载量（hls.js 量的是 MSE 回环速度，无参考价值）。
 * `bytesTotal` 在涨就是「线路在动」的硬证据，回调里记活并复位 unknown 累计，
 * 否则 1~2 KB/s 的源出画前会被看门狗当无响应。取不到数据时保持上次读数。
 *
 * 基准地址问 `status()` 要：debug 构建在 9978 被占用时会回退临时端口。
 */

export interface MeterReading {
  bytesPerSec?: number;
  bytesTotal?: number;
}

export interface ThroughputMeterOptions {
  /** 默认基准地址（`proxyStatus()` 拿到结果前用它）。 */
  fallbackBase: string;
  /** 取反代状态（含真实 baseUrl）。 */
  status: () => Promise<{ baseUrl: string }>;
  fetchJson: (url: string) => Promise<MeterReading>;
  /** 累计字节增长（极慢但活着的证据）。 */
  onGrowth: (bytesTotal: number) => void;
  /** 把速率写进控制栏；元素可能还没建好，返回 false 表示这一拍不写。 */
  render: (label: string) => void;
  format: (bytesPerSec: number) => string;
  intervalMs?: number;
  setInterval?: (cb: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
}

export interface ThroughputMeter {
  /** 启动轮询，返回停止函数（幂等）。 */
  start: () => () => void;
  /** 换集后清零基线。 */
  reset: () => void;
}

export function createThroughputMeter(options: ThroughputMeterOptions): ThroughputMeter {
  const { fallbackBase, status, fetchJson, onGrowth, render, format } = options;
  const intervalMs = options.intervalMs ?? 1_000;
  const setInterval = options.setInterval ?? ((cb, ms) => window.setInterval(cb, ms));
  const clearInterval = options.clearInterval ?? ((handle) => window.clearInterval(handle));

  let base = fallbackBase;
  let lastTotal = 0;

  void status()
    .then((info) => {
      base = info.baseUrl;
    })
    .catch(() => {
      /* 反代还没起来：沿用默认端口 */
    });

  const tick = () => {
    void fetchJson(`${base}/meter`)
      .then((body) => {
        const total = Number(body.bytesTotal ?? 0);
        if (Number.isFinite(total) && total > lastTotal) {
          lastTotal = total;
          onGrowth(total);
        }
        const rate = format(Number(body.bytesPerSec ?? 0));
        if (rate) {
          render(`↓ ${rate}`);
        }
      })
      .catch(() => {
        /* 反代重启中：保持上一次读数，不闪 0 */
      });
  };

  return {
    start: () => {
      const handle = setInterval(tick, intervalMs);
      return () => clearInterval(handle);
    },
    reset: () => {
      lastTotal = 0;
    },
  };
}
