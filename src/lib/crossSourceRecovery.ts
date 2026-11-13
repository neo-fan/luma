/**
 * 发现型源的跨源自愈。
 *
 * 有些源（典型如「豆瓣[py]」）只实现 homeContent / homeVideoContent / 分类，
 * 卡片里的 `vod_id` 是豆瓣条目号，既不提供 `detailContent`，也不提供搜索 ——
 * `api.detail` 的**同站按名回查**对它们必然无效（searchContent 同样返回空）。
 * 这类源的价值是「发现片子」，播放必须在别的站点完成。
 *
 * 因此：详情页拿到空 list 时，用片名走一次已有的全站聚合检索（与换源面板
 * 共用 sourceCache，不会重复扇出），再并发探几个高分候选的详情，找一个
 * 真的带播放列表的源直接切过去。全部失败就留在错误页，由用户手动换源。
 */
import { parsePlayLines } from "./format";
import { api } from "./invoke";
import { ensureSources } from "./sourceCache";
import type { SourceOption } from "./sources";
import type { Site } from "../types/tvbox";

/** 最多探 6 个候选：足够覆盖常见「前几个源都只是推荐位」的情况，又不拖慢首屏。 */
const MAX_PROBES = 6;
/** 与 sourceCache.view 一致的门槛：只认精确/包含片名，弱相关会把人送到别的片子。 */
const MIN_MATCH_SCORE = 2;
/**
 * 自愈只等 8 秒，而不是面板那套 20 秒全站预算。
 *
 * 目标只是「找到一个能播的源」，不需要等齐所有慢站；实测真实配置里大部分
 * 站点在几秒内就有回包，等满 20 秒只是被少数超时站拖住（日志里一次完整的
 * 自愈要 21 秒，用户盯着错误页太久）。结果按 partial 入缓存，不标「已完整
 * 检索」，后台 prefetch 仍会补一次全量，换源面板不受影响。
 */
const RECOVERY_BUDGET_MS = 8_000;

export interface CrossSourceResult {
  found: SourceOption | null;
  probed: number;
}

/**
 * 按片名在其它站点里找一个「能播」的详情。
 * `isAlive` 让卸载 / 用户手动操作可以随时中止探测，避免迟到的结果突然跳页。
 */
export async function findPlayableSource(
  title: string,
  sites: readonly Site[],
  excludeSiteKey: string,
  isAlive: () => boolean = () => true,
): Promise<CrossSourceResult> {
  const word = title.trim();
  if (!word || !isAlive()) {
    return { found: null, probed: 0 };
  }

  // 复用详情页 / 换源面板的后台预取：ensure 会共享同一个 in-flight Promise。
  const view = await ensureSources(word, sites, excludeSiteKey, {
    timeoutMs: RECOVERY_BUDGET_MS,
    partial: true,
  });
  if (!isAlive()) {
    return { found: null, probed: 0 };
  }
  const candidates = view.options
    .filter(
      (option) =>
        option.siteKey !== excludeSiteKey &&
        option.vodId.trim() !== "" &&
        option.matchScore >= MIN_MATCH_SCORE,
    )
    .slice(0, MAX_PROBES);

  let cursor = 0;
  let winner: SourceOption | null = null;
  let probed = 0;
  const worker = async () => {
    while (cursor < candidates.length && !winner && isAlive()) {
      const option = candidates[cursor];
      cursor += 1;
      probed += 1;
      try {
        // 不传片名：这里要的是「这个 id 到底有没有剧集」，不要再触发同站回查。
        const list = await api.detail(option.siteKey, option.vodId);
        const info = list?.[0];
        const lines = info
          ? parsePlayLines(info.vod_play_from, info.vod_play_url)
          : [];
        if (lines.length > 0 && lines.some((line) => line.episodes.length > 0)) {
          winner = option;
        }
      } catch {
        // 单个候选失败不影响其它候选。
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return { found: isAlive() ? winner : null, probed };
}
