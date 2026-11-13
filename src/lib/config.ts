/**
 * 配置命名 / 展示相关的纯函数。
 *
 * 多个配置并存时，用户第一眼是靠「名字」区分它们的；TVBox 配置自带的
 * `name` 常常是 `box`、`api` 甚至缺失，所以导入时默认用域名当名字，
 * 用户可以在导入前改掉，也可以在设置页随时重命名。
 */
import type { ConfigMeta, ConfigSource } from "../types/tvbox";

/** 把用户输入/粘贴的配置名收敛成列表里能直接显示的形式。 */
export function cleanConfigName(value: string, limit = 48): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  // 控制字符（换行、制表）会把列表撑开或错行，一律去掉。
  return [...trimmed]
    .filter((ch) => ch.charCodeAt(0) >= 32)
    .slice(0, limit)
    .join("")
    .trim();
}

/**
 * 从配置地址推导默认名称：取主机名，去掉 `www.` 与前导端口。
 *
 * 不用 `new URL().hostname`：它会把中文域名 IDNA 成 `xn--…`，界面上就没法
 * 看了（后端 `host_of` 出于同样原因也是手工解析）。解析失败（用户还在输入、
 * 或者只是半截地址）时返回空串，交给后端兜底。
 */
export function configNameFromUrl(value: string): string {
  const raw = value.trim();
  if (!raw) {
    return "";
  }
  const withoutScheme = raw.includes("://") ? raw.slice(raw.indexOf("://") + 3) : raw;
  const authority = withoutScheme.split(/[/?#]/)[0] ?? "";
  // 去掉 `user:pass@`，再按 IPv6 / 普通主机分别处理。
  const hostPort = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  let host: string;
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    host = end > 0 ? hostPort.slice(0, end + 1) : "";
    if (!/^\[[0-9a-fA-F:.]+\]$/.test(host)) {
      return "";
    }
  } else {
    host = hostPort.split(":")[0];
    // 只接受域名/IP 允许的字符，避免把「还在输入」的半截地址当成名字。
    if (!/^[\p{L}\p{N}._-]+$/u.test(host)) {
      return "";
    }
  }
  host = host.replace(/^www\./i, "").replace(/\.$/, "");
  return host ? cleanConfigName(host) : "";
}

/** 列表里显示的来源：URL 只留域名，其它类型给中文说明。 */
export function describeConfigSource(source: ConfigSource | undefined): string {
  if (!source) {
    return "未知来源";
  }
  if (source.kind === "url") {
    return configNameFromUrl(source.value) || "网络地址";
  }
  if (source.kind === "file") {
    const tail = source.value.split(/[\\/]/).pop() ?? "";
    return tail ? `文件 · ${tail}` : "本地文件";
  }
  return "粘贴文本";
}

/** ISO 时间戳 → 本地 `YYYY-MM-DD HH:mm`；解析不了就原样返回。 */
export function formatImportedAt(value: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return value;
  }
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(
    time.getHours(),
  )}:${pad(time.getMinutes())}`;
}

/**
 * 墙钟毫秒 → 相对时间。订阅检查时间每秒都在变老，绝对时间戳反而看不出
 * 「刚查过还是三天没查」；未知/0 显示破折号，不要伪造成「刚刚」。
 */
export function formatRelativeTime(at: number | undefined, now = Date.now()): string {
  if (!at || at <= 0) {
    return "—";
  }
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  if (diff < minute) {
    return "刚刚";
  }
  if (diff < 60 * minute) {
    return `${Math.floor(diff / minute)} 分钟前`;
  }
  if (diff < 24 * 60 * minute) {
    return `${Math.floor(diff / (60 * minute))} 小时前`;
  }
  return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
}

/**
 * 配置行里的一句话刷新状态。四种状态互斥且用户可分辨：
 * 不支持 / 失败 / 有更新 / 已是最新。`lastChangedAt` 新于 `lastCheckedAt`
 * 只在「这次检查刚好带来变化」时出现，所以用它区分两句话。
 */
export function describeRefreshState(meta: ConfigMeta, now = Date.now()): string {
  if (!meta.refreshable) {
    return "本地配置，不支持自动更新";
  }
  if (meta.refreshError) {
    return `检查失败：${meta.refreshError}`;
  }
  if (!meta.lastCheckedAt) {
    return "尚未检查更新";
  }
  if (meta.lastChangedAt && meta.lastChangedAt >= (meta.lastCheckedAt ?? 0)) {
    return `已更新 ${formatRelativeTime(meta.lastChangedAt, now)}`;
  }
  return `已是最新 · ${formatRelativeTime(meta.lastCheckedAt, now)}检查`;
}
