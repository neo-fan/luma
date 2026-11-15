/**
 * 画面分辨率标签。
 *
 * TVBox 的 CMS 协议没有结构化分辨率字段，`vod_remarks` 只是运营文案
 * （「已完结」「HD」「更新至 12 集」混着来），不能当作清晰度来源。真正可靠的
 * 数值只有两处：
 *
 * 1. `video.videoWidth/videoHeight` —— 解码器解出画面后的真实尺寸，换档、
 *    自适应码率切换都会跟着变（`resize` 事件），是唯一的权威来源。
 * 2. HLS 清单的 `#EXT-X-STREAM-INF:RESOLUTION=` —— 声明值，清单解析完就有，
 *    多数 TVBox 源单码率且不写这一项，所以只作兜底。
 *
 * 本模块只做纯计算，便于单测；DOM / 生命周期在 `PlayerResolution` 里。
 */

export interface VideoMeta {
  /** `video.videoWidth`；还没解出画面时为 0。 */
  width: number;
  /** `video.videoHeight`；还没解出画面时为 0。 */
  height: number;
  /** HLS 清单 RESOLUTION 声明的短边高度；没有就留空。 */
  declaredHeight?: number;
  /**
   * 实测视频码率（kbps，按 HLS 分片 `字节数 × 8 ÷ 分片时长` 平滑）。
   *
   * 清单里的 `BANDWIDTH` 是声明值，源常写错或干脆不写；这个值来自实际下载的
   * 分片，能反映「这一集到底多少码率」。非 HLS（直链 mp4 / flv）拿不到，留空。
   */
  bitrateKbps?: number;
}

/**
 * 短边阈值 → 展示用档位。表按从高到低匹配，命中即止。
 *
 * 只保留 720P / 1080P / 2K / 4K 四档：这是用户真正会用来判断画质的说法。
 * 再往下的 480P / 360P 对观影没有意义（那就是「糊」），不如直接给精确像素，
 * 免得把 `854×480` 说成 720P。
 */
const TIERS: ReadonlyArray<readonly [number, string]> = [
  [2000, "4K"],
  [1300, "2K"],
  [900, "1080P"],
  [600, "720P"],
];

function dimension(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value);
}

function tierLabel(shortSide: number): string {
  const hit = TIERS.find(([min]) => shortSide >= min);
  return hit ? hit[1] : "";
}

/**
 * `1920×1080 → "1080P"`、`2560×1440 → "2K"`、`3840×2160 → "4K"`。
 * 竖屏短视频（`1080×1920`）同样取短边，仍报 1080P。低于 720P 的片源不硬套
 * 档位，直接给精确尺寸（`854×480`），尺寸缺失（0）才返回空串。
 */
export function resolutionLabel(width: number, height: number): string {
  const w = dimension(width);
  const h = dimension(height);
  if (!w || !h) {
    return "";
  }
  const tier = tierLabel(Math.min(w, h));
  return tier || `${w}×${h}`;
}

/** 角标第二行 / tooltip 用的精确尺寸：`1920 × 1080`。 */export function resolutionDetail(width: number, height: number): string {
  const w = dimension(width);
  const h = dimension(height);
  return w && h ? `${w} × ${h}` : "";
}

/**
 * 角标文案：优先真实解码尺寸，其次清单声明的高度，都没有返回空串（不渲染）。
 *
 * 声明值可能是非标准高度（如 1078），这类仍按 `1080P` 归并——它本来就是
 * 分档标签，用户关心的是「高清 / 超清 / 4K」这层含义。
 */
export function resolutionBadge(meta: VideoMeta): string {
  const decoded = resolutionLabel(meta.width, meta.height);
  if (decoded) {
    return decoded;
  }
  const declared = dimension(meta.declaredHeight);
  if (!declared) {
    return "";
  }
  return tierLabel(declared) || `${declared}P`;
}

/**
 * 直接读 `<video>` 的解码尺寸，给「写历史」「状态角标」这类即时场景用。
 *
 * 还没解出画面（`videoWidth === 0`）时返回空串，调用方据此保留上一次的已知值。
 */
export function resolutionFromVideo(video: HTMLVideoElement | null | undefined): string {
  if (!video) {
    return "";
  }
  return resolutionLabel(video.videoWidth || 0, video.videoHeight || 0);
}

/**
 * 从运营文案里捞清晰度，只认显式的 `1080P` / `4K` 这类写法。
 *
 * 「已完结」「HD」这种没信息量的值返回空串——把它当分辨率显示会误导。
 * 这个函数只用于站点详情还没回来时的占位，拿到解码尺寸后一律以真实值为准。
 */
export function remarksResolution(remarks?: string | null): string {
  const text = (remarks ?? "").trim();
  if (!text) {
    return "";
  }
  if (/4\s*K|2160\s*P/i.test(text)) {
    return "4K";
  }
  const match = text.match(/(\d{3,4})\s*P/i);
  if (!match) {
    return "";
  }
  const height = Number(match[1]);
  return height >= 300 ? `${height}P` : "";
}

/**
 * 实测码率的展示文案：≥1000 kbps 用 Mbps 一位小数，否则 kbps 整数。
 *
 * 非正数/NaN 返回空串：直链 mp4 拿不到码率，角标就不该出现这一段。
 */
export function bitrateLabel(kbps?: number): string {
  if (typeof kbps !== "number" || !Number.isFinite(kbps) || kbps <= 0) {
    return "";
  }
  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(1)} Mbps`;
  }
  return `${Math.round(kbps)} kbps`;
}
