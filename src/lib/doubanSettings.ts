/**
 * 豆瓣信息补全的本地设置（详情页自动补评分 / 简介 / 演职员）。
 *
 * 为什么这组设置落在 localStorage 而不是 Rust 侧：它是纯前端的展示偏好——
 * 不发请求、不改配置、不进双快照。写在 Rust 里会让「关掉豆瓣补全」这样一次
 * 纯 UI 操作变成一次 IPC + 一次落库；而它只需要在本机记住。
 *
 * 代理模式是「请求走哪条路」的前缀策略，由 Rust 侧 `douban_meta` 消费：
 * `direct` 直连豆瓣，`custom` 用用户填的前缀，其余三个是内置公共前缀。
 * 设置变更立即生效（下一次详情请求就读到新值）。
 *
 * 健壮性对齐 `src/lib/playerPrefs.ts`：坏 JSON / 越界枚举值一律回落默认；
 * localStorage 不可用（隐私模式、沙箱）或写入失败时静默忽略，绝不因为一次
 * 读设定把详情页搞崩。
 */

/** 豆瓣请求的代理模式（与 Rust `douban_meta` 的 proxyType 参数一一对应）。 */
export type DoubanProxyType =
  | "direct"
  | "custom"
  | "cors-proxy-zwei"
  | "cmliussss-cdn-tencent"
  | "cmliussss-cdn-ali";

export interface DoubanPrefs {
  /** 详情页是否自动补豆瓣信息，默认开。 */
  enabled: boolean;
  /** 走哪条路访问豆瓣。 */
  proxyType: DoubanProxyType;
  /** 仅 `proxyType === "custom"` 时有意义，例如 `https://proxy.example/?url=`。 */
  proxyPrefix: string;
}

export const DEFAULT_DOUBAN_PREFS: DoubanPrefs = {
  enabled: true,
  proxyType: "direct",
  proxyPrefix: "",
};

/** 设置页下拉的候选项（label 即用户看到的名字）。 */
export const DOUBAN_PROXY_OPTIONS: {
  value: DoubanProxyType;
  label: string;
  hint: string;
}[] = [
  {
    value: "direct",
    label: "直连豆瓣",
    hint: "直接请求豆瓣接口；多数网络可用，被墙或被限流时换成下面的代理。",
  },
  {
    value: "custom",
    label: "自定义前缀",
    hint: "请求地址会拼成「前缀 + 豆瓣接口」，适合自建反代。",
  },
  {
    value: "cors-proxy-zwei",
    label: "CorsProxy（zwei）",
    hint: "内置公共 CORS 代理，无需配置，偶尔会被限流。",
  },
  {
    value: "cmliussss-cdn-tencent",
    label: "CM 代理 · 腾讯云 CDN",
    hint: "内置公共镜像，走腾讯云 CDN 节点。",
  },
  {
    value: "cmliussss-cdn-ali",
    label: "CM 代理 · 阿里云 CDN",
    hint: "内置公共镜像，走阿里云 CDN 节点。",
  },
];

import { DOUBAN_PREFS_KEY } from "./storageKeys";

const KEY = DOUBAN_PREFS_KEY;

const PROXY_TYPES: DoubanProxyType[] = [
  "direct",
  "custom",
  "cors-proxy-zwei",
  "cmliussss-cdn-tencent",
  "cmliussss-cdn-ali",
];

export function isDoubanProxyType(value: unknown): value is DoubanProxyType {
  return typeof value === "string" && (PROXY_TYPES as string[]).includes(value);
}


function storageOf(storage?: Storage): Storage | null {
  if (storage) {
    return storage;
  }
  try {
    return window.localStorage;
  } catch {
    // 隐私模式 / 沙箱下访问 localStorage 会抛异常。
    return null;
  }
}

/** 读取设置；坏 JSON、非对象、越界枚举值一律回落到默认值。 */
export function readDoubanPrefs(storage?: Storage): DoubanPrefs {
  const store = storageOf(storage);
  if (!store) {
    return { ...DEFAULT_DOUBAN_PREFS };
  }
  try {
    const raw = store.getItem(KEY);
    if (!raw) {
      return { ...DEFAULT_DOUBAN_PREFS };
    }
    const parsed = JSON.parse(raw) as Partial<DoubanPrefs> | null;
    // `JSON.parse("null")` 也走这条：没有对象就没有可用的字段。
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_DOUBAN_PREFS };
    }
    return {
      enabled:
        typeof parsed.enabled === "boolean"
          ? parsed.enabled
          : DEFAULT_DOUBAN_PREFS.enabled,
      proxyType: isDoubanProxyType(parsed.proxyType)
        ? parsed.proxyType
        : DEFAULT_DOUBAN_PREFS.proxyType,
      proxyPrefix:
        typeof parsed.proxyPrefix === "string"
          ? parsed.proxyPrefix.trim()
          : DEFAULT_DOUBAN_PREFS.proxyPrefix,
    };
  } catch {
    return { ...DEFAULT_DOUBAN_PREFS };
  }
}

/** 合并写入并返回合并后的结果；写失败只丢这次持久化，不影响本次会话。 */
export function writeDoubanPrefs(
  patch: Partial<DoubanPrefs>,
  storage?: Storage,
): DoubanPrefs {
  const next: DoubanPrefs = { ...readDoubanPrefs(storage), ...patch };
  next.enabled =
    typeof next.enabled === "boolean"
      ? next.enabled
      : DEFAULT_DOUBAN_PREFS.enabled;
  next.proxyType = isDoubanProxyType(next.proxyType)
    ? next.proxyType
    : DEFAULT_DOUBAN_PREFS.proxyType;
  next.proxyPrefix =
    typeof next.proxyPrefix === "string" ? next.proxyPrefix.trim() : "";

  const store = storageOf(storage);
  if (!store) {
    return next;
  }
  try {
    store.setItem(KEY, JSON.stringify(next));
  } catch {
    // 配额满 / 被禁用时静默忽略。
  }
  return next;
}
