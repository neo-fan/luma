/**
 * hls.js 的加载预算。
 *
 * 全部按「首个分片可能要下 20 秒」设定：AES-128 大分片实测 11.8s，慢时更久。
 * 默认 10s 的 `manifestLoadingTimeOut` 会把这类能正常播放的慢源判成 fatal，
 * 用户看到的是「后台在下载、有声音没画面」却被换线 —— 超时预算宁大不小，
 * 真正的死线判断交给卡顿看门狗的独立复核（时间不是证据）。
 *
 * 直播与点播的 `fragLoadingTimeOut` 不同：直播分片短、断流要快速暴露；
 * 点播分片可达 9MB+，45s 才算宽容。
 */
export interface HlsLoadBudget {
  enableWorker: boolean;
  lowLatencyMode: boolean;
  manifestLoadingTimeOut: number;
  manifestLoadingMaxRetry: number;
  manifestLoadingRetryDelay: number;
  levelLoadingTimeOut: number;
  levelLoadingMaxRetry: number;
  fragLoadingTimeOut: number;
  fragLoadingMaxRetry: number;
  fragLoadingRetryDelay: number;
}

const MANIFEST_TIMEOUT_MS = 20_000;
const LIVE_FRAG_TIMEOUT_MS = 20_000;
const VOD_FRAG_TIMEOUT_MS = 45_000;

export function hlsLoadBudget(isLive: boolean): HlsLoadBudget {
  return {
    enableWorker: true,
    lowLatencyMode: true,
    manifestLoadingTimeOut: MANIFEST_TIMEOUT_MS,
    manifestLoadingMaxRetry: 3,
    manifestLoadingRetryDelay: 1_000,
    levelLoadingTimeOut: MANIFEST_TIMEOUT_MS,
    levelLoadingMaxRetry: 3,
    fragLoadingTimeOut: isLive ? LIVE_FRAG_TIMEOUT_MS : VOD_FRAG_TIMEOUT_MS,
    fragLoadingMaxRetry: 4,
    fragLoadingRetryDelay: 1_000,
  };
}