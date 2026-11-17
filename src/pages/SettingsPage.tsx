import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import AppSelect from "../components/AppSelect";
import ErrorBar from "../components/ErrorBar";
import ConfigImportSection from "../components/settings/ConfigImportSection";
import ConfigListSection from "../components/settings/ConfigListSection";
import DiagnosticSection from "../components/settings/DiagnosticSection";
import EpgsSection from "../components/settings/EpgsSection";
import GhProxySection from "../components/settings/GhProxySection";
import HealthCheckSection from "../components/settings/HealthCheckSection";
import StorageSection from "../components/settings/StorageSection";
import ProxySection from "../components/settings/ProxySection";
import {
  DOUBAN_PROXY_OPTIONS,
  readDoubanPrefs,
  writeDoubanPrefs,
  isDoubanProxyType,
} from "../lib/doubanSettings";
import type { DoubanPrefs } from "../lib/doubanSettings";
import type { ConfigSnapshot, Site } from "../types/luma";

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
  { id: "s-douban", label: "豆瓣信息" },
  { id: "s-proxy", label: "本地反代" },
  { id: "s-health", label: "站点体检" },
  { id: "s-diagnostic", label: "诊断" },
  { id: "s-storage", label: "存储与清理" },
];

/**
 * 设置页只做编排：持有跨 section 共享的 error / notice，把导入、配置管理、反代、
 * 站点体检、诊断、存储清理各自拆成独立 section 组件（见 components/settings/*），
 * 每个 section 自管自己的加载/错误状态，互不耦合。
 *
 * 左侧 180px 吸顶目录（DSH 规格的 SettingNav）：设置页现在有 9 个 block、
 * 纵向超过两屏，目录让「存储与清理 / 诊断」这类深处的 section 一次可达。
 *
 * 「豆瓣信息」是唯一不单独建 components/settings/* 的 section：它的状态只有
 * 三个 localStorage 字段（见 `src/lib/doubanSettings.ts`），拆组件反而要为它
 * 多传一层回调。
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

  /**
   * 豆瓣补全偏好：纯前端展示设置，落在 localStorage（不进 Rust、不进配置快照）。
   * 每次改动立即写盘，`src/lib/douban.ts` 在下一次详情请求时就读到新值，
   * 所以「换代理方式」不需要重启或重新进页面。
   */
  const [doubanPrefs, setDoubanPrefs] = useState<DoubanPrefs>(() =>
    readDoubanPrefs(),
  );
  const updateDoubanPrefs = (patch: Partial<DoubanPrefs>) => {
    setDoubanPrefs(writeDoubanPrefs(patch));
  };
  const doubanHint =
    DOUBAN_PROXY_OPTIONS.find((item) => item.value === doubanPrefs.proxyType)
      ?.hint ?? "";
  // 自定义模式却没有前缀时，前端会按直连发（见 src/lib/douban.ts），要说清楚。
  const doubanPrefixMissing =
    doubanPrefs.proxyType === "custom" && doubanPrefs.proxyPrefix.length === 0;

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
    {
      id: "s-douban",
      node: (
        <div className="settings-block">
          <h2 className="section-title">豆瓣信息</h2>
          <p className="settings-line">
            进入详情页时按片名自动补一次豆瓣评分、简介与演职员。豆瓣没匹配上、
            被限流或请求失败都静默跳过——详情页照常用源站信息渲染，不会留下空区块。
          </p>

          <div className="douban-settings">
            {/* 复选框复用 `.filter-toggle` 的自绘样式（原生方框在深色面板上像白点）。 */}
            <label className="filter-toggle douban-settings__switch">
              <input
                type="checkbox"
                checked={doubanPrefs.enabled}
                onChange={(event) =>
                  updateDoubanPrefs({ enabled: event.target.checked })
                }
              />
              <span className="douban-settings__switch-text">
                <span className="douban-settings__switch-label">
                  自动补全豆瓣信息
                </span>
                <span className="douban-settings__switch-note">
                  默认开启。关闭后详情页不再请求豆瓣，区块也不会出现。
                </span>
              </span>
            </label>

            <div className="douban-settings__row">
              <span className="douban-settings__label">请求方式</span>
              <AppSelect
                ariaLabel="豆瓣请求方式"
                value={doubanPrefs.proxyType}
                options={DOUBAN_PROXY_OPTIONS.map((item) => ({
                  value: item.value,
                  label: item.label,
                }))}
                disabled={!doubanPrefs.enabled}
                onChange={(value) => {
                  if (isDoubanProxyType(value)) {
                    updateDoubanPrefs({ proxyType: value });
                  }
                }}
              />
            </div>
            <p className="settings-line douban-settings__hint">{doubanHint}</p>

            {doubanPrefs.proxyType === "custom" ? (
              <>
                <div className="douban-settings__row">
                  <span className="douban-settings__label">自定义前缀</span>
                  <input
                    className="input douban-settings__input"
                    type="url"
                    value={doubanPrefs.proxyPrefix}
                    placeholder="https://proxy.example/?url="
                    spellCheck={false}
                    autoComplete="off"
                    disabled={!doubanPrefs.enabled}
                    onChange={(event) =>
                      updateDoubanPrefs({ proxyPrefix: event.target.value })
                    }
                  />
                </div>
                {doubanPrefixMissing ? (
                  <p className="settings-line douban-settings__note">
                    还没填前缀：请求会按「直连豆瓣」发出。
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ),
    },
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
    {
      id: "s-storage",
      node: <StorageSection onError={setError} onNotice={setNotice} />,
    },
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

      <div className="page-body">
        {error ? <ErrorBar message={error} /> : null}
        {notice ? <p className="tip tip--ok">{notice}</p> : null}

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置目录">
            {SECTIONS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={
                  activeId === item.id
                    ? "settings-nav__item is-active"
                    : "settings-nav__item"
                }
                onClick={() => {
                  // 减弱动效时降级为瞬时定位：平滑滚动不在全局动画降级范围内。
                  const behavior: ScrollBehavior = window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                  ).matches
                    ? "auto"
                    : "smooth";
                  document.getElementById(item.id)?.scrollIntoView({
                    behavior,
                    block: "start",
                  });
                }}
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
      </div>
    </section>
  );
}
