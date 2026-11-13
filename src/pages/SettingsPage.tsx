import { useState } from "react";
import ErrorBar from "../components/ErrorBar";
import ConfigImportSection from "../components/settings/ConfigImportSection";
import ConfigListSection from "../components/settings/ConfigListSection";
import DiagnosticSection from "../components/settings/DiagnosticSection";
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

/**
 * 设置页只做编排：持有跨 section 共享的 error / notice，把导入、配置管理、反代、
 * 站点体检、诊断、历史各自拆成独立 section 组件（见 components/settings/*），
 * 每个 section 自管自己的加载/错误状态，互不耦合。
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

  return (
    <section className="page">
      <header className="page-head">
        <h1 className="page-title">设置</h1>
      </header>

      {error ? <ErrorBar message={error} /> : null}
      {notice ? <p className="tip tip--ok">{notice}</p> : null}

      <ConfigImportSection
        onImported={onImported}
        onNotice={setNotice}
        onError={setError}
        onReload={bumpReload}
      />
      <ConfigListSection
        activeConfigId={activeConfigId}
        onImported={onImported}
        onConfigRemoved={onConfigRemoved}
        onNotice={setNotice}
        onError={setError}
        reload={reload}
        onReload={bumpReload}
      />
      <ProxySection reload={reload} />
      <HealthCheckSection
        sites={sites}
        activeConfigId={activeConfigId}
        onImported={onImported}
      />
      <DiagnosticSection reload={reload} />
      <HistorySection onError={setError} onNotice={setNotice} />

      <p className="disclaimer">本软件为播放框架，不提供任何片源。</p>
    </section>
  );
}
