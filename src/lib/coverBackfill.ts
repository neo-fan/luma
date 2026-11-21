/**
 * 收藏 / 历史列表的封面回填。
 *
 * 这两张表只存写入时拿得到的字段：播放页写历史可能没带 `vod_pic`，从详情页以外
 * 的路径加入收藏也可能没有封面。封面只有详情接口（`detailContent`）才给，所以由
 * 列表页按需回查一次，把 `pic / remarks / siteName` 补回 SQLite。
 *
 * 两条硬约束：
 * 1. **不回写空值**——补不到就什么都不写，绝不能用空串抹掉已有封面。
 * 2. **不改顺序**——后端 `*_patch_meta` 不动 `updated_at` / `added_at`，
 *    前端也不整表重写，只更新命中的那一项。
 *
 * 网络代价按「分次补齐」控制：每次进页面最多补 `limit` 条、并发 2，失败的项
 * 记 5 分钟冷却，避免对着同一个坏源反复打请求。
 */
import { api } from "./invoke";
import { log } from "./logger";
import type { VodRef } from "../types/luma";

export type CoverKind = "history" | "favorites";

/** 失败冷却：同一部片在这段时间内不再重试。 */
const RETRY_AFTER_MS = 5 * 60_000;
/** 并发上限：详情请求是网络操作，同时压太多源会互相拖慢。 */
const CONCURRENCY = 2;

const attempted = new Map<string, number>();

/** 切换配置后源可能变了，冷却表一起清空。 */
export function clearCoverAttempts(): void {
  attempted.clear();
}

function keyOf(item: VodRef): string {
  return `${item.siteKey}:${item.vodId}`;
}

// 合并规则在 coverMeta（纯函数、可单测），这里只负责网络与写库。
export { mergeMeta } from "./coverMeta";

function eligible(item: VodRef, now: number): boolean {
  if (item.pic?.trim() || !item.vodId.trim()) {
    return false;
  }
  // 直播没有详情接口，封面留空即可。
  if (item.siteKey === "live") {
    return false;
  }
  const last = attempted.get(keyOf(item));
  return last === undefined || now - last > RETRY_AFTER_MS;
}

/**
 * 给列表里缺封面的条目补一次详情。
 *
 * @param onPatched 命中一行时回调补好的字段，调用方据此就地更新列表状态。
 * @returns 实际补上的条数。
 */
export async function backfillCovers(
  items: VodRef[],
  kind: CoverKind,
  onPatched: (patch: VodRef) => void,
  limit = 24,
): Promise<number> {
  const now = Date.now();
  const queue = items.filter((item) => eligible(item, now)).slice(0, Math.max(0, limit));
  if (queue.length === 0) {
    return 0;
  }

  let filled = 0;
  const run = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) {
        return;
      }
      attempted.set(keyOf(item), Date.now());
      try {
        const list = await api.detail(item.siteKey, item.vodId, false, item.name);
        const detail = list && list.length > 0 ? list[0] : null;
        const pic = detail?.vod_pic?.trim() || "";
        // 拿不到封面就到此为止：补个空值只会把库里的好数据冲掉。
        if (!detail || !pic) {
          continue;
        }
        const patch: VodRef = {
          siteKey: item.siteKey,
          vodId: item.vodId,
          name: detail.vod_name?.trim() || item.name,
          pic,
          remarks: detail.vod_remarks?.trim() || "",
          // 详情接口不返回站点名，交给列表里已有的值兜底。
          siteName: "",
        };
        const hit =
          kind === "history"
            ? await api.historyPatchMeta(patch)
            : await api.favoritesPatchMeta(patch);
        if (hit) {
          filled += 1;
          onPatched(patch);
        }
      } catch (err) {
        // 单条补封面失败不影响列表本身，用户照常能点开。
        log.info("cover backfill skipped", {
          siteKey: item.siteKey,
          vodId: item.vodId,
          error: String(err),
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, run));
  return filled;
}
