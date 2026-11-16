/**
 * 本地存储键登记表（单一真源）。
 *
 * 目的：把所有散落在各模块里的 `luma:*` localStorage 键名收拢成一份常量表，
 * 让「审计本地数据」与「清空全部本地数据」有一个统一入口——新增/改名只需
 * 改这里，`ALL_STORAGE_KEYS` 永远是当前持久化键的完整清单。
 *
 * 约束（重要）：
 * - 这里的字符串值就是实际落盘的键名，**绝对不许改**——窗口探针
 *   （`tools/probes/*.mjs`）与多个测试直接按字面量读写 localStorage，
 *   改值等于破坏外部契约。本模块只是把「同值字面量」集中定义一次。
 * - 只收录**持久化**的 localStorage 键。一次性跨页交接用的 sessionStorage
 *   键（如播放页 `luma:autoSwitch`）不属于「本地数据」，不进这张表。
 * - 日志前缀里的 `luma:${level}`（`lib/logger.ts`）不是存储键，同样不收录。
 * - 页面级内存缓存键（`usePageState` 的 `home:${siteKey}:data:v2` 等）是进程内
 *   LRU，不写磁盘，也不属于本地持久化数据，故不在这里登记。
 */

/** 最近一次导入的站点列表缓存（configId + sites + lives）。 */
export const SITE_CACHE_KEY = "luma:sites:v1";
/** 侧栏折叠状态。 */
export const SIDEBAR_KEY = "luma:sidebar:v1";
/** 首页选中的站点（手动切换 + 空站自动顺延都写这里）。 */
export const HOME_SITE_KEY = "luma:home:site:v1";
/** 站点级收藏（常用源）。 */
export const FAVORITE_SITES_KEY = "luma:favorite-sites";
/** 线路健康记录（坏 / 好标记）。 */
export const LINE_HEALTH_KEY = "luma:line:health:v1";
/** 播放偏好（音量 / 倍速 / 静音 / 上次清晰度）。 */
export const PLAYER_PREFS_KEY = "luma:player:prefs";
/** 「无详情源」记忆（带配置 scope）。 */
export const NO_DETAIL_SOURCES_KEY = "luma:no-detail-sources:v1";
/** 直播线路偏好记忆（频道上次用哪条线路）。 */
export const LIVE_LINES_KEY = "luma:live:lines:v1";
/** 直播源地址记忆（sourceKey → url/ua/name）。 */
export const LIVE_SOURCES_KEY = "luma:live:sources:v1";
/** 上次看的直播频道（按 sourceKey 记 name + line）。 */
export const LIVE_CHANNEL_KEY = "luma:live:channel:v1";
/** 上次选中的直播源 sourceKey。 */
export const LIVE_SOURCE_KEY = "luma:live:source:v1";
/** 最近搜索词。 */
export const SEARCH_HISTORY_KEY = "luma:search:history:v1";
/** 豆瓣信息补全的本地设置。 */
export const DOUBAN_PREFS_KEY = "luma:douban:prefs";
/** 电子节目单（EPG）地址的应用级设置。 */
export const EPG_URL_KEY = "luma:epg:url";

/**
 * 全部持久化 localStorage 键。
 *
 * 「清空全部本地数据」按这张表逐项 `removeItem` 即可（本任务不实现清空功能，
 * 只建立单一入口）。新增任何持久化键都必须同时出现在这里，否则审计会漏。
 */
export const ALL_STORAGE_KEYS: readonly string[] = [
  SITE_CACHE_KEY,
  SIDEBAR_KEY,
  HOME_SITE_KEY,
  FAVORITE_SITES_KEY,
  LINE_HEALTH_KEY,
  PLAYER_PREFS_KEY,
  NO_DETAIL_SOURCES_KEY,
  LIVE_LINES_KEY,
  LIVE_SOURCES_KEY,
  LIVE_CHANNEL_KEY,
  LIVE_SOURCE_KEY,
  SEARCH_HISTORY_KEY,
  DOUBAN_PREFS_KEY,
  EPG_URL_KEY,
];
