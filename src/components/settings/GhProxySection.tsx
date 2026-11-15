import { useEffect, useState } from "react";
import ErrorBar from "../ErrorBar";
import { api, errorMessage } from "../../lib/invoke";
import type { ConfigSnapshot, GhProbeResult, GhProxyState } from "../../types/luma";

interface GhProxySectionProps {
  /** 父级 reload 计数：换了配置后重新读一次前缀。 */
  reload: number;
  /** 切换代理会改写 active 快照里的 URL，必须整份替换前端站点缓存。 */
  onImported: (snapshot: ConfigSnapshot) => void;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}

/** 200 · 320ms 这种紧凑写法；超时/失败只给「失败」。 */
function probeLabel(probe: GhProbeResult): string {
  if (!probe.ok) {
    return probe.status === 0 ? "不可用" : `HTTP ${probe.status}`;
  }
  const ms = probe.ms >= 1000 ? `${(probe.ms / 1000).toFixed(1)}s` : `${probe.ms}ms`;
  return `${ms}`;
}

/**
 * GitHub 加速：导入配置时把 JSON 里的 GitHub 链接改写成代理地址。
 *
 * 为什么放在导入期而不是请求期：TVBox 配置里 `ext` / `jar` / `spider` 是
 * 字符串，改写后整条链路（qjs 相对 import、jar 下载、封面代理）都自然走
 * 代理，不需要每层再判一次。代价是切换代理要重写已存配置——这一点由后端
 * `gh_proxy_set` 一次做完，前端只负责换缓存。
 */
export default function GhProxySection({
  reload,
  onImported,
  onNotice,
  onError,
}: GhProxySectionProps) {
  const [state, setState] = useState<GhProxyState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [probes, setProbes] = useState<Record<string, GhProbeResult>>({});
  const [custom, setCustom] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await api.ghProxyState();
        if (!alive) return;
        setState(next);
        setLoadError("");
        // 当前前缀不在内置候选里 = 用户自定义过，回填到输入框。
        if (next.prefix && !next.choices.some((choice) => choice.prefix === next.prefix)) {
          setCustom(next.prefix);
        }
      } catch (err) {
        if (alive) setLoadError(errorMessage(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [reload]);

  const apply = async (prefix: string, label: string) => {
    if (busy) return;
    // 不能直接用 prefix 当忙标志：「直连」的前缀是空串，会和「空闲」撞车，
    // 表现为直连行永远显示「切换中…」。加前缀区分两类忙状态。
    setBusy(`switch:${prefix}`);
    try {
      const next = await api.ghProxySet(prefix);
      setState(next);
      if (next.snapshot) {
        onImported(next.snapshot);
      }
      onError("");
      onNotice(
        next.changed > 0
          ? `已切到 ${label}：改写 ${next.changed} 个配置、共 ${next.links} 条 GitHub 链接`
          : `已切到 ${label}：链接本来就是目标地址，无需改写`,
      );
    } catch (err) {
      onError(`切换加速代理失败：${errorMessage(err)}`);
    } finally {
      setBusy("");
    }
  };

  const probeAll = async () => {
    if (busy) return;
    setBusy("probe");
    try {
      const results = await api.ghProxyTest();
      const map: Record<string, GhProbeResult> = {};
      for (const result of results) {
        map[result.id] = result;
      }
      setProbes(map);
      onError("");
    } catch (err) {
      onError(`测速失败：${errorMessage(err)}`);
    } finally {
      setBusy("");
    }
  };

  const choices = state?.choices ?? [];
  const current = state?.prefix ?? "";
  const isCustom = current !== "" && !choices.some((choice) => choice.prefix === current);

  return (
    <div className="settings-block">
      <h2 className="section-title">GitHub 加速</h2>
      <p className="settings-line">
        导入配置时把 JSON 里的 GitHub 链接（raw / release / archive）改写成加速地址。
        只改 github.com 与 raw.githubusercontent.com 等 GitHub 域名，
        其它站点、你自己的接口一律不动。
      </p>

      {loadError ? <ErrorBar message={`加速设置读取失败：${loadError}`} /> : null}

      <div className="gh-proxy-list">
        {choices.map((choice) => {
          const probe = probes[choice.id];
          const active = current === choice.prefix;
          return (
            <label
              key={choice.id}
              className={active ? "gh-proxy__row is-active" : "gh-proxy__row"}
            >
              <input
                type="radio"
                name="gh-proxy"
                checked={active}
                disabled={busy !== ""}
                onChange={() => void apply(choice.prefix, choice.label)}
              />
              <span className="gh-proxy__main">
                <span className="gh-proxy__label">{choice.label}</span>
                <span className="gh-proxy__note">{choice.note}</span>
              </span>
              {/* 直连行的 label 已经写了「直连 GitHub」，前缀列再写一遍是重复 */}
              <code className="gh-proxy__prefix">{choice.prefix || "—"}</code>
              <span
                className={
                  probe
                    ? probe.ok
                      ? "gh-proxy__probe is-ok"
                      : "gh-proxy__probe is-bad"
                    : "gh-proxy__probe"
                }
                title={probe?.error ?? undefined}
              >
                {busy === `switch:${choice.prefix}` ? "切换中…" : probe ? probeLabel(probe) : ""}
              </span>
            </label>
          );
        })}
      </div>

      <div className="gh-proxy-custom">
        <input
          className="input"
          type="text"
          value={custom}
          placeholder="自定义前缀，例如 https://your-proxy.example/"
          aria-label="自定义 GitHub 加速前缀"
          onChange={(event) => setCustom(event.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={busy !== "" || custom.trim() === "" || custom.trim() === current}
          onClick={() => void apply(custom.trim(), "自定义前缀")}
        >
          应用
        </button>
      </div>

      <div className="gh-proxy-foot">
        <button type="button" className="btn" disabled={busy !== ""} onClick={() => void probeAll()}>
          {busy === "probe" ? "测速中…" : "测速全部"}
        </button>
        <span className="gh-proxy-foot__stat">
          {state
            ? `当前${current ? "走加速" : "直连"} · ${state.links} 条 GitHub 链接 / ${state.configs} 个配置`
            : "读取中…"}
          {isCustom ? " · 自定义前缀" : ""}
        </span>
      </div>
    </div>
  );
}
