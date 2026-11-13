/**
 * 电子节目单（EPG）地址的应用级设置。
 *
 * 做成独立的应用设置（localStorage）而非 ConfigSnapshot 字段：节目单对所有直播
 * 源通用，且配置快照是「派生只读」的，手动改会跟 imported/runtime 分裂。这里
 * 与 liveMemory 同思路——轻量、跨重启持久、不污染配置。
 */
const STORAGE_KEY = "luma:epg:url";

/**
 * 默认节目单地址：`fanmingming/live` 仓库的 `e.xml`（XMLTV，约 7.6 MB）。
 *
 * 选它而不是原来那份 guide.xml，是因为实测只有它按 `CCTV1` / `湖南卫视` 这种
 * **频道 id** 命名：真实直播源（cluntop 的 iptv.m3u）里的频道名正好就是
 * `CCTV1`、`湖南卫视`、`东方卫视4K`，能被 `parse_epg` 的名字匹配直接命中；
 * 原来那份 guide.xml 用 `CCTV-1 综合` 一类写法，CCTV1 一条节目都匹配不到。
 *
 * 走 raw.githubusercontent 而不是项目站点 `live.fanmingming.cn`：后者在当前
 * 环境 TLS 握手直接失败（Rust 与 schannel 都失败），raw 域稳定且带 CDN。
 */
export const DEFAULT_EPG_URL =
  "https://raw.githubusercontent.com/fanmingming/live/main/e.xml";

/**
 * 旧版本的默认值（BurningC4 的 guide.xml）。
 *
 * 它曾经被写进过 localStorage（早期版本把默认值当作用户设置存了下来），
 * 而那份节目单按 `CCTV-1 综合` 命名，与真实直播源的 `CCTV1` 对不上，
 * 表现就是「节目单永远是空的」。读到它按「未设置」处理并清掉。
 */
const LEGACY_DEFAULT_EPG_URL =
  "https://raw.githubusercontent.com/BurningC4/Chinese-IPTV/master/guide.xml";

/** 读取当前节目单地址；未设置时返回默认地址。 */
export function getEpgUrl(): string {
  const stored = (localStorage.getItem(STORAGE_KEY) ?? "").trim();
  if (!stored) {
    return DEFAULT_EPG_URL;
  }
  if (stored === LEGACY_DEFAULT_EPG_URL) {
    localStorage.removeItem(STORAGE_KEY);
    return DEFAULT_EPG_URL;
  }
  return stored;
}

/** 保存节目单地址；传入空串表示恢复默认（清空本地存储）。 */
export function setEpgUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, trimmed);
}
