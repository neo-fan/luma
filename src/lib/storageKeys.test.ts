/**
 * 存储键登记表契约（src/lib/storageKeys.ts）。
 *
 * 锁两件事：
 * 1. 每个键的字符串值——这些值是对外契约（探针 / 测试按字面量读写 localStorage），
 *    改一个字面量就会破坏外部依赖，所以这里钉死；
 * 2. ALL_STORAGE_KEYS 是完整且去重的清单——「清空全部本地数据 / 审计」的单一入口。
 */
import { describe, expect, it } from "vitest";
import {
  ALL_STORAGE_KEYS,
  DOUBAN_PREFS_KEY,
  EPG_URL_KEY,
  FAVORITE_SITES_KEY,
  HOME_SITE_KEY,
  LINE_HEALTH_KEY,
  LIVE_CHANNEL_KEY,
  LIVE_LINES_KEY,
  LIVE_SOURCE_KEY,
  LIVE_SOURCES_KEY,
  NO_DETAIL_SOURCES_KEY,
  PLAYER_PREFS_KEY,
  SEARCH_HISTORY_KEY,
  SIDEBAR_KEY,
  SITE_CACHE_KEY,
} from "./storageKeys";

describe("storage key literals are frozen", () => {
  it("keeps every documented value byte-for-byte", () => {
    expect(SITE_CACHE_KEY).toBe("luma:sites:v1");
    expect(SIDEBAR_KEY).toBe("luma:sidebar:v1");
    expect(HOME_SITE_KEY).toBe("luma:home:site:v1");
    expect(FAVORITE_SITES_KEY).toBe("luma:favorite-sites");
    expect(LINE_HEALTH_KEY).toBe("luma:line:health:v1");
    expect(PLAYER_PREFS_KEY).toBe("luma:player:prefs");
    expect(NO_DETAIL_SOURCES_KEY).toBe("luma:no-detail-sources:v1");
    expect(LIVE_LINES_KEY).toBe("luma:live:lines:v1");
    expect(LIVE_SOURCES_KEY).toBe("luma:live:sources:v1");
    expect(LIVE_CHANNEL_KEY).toBe("luma:live:channel:v1");
    expect(LIVE_SOURCE_KEY).toBe("luma:live:source:v1");
    expect(SEARCH_HISTORY_KEY).toBe("luma:search:history:v1");
    expect(DOUBAN_PREFS_KEY).toBe("luma:douban:prefs");
    expect(EPG_URL_KEY).toBe("luma:epg:url");
  });

  it("lists every key exactly once in ALL_STORAGE_KEYS", () => {
    const singles = [
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
    expect([...ALL_STORAGE_KEYS].sort()).toEqual([...singles].sort());
    expect(new Set(ALL_STORAGE_KEYS).size).toBe(ALL_STORAGE_KEYS.length);
  });

  it("only contains luma:-prefixed keys", () => {
    for (const key of ALL_STORAGE_KEYS) {
      expect(key.startsWith("luma:")).toBe(true);
    }
  });
});
