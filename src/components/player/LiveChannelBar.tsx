import ChannelLogo from "../ChannelLogo";
import IconButton from "../IconButton";

interface LiveChannelBarProps {
  /** 频道名（与 LivePage 列表一致，台标按名猜源）。 */
  channelName: string;
  /** 线路总数：>1 时在信息条上给出可点的线路切换。 */
  lineCount?: number;
  /** 当前线路序号（0 基）。 */
  lineIndex?: number;
  /** 点某条线路：立即换线；视频没加载出来时同样可用。 */
  onPickLine?: (index: number) => void;
  /** 外部播放开关关闭时由调用方传 undefined，按钮整体不渲染。 */
  onPlayExternal?: () => void;
}

/**
 * 直播播放页的频道信息条：台标 + 频道名 + 线路切换 + 外部播放。
 *
 * 直播没有海报 / 年份 / 简介 / 换源这些 VOD 概念，复用 PlayerAbout 会在
 * 海报位渲染一个永远「无封面」的死占位、正文区大片空白——所以直播态用这条
 * 轻量信息条替换整张影片卡，节目单（LiveEpgPanel）紧随其下。
 *
 * 线路切换**必须放在这里**：控制栏里的 selector 是 ArtPlayer 实例创建后才有
 * 的控件，线路卡住 / 视频没出画时用户恰好最需要换线，却点不到那个按钮。
 * 信息条是纯 React 的，任何加载状态下都能点。
 */
export default function LiveChannelBar({
  channelName,
  lineCount = 0,
  lineIndex = 0,
  onPickLine,
  onPlayExternal,
}: LiveChannelBarProps) {
  const multi = lineCount > 1 && Boolean(onPickLine);
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
          <span className="live-bar__onair">正在直播</span>
          {multi ? (
            <span className="live-bar__lines" role="group" aria-label="切换线路">
              {Array.from({ length: lineCount }, (_, index) => (
                <button
                  key={index}
                  type="button"
                  className={index === lineIndex ? "live-line is-active" : "live-line"}
                  aria-pressed={index === lineIndex}
                  onClick={() => onPickLine?.(index)}
                  title={`切换到线路 ${index + 1}`}
                >
                  线路 {index + 1}
                </button>
              ))}
            </span>
          ) : null}
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
