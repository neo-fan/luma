/**
 * 反代吞吐轮询（2.0.0 从 `usePlayerEngine` 抽出）。
 *
 * 三件事，都有明确的历史原因：
 * 1. **速率读数**：控制栏右侧的 `↓ 2.4 MB/s` 取的是反代实际下载量。hls.js 自己
 *    量的是回环速度（MSE 喂进去多快），没有参考价值，所以速率只认 `/meter`；
 * 2. **极慢源不能被当死线**：`bytesTotal` 只要还在涨，就是「这条线路在动」的硬
 *    证据 —— 1~2 KB/s 的源出画前会被看门狗当成无响应，光靠探活分不清「慢」和
 *    「死」，字节在涨就直接记活（并把 unknown 累计清零，见调用方注入的回调）；
 * 3. **反代重启不能闪 0**：`/meter` 拉不到时保持上一次读数，别把「暂时取不到」
 *    渲染成「没速度」。
 *
 * 反代端口不是写死的：debug 构建在 9978 被正式版占用时会回退到临时端口，
 * 所以基准地址必须问 `proxyStatus()` 要，而不是拼 `127.0.0.1:9978`。
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
  /** 换集后清零基线：否则旧集的累计量会让新集第一拍看起来「没增长」。 */
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
