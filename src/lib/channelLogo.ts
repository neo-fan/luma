/**
 * 直播频道台标。
 *
 * 直播源自己的 `tvg-logo` 只有一部分源会给（cluntop 的 iptv.m3u 就没有），
 * 所以这里用 `fanmingming/live` 仓库 `tv/` 目录下的 PNG 做兜底：该仓库按
 * 频道名存图（`CCTV1.png`、`湖南卫视.png`、`CCTV4美洲.png`…），实测真实源里
 * 常见频道命中率约 90%。
 *
 * 命名归一化是「多候选」而不是「猜一次」：先试源码给的 logo，再试原名的，
 * 再去掉 `4K` / `高清` 这类后缀，最后把 `CCTV-1 综合` 收敛成 `CCTV1`。
 * 组件按顺序逐个 `onError` 换下一个，全部失败就不显示——不做占位图，
 * 列表里多一个灰色方块只会更吵。
 *
 * 纯函数，便于单测；DOM 逻辑在 `components/ChannelLogo.tsx`。
 */

/**
 * 台标基址。用 jsDelivr 而不是项目站点：`live.fanmingming.cn` 在当前环境 TLS
 * 握手失败；raw.githubusercontent 虽可用但在国内常年不稳，jsDelivr 是
 * GitHub 的 CDN 镜像，两者互为兜底。
 */
const LOGO_BASES = [
  "https://cdn.jsdelivr.net/gh/fanmingming/live@main/tv/",
  "https://raw.githubusercontent.com/fanmingming/live/main/tv/",
];

/** 画质/编码后缀：`东方卫视4K` → `东方卫视`，`湖南卫视高清` → `湖南卫视`。 */
const QUALITY_SUFFIX = /(?:2160P|1080P|720P|4K|8K|UHD|HD|超清|高清|标清|蓝光)$/i;

/**
 * `CCTV-1 综合` / `cctv 1` / `CCTV5+` → `CCTV1` / `CCTV1` / `CCTV5+`。
 *
 * 要求号码后面是结尾 / 空格 / 中文，`CCTV4K` 不能被收敛成 `CCTV4`——那是
 * 另一个频道（CCTV-4K 超高清），仓库里也有自己的 `CCTV4K.png`。
 */
function cctvName(name: string): string | null {
  const match = name.match(/^cctv[-\s]?(\d{1,2}\+?)(?=$|[\s\u4e00-\u9fa5])/i);
  if (!match) {
    return null;
  }
  return `CCTV${match[1].toUpperCase()}`;
}

/** 去掉画质后缀，可能不止一层（`东方卫视4K高清`）。 */
function stripQuality(name: string): string {
  let out = name;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(QUALITY_SUFFIX, "").trim();
    if (next === out) {
      break;
    }
    out = next;
  }
  return out;
}

/**
 * 频道名 → 该仓库里可能的文件名（不含扩展名），按可能性排序。
 *
 * 顺序很重要：`CCTV4K` 必须先试原名（仓库里真有 `CCTV4K.png`），否则会被
 * `cctvName` 先收敛成 `CCTV4`，显示成「CCTV-4」的台标。
 */
export function channelLogoNames(name: string): string[] {
  const raw = (name ?? "").trim();
  const stripped = stripQuality(raw);
  const cctv = cctvName(raw);
  const cctvStripped = cctvName(stripped);
  const out: string[] = [];
  const push = (value: string | null) => {
    const clean = (value ?? "").trim();
    if (clean && !out.includes(clean)) {
      out.push(clean);
    }
  };
  // 原名先试（`CCTV4K` 真的存在，不能被收敛成 `CCTV4`），再试 CCTV 收敛
  // （`CCTV-1 综合` → `CCTV1`），最后才是去画质后缀的写法。
  push(raw);
  push(cctv);
  push(stripped);
  push(cctvStripped);
  // `CCTV4K` 去掉 `4K` 只剩 `CCTV`，那不是任一频道的台标，别浪费请求。
  return out.filter((name) => name !== "CCTV" && !name.endsWith("-CCTV"));
}

/**
 * 台标候选 URL 列表（按优先级）。
 *
 * `logo` 是源里 `tvg-logo` 给的真实地址：有就直接排第一，猜名只作兜底。
 */
export function channelLogoUrls(name: string, logo?: string): string[] {
  const out: string[] = [];
  const explicit = (logo ?? "").trim();
  if (/^https?:\/\//i.test(explicit)) {
    out.push(explicit);
  }
  // 基址优先于候选：命中率高的候选（原名、去后缀名）都在同一个 CDN 上，
  // 先把这台 CDN 试完再换备站，常见的「第一次 404、第二次命中」只花一次
  // 往返；反过来（候选优先）会让每次失败都多打一次备站，页面明显变慢。
  const names = channelLogoNames(name);
  for (const base of LOGO_BASES) {
    for (const fileName of names) {
      const url = `${base}${encodeURIComponent(`${fileName}.png`)}`;
      if (!out.includes(url)) {
        out.push(url);
      }
    }
  }
  return out;
}
