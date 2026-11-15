interface PlayerSwitchVeilProps {
  /** 幕上那行字，例如「正在切换到「线路名」…」。 */
  label: string;
  /** 新画面可以出画了：从全黑淡出，露出播放器。 */
  revealing: boolean;
}

/**
 * 手动换集 / 换线路 / 换源时的过渡幕。
 *
 * 只负责画，时序在 `PlayerPage`：旧页先压暗（180ms）再导航，新页等
 * `playable` 后切成 `is-revealing` 淡出（300ms）。不用全屏 spinner，
 * 只放一行说明 + 一枚呼吸点 —— 这段时间通常不到一秒，信息越少越不打断。
 */
export default function PlayerSwitchVeil({ label, revealing }: PlayerSwitchVeilProps) {
  return (
    <div className={revealing ? "player-veil is-revealing" : "player-veil"} aria-live="polite">
      <span className="player-veil__pulse" aria-hidden="true" />
      <p className="player-veil__label">{label}</p>
    </div>
  );
}
