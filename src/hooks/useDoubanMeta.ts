import { useCallback, useEffect, useSyncExternalStore } from "react";
import { doubanKey, getDoubanSnapshot, requestDouban, subscribeDouban } from "../lib/douban";
import type { DoubanMeta } from "../lib/douban";

/**
 * 列表/头图按需补豆瓣元数据：enabled=false 时不发请求（懒加载由调用方判断视口）。
 *
 * 走后端 push 的中心 store：`requestDouban` 触发一次富化，后端先推 `cover`
 * （封面）、再推 `full`（评分/简介）；这里用 `useSyncExternalStore` 订阅该 key，
 * 到货即重渲染，所以头图能「封面先出、详情后补」，无需前端发两个请求。
 * 片名变化先清快照（store 按 key 分槽，天然隔离上一部片的数据）。
 */
export default function useDoubanMeta(
  title: string | undefined,
  year: string | undefined,
  enabled = true,
  priority = false,
): DoubanMeta | null {
  const name = (title ?? "").trim();
  const yearText = (year ?? "").trim();
  // key 含代理模式：换代理后落到新槽位，下次请求走新代理（组件重挂载即生效）。
  const key = name ? doubanKey(name, yearText) : "";

  const subscribe = useCallback(
    (cb: () => void) => (key ? subscribeDouban(key, cb) : () => {}),
    [key],
  );
  const getSnapshot = useCallback(() => (key ? getDoubanSnapshot(key) : null), [key]);
  const meta = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (enabled && name) {
      requestDouban(name, yearText, priority);
    }
  }, [enabled, name, yearText, priority]);

  return enabled ? meta : null;
}
