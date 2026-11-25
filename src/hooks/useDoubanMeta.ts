import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  doubanKey,
  getDoubanFullSnapshot,
  getDoubanSnapshot,
  isDoubanPending,
  requestDouban,
  subscribeDouban,
} from "../lib/douban";
import type { DoubanMeta } from "../lib/douban";

/** 一个豆瓣槽位的完整视图：资料（按消费者口味取中间态或终态）+ 是否在途中。 */
interface DoubanSlot {
  meta: DoubanMeta | null;
  /** 已发请求、还没到终态。给「补全中」提示用，不参与任何布局计算。 */
  pending: boolean;
}

/**
 * 订阅某个片名的豆瓣槽位，到货即重渲染（后端先推 `cover`、再推 `full`）。
 *
 * `read` 决定这个消费者看不看中间态：只关心封面的走 `getDoubanSnapshot`（封面早出），
 * 封面与简介同屏的走 `getDoubanFullSnapshot`（等齐一次到位）。传进来的必须是模块级
 * 稳定函数——它进 `getSnapshot` 的依赖，每次渲染换新引用会让订阅反复重算。
 */
function useDoubanSlot(
  title: string | undefined,
  year: string | undefined,
  enabled: boolean,
  priority: boolean,
  read: (key: string) => DoubanMeta | null,
  subjectId: string | undefined,
): DoubanSlot {
  const name = (title ?? "").trim();
  const yearText = (year ?? "").trim();
  // key 含代理模式：换代理后落到新槽位，下次请求走新代理（组件重挂载即生效）。
  const key = name ? doubanKey(name, yearText, subjectId) : "";

  const subscribe = useCallback(
    (cb: () => void) => (key ? subscribeDouban(key, cb) : () => {}),
    [key],
  );
  const getSnapshot = useCallback(() => (key ? read(key) : null), [key, read]);
  const meta = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // 同一份订阅再取一次在途标记：`requestDouban` 发请求时会 dispatch，
  // 所以提示的出现/消失和资料到货走同一条通知路径，不会各算各的。
  const getPending = useCallback(() => (key ? isDoubanPending(key) : false), [key]);
  const pending = useSyncExternalStore(subscribe, getPending, getPending);

  useEffect(() => {
    if (enabled && name) {
      requestDouban(name, yearText, priority, subjectId);
    }
  }, [enabled, name, yearText, priority, subjectId]);

  return { meta: enabled ? meta : null, pending: enabled && pending };
}

/** 中间态版：`cover` 相即返回 coarse 资料，卡片靠它早出封面。 */
export default function useDoubanMeta(
  title: string | undefined,
  year: string | undefined,
  enabled = true,
  priority = false,
  subjectId?: string,
): DoubanMeta | null {
  return useDoubanSlot(title, year, enabled, priority, getDoubanSnapshot, subjectId).meta;
}

/** 终态版：只在 `full` 到货后返回，中途始终 null，让同屏字段一次换齐。 */
export function useDoubanFullMeta(
  title: string | undefined,
  year: string | undefined,
  enabled = true,
  priority = false,
  subjectId?: string,
): DoubanMeta | null {
  return useDoubanSlot(title, year, enabled, priority, getDoubanFullSnapshot, subjectId).meta;
}

export interface DoubanEnrichmentOptions {
  title: string | undefined;
  year?: string;
  /** 采集库自带的豆瓣 id：有值时后端按 id 直取，跳过搜索那一跳。 */
  subjectId?: string;
  /** 用户正在看的入口传 true，后端把它排到卡片预取前面。 */
  priority?: boolean;
  enabled?: boolean;
}

/**
 * 详情页专用：终态资料 + 在途标记一并给出。
 *
 * 详情页要的不是「早点出一张皮」，而是「这一屏什么时候还会变」——所以它读终态，
 * 并需要知道还在不在途中，好在标题区给出「豆瓣资料补全中」而不是让文字忽然换掉。
 * 参数做成对象是因为这里已经有五个，位置参数在调用点读不出含义。
 */
export function useDoubanEnrichment({
  title,
  year,
  subjectId,
  priority = false,
  enabled = true,
}: DoubanEnrichmentOptions): DoubanSlot {
  return useDoubanSlot(title, year, enabled, priority, getDoubanFullSnapshot, subjectId);
}
