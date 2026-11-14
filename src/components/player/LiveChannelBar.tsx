import ChannelLogo from "../ChannelLogo";
import IconButton from "../IconButton";

interface LiveChannelBarProps {
  /** 频道名（与 LivePage 列表一致，台标按名猜源）。 */
  channelName: string;
  /** 多线路时展示「线路 N/M」；单线路不渲染该段。 */
  lineLabel?: string;
  /** 外部播放开关关闭时由调用方传 undefined，按钮整体不渲染。 */
  onPlayExternal?: () => void;
}

/**
 * 直播播放页的频道信息条：台标 + 频道名 + 当前线路 + 外部播放。
 *
 * 直播没有海报 / 年份 / 简介 / 换源这些 VOD 概念，复用 PlayerAbout 会在
 * 海报位渲染一个永远「无封面」的死占位、正文区大片空白——所以直播态用这条
 * 轻量信息条替换整张影片卡，节目单（LiveEpgPanel）紧随其下。
 */
export default function LiveChannelBar({
  channelName,
  lineLabel,
  onPlayExternal,
}: LiveChannelBarProps) {
  return (
    <section className="live-bar">
      <div className="live-bar__logo">
        <ChannelLogo name={channelName} size={36} />
      </div>
      <div className="live-bar__body">
        <h2 className="live-bar__title" title={channelName}>
          {channelName}
        </h2>
        <p className="live-bar__meta">
          {lineLabel ? <span className="live-bar__line">{lineLabel}</span> : null}
          <span className="live-bar__onair">正在直播</span>
        </p>
      </div>
      <div className="live-bar__actions">
        {onPlayExternal ? (
          <IconButton name="external" label="外部播放" onClick={onPlayExternal} />
        ) : null}
      </div>
    </section>
  );
}
