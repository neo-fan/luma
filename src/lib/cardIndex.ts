/**
 * 列表卡片的内存索引：详情页在「源不提供详情」时用它回填海报/片名/评分。
 *
 * 为什么需要它：TVBox 生态里有一类**纯发现型源**（豆瓣[py] 是典型），
 * `homeVideoContent` / `categoryContent` 正常出海报墙，但 `detailContent`
 * 直接 `return {"list": []}`。这类源点进详情页原本只剩一句「没有播放列表」，
 * 而卡片上其实带着海报、评分、年份——那是这个源能提供的全部信息，不该丢。
 *
 * 设计取舍：
 * - **只存轻字段**：不要整份 `VodInfo`（含 `vod_play_url` 这种长串），否则
 *   一次聚合搜索 200 条 × 多站就会钉住可观内存。
 * - **只做 fallback**：详情页只在 detailContent 返回空时才来查，命中与否都
 *   不影响正常源；索引本身不参与任何判断。
 * - **进程内、不落盘**：它是「用户刚才看过这张卡」的副产品，重启后重建即可，
 *   没有跨会话价值。
 */

import type { VodInfo } from "../types/luma";

/** 单站单卡一行；`at` 用于过期淘汰，Map 的插入顺序用于容量淘汰。 */
interface CardEntry {
  at: number;
  vod: VodInfo;
}

/** 上限按「几屏海报墙」估：够回填当前会话，又不至于让长逛用户无界增长。 */
const MAX_ENTRIES = 3000;
/** 6 小时：用户逛完榜单再回头点卡片的典型间隔远小于此。 */
const TTL_MS = 6 * 60 * 60 * 1000;

const index = new Map<string, CardEntry>();

function keyOf(siteKey: string, vodId: string): string {
  return `${siteKey}:${String(vodId ?? "").trim()}`;
}

/**
 * 详情页回填只用到这几个字段；其余（播放串、演员表）不复制。
 * `vod_douban_id` 必须带上：从卡片进详情/播放页是主路径，丢了它豆瓣富化就只能
 * 走标题匹配（按 id 直取少一跳，且更准）。
 */
function slim(vod: VodInfo, vodId: string): VodInfo {
  return {
    vod_id: vodId,
    vod_name: vod.vod_name || "",
    vod_pic: vod.vod_pic || "",
    vod_remarks: vod.vod_remarks,
    vod_year: vod.vod_year,
    vod_area: vod.vod_area,
    vod_douban_id: vod.vod_douban_id,
    type_name: vod.type_name,
    vod_play_from: "",
    vod_play_url: "",
  };
}

/**
 * 把一次列表结果（首页推荐 / 分类页 / 搜索结果）记进索引。
 * 无 id 的条目跳过：详情页永远按 id 查，记了也没用。
 */
export function rememberCards(siteKey: string, list: readonly VodInfo[] | null | undefined): void {
  if (!siteKey || !list || list.length === 0) {
    return;
  }
  const now = Date.now();
  for (const vod of list) {
    const vodId = String(vod?.vod_id ?? "").trim();
    if (!vodId) {
      continue;
    }
    // 重复出现（翻页回看、换分类）时覆盖，Map 顺序保持不变会造成「旧卡
    // 一直不过期」，所以先删再插，让它回到队尾。
    const key = keyOf(siteKey, vodId);
    index.delete(key);
    index.set(key, { at: now, vod: slim(vod, vodId) });
  }
  while (index.size > MAX_ENTRIES) {
    const oldest = index.keys().next();
    if (oldest.done) {
      break;
    }
    index.delete(oldest.value);
  }
}

/** 详情页回填：命中返回轻量卡片，未命中或已过期返回 null。 */
export function recallCard(siteKey: string, vodId: string): VodInfo | null {
  const key = keyOf(siteKey, vodId);
  const hit = index.get(key);
  if (!hit) {
    return null;
  }
  if (Date.now() - hit.at > TTL_MS) {
    index.delete(key);
    return null;
  }
  return hit.vod;
}

/**
 * 切配置 / 清会话缓存时调用。传 siteKey 只清该站，不传全清。
 * 索引里没有站点之外的上下文，配置换了以后旧 key 的卡片会一直留着，
 * 所以换配置必须全清。
 */
export function forgetCards(siteKey?: string): void {
  if (!siteKey) {
    index.clear();
    return;
  }
  const prefix = `${siteKey}:`;
  for (const key of Array.from(index.keys())) {
    if (key.startsWith(prefix)) {
      index.delete(key);
    }
  }
}

/** 测试与探针用：当前索引条目数。 */
export function cardIndexSize(): number {
  return index.size;
}
