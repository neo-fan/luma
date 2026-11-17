import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  doubanKey,
  getDoubanFullSnapshot,
  getDoubanSnapshot,
  requestDouban,
  subscribeDouban,
} from "../lib/douban";
import type { DoubanMeta } from "../lib/douban";

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
): DoubanMeta | null {
  const name = (title ?? "").trim();
  const yearText = (year ?? "").trim();
  // key 含代理模式：换代理后落到新槽位，下次请求走新代理（组件重挂载即生效）。
  const key = name ? doubanKey(name, yearText) : "";

  const subscribe = useCallback(
    (cb: () => void) => (key ? subscribeDouban(key, cb) : () => {}),
    [key],
  );
  const getSnapshot = useCallback(() => (key ? read(key) : null), [key, read]);
  const meta = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (enabled && name) {
      requestDouban(name, yearText, priority);
    }
  }, [enabled, name, yearText, priority]);

  return enabled ? meta : null;
}

/** 中间态版：`cover` 相即返回 coarse 资料，卡片靠它早出封面。 */
export default function useDoubanMeta(
  title: string | undefined,
  year: string | undefined,
  enabled = true,
  priority = false,
): DoubanMeta | null {
  return useDoubanSlot(title, year, enabled, priority, getDoubanSnapshot);
}

/** 终态版：只在 `full` 到货后返回，中途始终 null，让同屏字段一次换齐。 */
export function useDoubanFullMeta(
  title: string | undefined,
  year: string | undefined,
  enabled = true,
  priority = false,
): DoubanMeta | null {
  return useDoubanSlot(title, year, enabled, priority, getDoubanFullSnapshot);
}
