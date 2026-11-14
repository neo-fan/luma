import { Suspense, lazy } from "react";
import Spinner from "../Spinner";
import { navBack, navNavigate } from "../../lib/nav";
import { canFailover } from "../../lib/format";
import { useSiteState } from "../../stores/appStore";
import type { PlaySession } from "../../stores/appStore";

/**
 * 播放器常驻层：挂在 AppShell（不是路由页）里，`active=false` 时只隐藏不卸载。
 *
 * 需求（2026-11-14 用户）：播放页独立成一个导航入口，切到首页/搜索/设置时
 * 视频继续播，随时能切回来。做法上必须**保留同一个 DOM 与同一个播放实例**：
 * 走 display:none 或卸载都会让 hls.js 重新拉流、进度归零，切换回来就是重播。
 * 所以隐藏用 `visibility: hidden`（媒体继续解码），见 `.player-host.is-idle`。
 */
const PlayerPage = lazy(() => import("../../pages/PlayerPage"));

interface PlayerHostProps {
  session: PlaySession;
  /** 当前是否停在播放路由：false 时隐藏但保持播放。 */
  active: boolean;
}

export default function PlayerHost({ session, active }: PlayerHostProps) {
  const { sites } = useSiteState();
  const site = sites.find((item) => item.key === session.siteKey);
  return (
    <div className={active ? "player-host" : "player-host is-idle"} aria-hidden={!active}>
      <Suspense
        fallback={
          <section className="page">
            <Spinner label="正在打开播放页…" />
          </section>
        }
      >
        <PlayerPage
          // 换源 / 切集 / 切线路必须换 key 整页重挂载：否则旧 ArtPlayer / hls.js
          // 与新地址交错，出现「只有声音没画面」或双流双声（历史踩坑）。
          key={`${session.siteKey}:${session.vodId}:${session.playUrl}`}
          siteKey={session.siteKey}
          vodId={session.vodId}
          vodName={session.vodName}
          episodeName={session.episodeName}
          playUrl={session.playUrl}
          playFrom={session.playFrom}
          liveUa={session.ua}
          liveLines={session.liveLines}
          liveLine={session.liveLine}
          liveSource={session.liveSource}
          failoverKey={session.failoverKey}
          allowFailover={canFailover(site)}
          // 后台会话不再自动换线/换源：失败自愈只有用户停在播放页时才有意义。
          // 常驻层上线后发现了它的副作用——后台失败会话触发自动换线时会把
          // 当前路由整个拽走（用户正在别的页面，突然被跳回播放页）。
          active={active}
          sites={sites}
          siteName={site?.name}
          navigate={navNavigate}
          onBack={navBack}
        />
      </Suspense>
    </div>
  );
}
