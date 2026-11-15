import { api } from "../../lib/invoke";
import type { Site, SiteHealthRow } from "../../types/luma";

/** 体检状态对应的中文文案（disabled 为前端合成的禁用态）。 */
export const HEALTH_STATUS_LABEL: Record<SiteHealthRow["status"] | "disabled", string> = {
  ok: "可达",
  failed: "失败",
  timeout: "超时",
  skipped: "未完成",
  disabled: "已禁用",
};

/** 体检渲染行：探测行用后端状态，禁用行由前端合成 status="disabled"。 */
export interface HealthDisplayRow {
  siteKey: string;
  siteName: string;
  status: SiteHealthRow["status"] | "disabled";
  tookMs: number;
  message?: string;
  count?: number;
  /** jvm 屏蔽源：后端会拒绝手动启用，前端先挡掉。 */
  blocked: boolean;
}

/**
 * 屏蔽源（导入时禁用的 jvm / Android dex jar 源）挡住「启用」：后端会拒绝
 * 手动启用，前端先挡掉，避免无谓 IPC。手动禁用的 cms / python / quickjs 站
 * 不在此列，仍可启用。
 */
export function isBlockedSource(site: Site): boolean {
  return site.runtime === "jvm";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 复制文本。优先走后端系统剪贴板：WebView2 的 `navigator.clipboard` 在缺少
 * 用户手势时会弹权限框并挂起，桌面应用里体验很差。失败时把内容放进只读
 * textarea，让用户手动全选复制。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await api.copyText(text);
    return true;
  } catch {
    return false;
  }
}
