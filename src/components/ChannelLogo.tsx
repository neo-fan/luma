import { useEffect, useMemo, useState } from "react";
import { channelLogoUrls } from "../lib/channelLogo";

interface ChannelLogoProps {
  /** 频道名（列表里的显示名，如 `CCTV1` / `东方卫视4K`）。 */
  name: string;
  /** 源里 `tvg-logo` 给的真实地址；有则优先，猜名只作兜底。 */
  logo?: string;
  /** 边长（px）。列表里 18，标题旁 20。 */
  size?: number;
  className?: string;
}

/**
 * 频道台标。
 *
 * 候选清单由 `lib/channelLogo` 生成，这里只负责「逐个试、失败就换下一个、
 * 全失败就不渲染」。用原生 `<img>` 而不是 `/image` 代理：这些 PNG 不需要
 * 防盗链 header，直连还能吃到 jsDelivr / GitHub 的浏览器缓存。
 *
 * 列表里几百个 chip 都挂这个组件，所以 `loading="lazy"` 必须留——首屏只会
 * 请求真正进入视口的那些台标。
 */
export default function ChannelLogo({ name, logo, size = 18, className }: ChannelLogoProps) {
  const urls = useMemo(() => channelLogoUrls(name, logo), [name, logo]);
  const [index, setIndex] = useState(0);

  // 换频道时组件会被复用（同位置不同数据），失败下标必须重置，
  // 否则新频道会从上一个频道试到一半的位置开始。
  useEffect(() => {
    setIndex(0);
  }, [urls]);

  const src = urls[index] ?? "";
  if (!src) {
    return null;
  }
  return (
    <img
      className={className ? `channel-logo ${className}` : "channel-logo"}
      src={src}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setIndex((prev) => prev + 1)}
    />
  );
}
