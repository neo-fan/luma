import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import ErrorBar from "../components/ErrorBar";
import ConfigImportSection from "../components/settings/ConfigImportSection";
import ConfigListSection from "../components/settings/ConfigListSection";
import DiagnosticSection from "../components/settings/DiagnosticSection";
import EpgsSection from "../components/settings/EpgsSection";
import GhProxySection from "../components/settings/GhProxySection";
import HealthCheckSection from "../components/settings/HealthCheckSection";
import HistorySection from "../components/settings/HistorySection";
import ProxySection from "../components/settings/ProxySection";
import type { ConfigSnapshot, Site } from "../types/tvbox";

interface SettingsPageProps {
  activeConfigId?: string;
  /** 当前运行快照的全部站点（含被屏蔽的禁用站），用于与探测结果合并出体检清单。 */
  sites: Site[];
  onImported: (snapshot: ConfigSnapshot) => void;
  onConfigRemoved: (id: string) => void;
}

/** 左侧目录项：id 同时是滚动锚点。 */
const SECTIONS: { id: string; label: string }[] = [
  { id: "s-import", label: "导入配置" },
  { id: "s-ghproxy", label: "GitHub 加速" },
  { id: "s-configs", label: "配置管理" },
  { id: "s-epgs", label: "直播节目单" },
  { id: "s-proxy", label: "本地反代" },
  { id: "s-health", label: "站点体检" },
  { id: "s-diagnostic", label: "诊断" },
  { id: "s-history", label: "历史" },
];

/**
 * 设置页只做编排：持有跨 section 共享的 error / notice，把导入、配置管理、反代、
 * 站点体检、诊断、历史各自拆成独立 section 组件（见 components/settings/*），
 * 每个 section 自管自己的加载/错误状态，互不耦合。
 *
 * 左侧 180px 吸顶目录（DSH 规格的 SettingNav）：设置页现在有 7 个 block、
 * 纵向超过两屏，目录让「历史 / 诊断」这类深处的 section 一次可达。
 */
export default function SettingsPage({
  activeConfigId,
  sites,
  onImported,
  onConfigRemoved,
}: SettingsPageProps) {
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // 导入 / 切换 / 删除配置后 +1，驱动需要重新拉取数据的 section 刷新。
  const [reload, setReload] = useState(0);
  const bumpReload = () => setReload((value) => value + 1);
  const [activeId, setActiveId] = useState(SECTIONS[0].id);

  const blocks: { id: string; node: ReactNode }[] = [
    {
      id: "s-import",
      node: (
        <ConfigImportSection
          onImported={onImported}
          onNotice={setNotice}
          onError={setError}
          onReload={bumpReload}
        />
      ),
    },
    {
      id: "s-ghproxy",
      node: (
        <GhProxySection
          reload={reload}
          onImported={onImported}
          onNotice={setNotice}
          onError={setError}
        />
      ),
    },
    {
      id: "s-configs",
      node: (
        <ConfigListSection
          activeConfigId={activeConfigId}
          onImported={onImported}
          onConfigRemoved={onConfigRemoved}
          onNotice={setNotice}
          onError={setError}
          reload={reload}
          onReload={bumpReload}
        />
      ),
    },
    { id: "s-epgs", node: <EpgsSection /> },
    { id: "s-proxy", node: <ProxySection reload={reload} /> },
    {
      id: "s-health",
      node: (
        <HealthCheckSection
          sites={sites}
          activeConfigId={activeConfigId}
          onImported={onImported}
        />
      ),
    },
    { id: "s-diagnostic", node: <DiagnosticSection reload={reload} /> },
    { id: "s-history", node: <HistorySection onError={setError} onNotice={setNotice} /> },
  ];

  // 目录高亮跟随滚动：观察每个 block，视口上部 1/3 命中谁就点亮谁。
  useEffect(() => {
    const els = blocks
      .map((block) => document.getElementById(block.id))
      .filter((el): el is HTMLElement => el !== null);
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        }
      },
      { rootMargin: "-15% 0px -75% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
    // blocks 只依赖 reload 带来的 node 变化；锚点 id 恒定，重挂即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="page">
      <header className="page-head">
        <h1 className="page-title">设置</h1>
      </header>

      {error ? <ErrorBar message={error} /> : null}
      {notice ? <p className="tip tip--ok">{notice}</p> : null}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置目录">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                activeId === item.id ? "settings-nav__item is-active" : "settings-nav__item"
              }
              onClick={() =>
                document.getElementById(item.id)?.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                })
              }
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="settings-main">
          {blocks.map((block) => (
            <section key={block.id} id={block.id} className="settings-anchor">
              {block.node}
            </section>
          ))}
        </div>
      </div>

      <p className="disclaimer">本软件为播放框架，不提供任何片源。</p>
    </section>
  );
}
