import { useEffect, useState } from "react";
import { fetchDoubanMeta } from "../lib/douban";
import type { DoubanMeta } from "../lib/douban";

/**
 * 列表/头图按需补豆瓣元数据：enabled=false 时不发请求（懒加载由调用方判断视口）。
 * 片名变化先清空，避免上一部片的评分挂在新片下面。
 */
export default function useDoubanMeta(
  title: string | undefined,
  year: string | undefined,
  enabled = true,
): DoubanMeta | null {
  const [meta, setMeta] = useState<DoubanMeta | null>(null);
  const name = (title ?? "").trim();
  const yearText = (year ?? "").trim();

  useEffect(() => {
    let alive = true;
    // 没开启或没有片名：清掉旧结果，一个请求都不发。
    if (!enabled || !name) {
      setMeta(null);
      return () => {
        alive = false;
      };
    }
    // 换片先清空，否则新片会短暂顶着上一部的评分/类型。
    setMeta(null);
    fetchDoubanMeta(name, yearText || undefined).then((next) => {
      if (alive) {
        setMeta(next);
      }
    });
    return () => {
      alive = false;
    };
  }, [enabled, name, yearText]);

  return meta;
}
