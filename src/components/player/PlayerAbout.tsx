import IconButton from "../IconButton";
import VodMetaHero from "../VodMetaHero";
import type { DoubanMeta } from "../../lib/douban";
import { lineLabel } from "../../lib/format";
import type { VodInfo } from "../../types/luma";

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
  /**
   * 目录还在读取：简介区显示「正在读取」，而不是一个没有封面、没有简介的空壳。
   * 这与播放地址解析无关——地址失败时这里仍可能正在读，或已经读到。
   */
  loading?: boolean;
  /** 目录读取失败的原因：在简介位显示，并给一个「重试」出口。 */
  detailError?: string;
  onRetryDetail?: () => void;
  /** 换源：与剧集列表是否有数据无关，必须始终可用（数据不在时它是唯一出路）。 */
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
  loading = false,
  detailError = "",
  onRetryDetail,
  onSwitchSource,
  onPlayExternal,
}: PlayerAboutProps) {
  /**
   * 简介位的兜底文案分三种：读取中 / 读取失败 / 有详情但源站没写简介。
   * 三者要能区分，空白会把「还没到」和「没了」混成一种。
   */
  const descriptionFallback = loading
    ? "正在读取影片详情…"
    : detailError
      ? `影片信息获取失败：${detailError}`
      : undefined;
  return (
    <VodMetaHero
      variant="player"
      vod={vod}
      douban={douban}
      fallbackName={fallbackName}
      posterPlaceholder={loading ? "读取中" : detailError ? "未获取" : "无封面"}
      descriptionFallback={descriptionFallback}
      titleActions={
        onSwitchSource || onPlayExternal || (detailError && onRetryDetail) ? (
          <>
            {detailError && onRetryDetail ? (
              <IconButton name="refresh" label="重试读取详情" onClick={onRetryDetail} />
            ) : null}
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
              {/* 线路名可能带源站的防抓取装饰字符，只清展示、不动数据。 */}
              {lineLabel(lineName)}
              {episodeLabel ? ` · ${episodeLabel}` : ""}
            </span>
          ) : null}
        </>
      }
    />
  );
}
