import IconButton from "../IconButton";
import VodMetaHero from "../VodMetaHero";
import type { DoubanMeta } from "../../lib/douban";
import type { VodInfo } from "../../types/tvbox";

interface PlayerAboutProps {
  vod: VodInfo | null;
  /** 详情还没回来时的片名兜底（路由参数）。 */
  fallbackName: string;
  siteKey: string;
  siteName?: string;
  /** 当前线路名，展示成「正在播放：线路 · 第 N 集」。 */
  lineName?: string;
  episodeLabel?: string;
  /** 豆瓣补全结果：命中时元数据用豆瓣，源站只负责播放链路。 */
  douban?: DoubanMeta | null;
  /** 直播频道没有「换源」概念，传 undefined 即不渲染该按钮。 */
  onSwitchSource?: () => void;
  /** 外部播放开关关闭时由调用方传 undefined，按钮整体不渲染。 */
  onPlayExternal?: () => void;
}

/**
 * 播放器下方的影片信息卡：复用详情页同一个 `VodMetaHero`，保证两处元数据
 * 口径一致（豆瓣优先、源站兜底，海报源站优先、豆瓣兜底）。换源 / 外部播放
 * 放在片名右侧；详情拿不到时至少显示片名与站点，不留白板。
 */
export default function PlayerAbout({
  vod,
  fallbackName,
  siteKey,
  siteName,
  lineName,
  episodeLabel,
  douban,
  onSwitchSource,
  onPlayExternal,
}: PlayerAboutProps) {
  return (
    <VodMetaHero
      variant="player"
      vod={vod}
      douban={douban}
      fallbackName={fallbackName}
      posterPlaceholder="无封面"
      titleActions={
        onSwitchSource || onPlayExternal ? (
          <>
            {onSwitchSource ? (
              <IconButton name="swap" label="换源" onClick={onSwitchSource} />
            ) : null}
            {onPlayExternal ? (
              <IconButton
                name="external"
                label="外部播放"
                onClick={onPlayExternal}
              />
            ) : null}
          </>
        ) : null
      }
      meta={
        <>
          <span className="detail-source" title={siteKey}>
            {siteName || siteKey}
          </span>
          {lineName ? (
            <span className="player-about__now">
              {lineName}
              {episodeLabel ? ` · ${episodeLabel}` : ""}
            </span>
          ) : null}
        </>
      }
    />
  );
}
