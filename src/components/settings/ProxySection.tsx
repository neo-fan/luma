import { useEffect, useState } from "react";
import ErrorBar from "../ErrorBar";
import { api, errorMessage } from "../../lib/invoke";
import type { ProxyStatus } from "../../types/luma";

interface ProxySectionProps {
  /** 父级 reload 计数：导入/切换配置后重新读取反代状态。 */
  reload: number;
}

/** 本地反代：只读展示当前监听的端口与基础地址。 */
export default function ProxySection({ reload }: ProxySectionProps) {
  const [proxy, setProxy] = useState<ProxyStatus | null>(null);
  const [proxyError, setProxyError] = useState("");

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setProxyError("");
      try {
        const status = await api.proxyStatus();
        if (alive) {
          setProxy(status);
        }
      } catch (err) {
        if (alive) {
          setProxy(null);
          setProxyError(errorMessage(err));
        }
      }
    };
    void run();
    return () => {
      alive = false;
    };
  }, [reload]);

  return (
    <div className="settings-block">
      <h2 className="section-title">本地反代</h2>
      {proxyError ? <ErrorBar message={`反代状态读取失败：${proxyError}`} /> : null}
      {proxy ? (
        <p className="settings-line">
          端口：{proxy.port} · 监听：{proxy.baseUrl} · allowLocal：{proxy.allowLocal ? "是" : "否"}
        </p>
      ) : null}
      {!proxy && !proxyError ? <p className="settings-line">读取中…</p> : null}
    </div>
  );
}
