/**
 * 电子节目单（EPG）地址的应用级设置。
 *
 * 做成独立的应用设置（localStorage）而非 ConfigSnapshot 字段：节目单对所有直播
 * 源通用，且配置快照是「派生只读」的，手动改会跟 imported/runtime 分裂。这里
 * 与 liveMemory 同思路——轻量、跨重启持久、不污染配置。
 *
 * 默认地址指向 GitHub 上一个公开 XMLTV 仓库；用户可在设置页导入任意节目单地址
 * 覆盖（清空则回落到默认）。
 */
const STORAGE_KEY = "luma:epg:url";

/**
 * 默认节目单地址：GitHub 上的公开 XMLTV 仓库
 * （BurningC4/Chinese-IPTV 的 guide.xml，标准 xmltv 格式，每日更新）。
 * 仅作开箱即用的示例，用户可在设置里替换为任意节目单地址。
 */
export const DEFAULT_EPG_URL =
  "https://raw.githubusercontent.com/BurningC4/Chinese-IPTV/master/guide.xml";

/** 读取当前节目单地址；未设置时返回默认 GitHub 仓库地址。 */
export function getEpgUrl(): string {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored && stored.trim() ? stored.trim() : DEFAULT_EPG_URL;
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
