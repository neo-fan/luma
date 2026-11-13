/**
 * 失败原因归类：把源站/运行时的原始报错翻译成**人能读懂的一句话**。
 *
 * 为什么需要这一层：
 * 原始 message 里混着完整 URL、协议名、解析器行列号（如
 * `fetch https://caj.dbzy5.com/api.php/provide/vod/?wd=… failed`、
 * `mismatched tag: line 25, column 2`）。这些对用户没有意义，还把界面
 * 搞得像日志。用户界面只应出现「这类源为什么失败」；原始文本留给
 * 「复制诊断报告」与日志。
 *
 * 归类优先级：
 *   1. 错误码（Rust 侧 `AppError.code`，如 SITE_TIMEOUT）——最可靠；
 *   2. 消息模式（源站直抛的错没有错误码，只能按特征匹配）；
 *   3. 兜底「源站未响应」。
 *
 * 原始 message 一律通过 `raw` 字段带出，供日志与诊断复制使用。
 */

/** 归类后的失败类型。`label` 是界面展示文案，`hint` 是一句话解释。 */
export type FailureKind =
  | "timeout" // 源站超时
  | "captcha" // 需要验证码
  | "parse" // 返回内容无法解析
  | "runtime" // 运行时不可用（jar/py/js 侧的问题）
  | "network" // 网络不可达
  | "disabled" // 已禁用 / 被跳过
  | "unknown"; // 其余

export interface FailureReason {
  kind: FailureKind;
  /** 界面展示：归类后的短标签，如「源站超时」。 */
  label: string;
  /** 界面展示：补充说明，一句话讲清这类失败的含义。 */
  hint: string;
  /** 原始报错全文——只进日志与「复制诊断报告」，不进界面。 */
  raw: string;
}

interface KindMeta {
  label: string;
  hint: string;
}

const KIND_META: Record<FailureKind, KindMeta> = {
  timeout: { label: "源站超时", hint: "单站超时 15 秒，源站没在时限内响应" },
  captcha: { label: "需要验证码", hint: "源站限制匿名访问，需要人工过验证码" },
  parse: { label: "内容无法解析", hint: "源站返回了数据，但格式与预期不符" },
  runtime: { label: "运行时不可用", hint: "本地运行该源所需的组件缺失或崩溃" },
  network: { label: "网络不可达", hint: "域名解析失败或连接被拒绝" },
  disabled: { label: "已跳过", hint: "该源被禁用或按配置规则不参与检索" },
  unknown: { label: "源站未响应", hint: "源站没有返回可用结果" },
};

/** 错误码 → 类型。Rust 侧 `AppError.code` 是最可靠的判定依据。 */
const CODE_KIND: Record<string, FailureKind> = {
  SITE_TIMEOUT: "timeout",
  SPIDER_CRASH: "runtime",
  RUNTIME_UNAVAILABLE: "runtime",
  RUNTIME_RESTART: "runtime",
  CONFIG_FETCH_FAIL: "network",
  CONFIG_DECRYPT_FAIL: "runtime",
  SIGNATURE_MISMATCH: "parse",
  PLAY_RESOLVE_FAIL: "parse",
  DIALECT_UNKNOWN: "parse",
  INVALID_ARGUMENT: "parse",
  INTERNAL: "unknown",
};

/**
 * 消息特征 → 类型。按出现顺序匹配，第一个命中即返回。
 *
 * 注意：这些模式只用于**分类**，不用于展示——命中的原文仍留在 `raw` 里。
 */
const MESSAGE_PATTERNS: Array<[RegExp, FailureKind]> = [
  [/超时|timed? ?out|timeout|deadline exceeded/i, "timeout"],
  [/验证码|人机验证|captcha|verify/i, "captcha"],
  [/mismatched tag|parse error|无法解析|invalid (?:json|xml|html)|unexpected token|decode error/i, "parse"],
  [/jar|dex|quickjs|qjs|js 源|python|py 源|runtime|sidecar/i, "runtime"],
  [/dns|resolve|connection refused|unreachable|econnrefused|network/i, "network"],
  [/disabled|skipped|屏蔽|禁用/i, "disabled"],
];

/**
 * 归类一次失败。
 *
 * @param code 错误码（Rust `AppError.code`）；源站直抛时可能为空。
 * @param message 原始报错全文。
 */
export function classifyFailure(code?: string, message?: string): FailureReason {
  const raw = (message ?? "").trim() || (code ?? "").trim();
  const trimmedCode = (code ?? "").trim();

  let kind: FailureKind = "unknown";
  if (trimmedCode && CODE_KIND[trimmedCode]) {
    kind = CODE_KIND[trimmedCode];
  } else {
    for (const [pattern, k] of MESSAGE_PATTERNS) {
      if (pattern.test(raw)) {
        kind = k;
        break;
      }
    }
  }

  const meta = KIND_META[kind];
  return { kind, label: meta.label, hint: meta.hint, raw };
}

/**
 * 归类一组失败并按类型聚合，产出「类型 → 站点数」的摘要。
 *
 * 界面用它渲染「源站超时（22 个站点）」这类分组；每组内部按站点名排序。
 */
export interface FailureGroup {
  kind: FailureKind;
  label: string;
  hint: string;
  count: number;
}

export function groupFailures(
  items: Array<{ code?: string; message?: string }>,
): FailureGroup[] {
  const buckets = new Map<FailureKind, { count: number }>();
  for (const item of items) {
    const { kind } = classifyFailure(item.code, item.message);
    const bucket = buckets.get(kind) ?? { count: 0 };
    bucket.count += 1;
    buckets.set(kind, bucket);
  }
  // 顺序固定：按出现频率降序，同频按 KIND_META 的声明顺序（超时在前，最常见）。
  const order: FailureKind[] = ["timeout", "captcha", "parse", "runtime", "network", "disabled", "unknown"];
  return [...buckets.entries()]
    .map(([kind, { count }]) => ({ kind, label: KIND_META[kind].label, hint: KIND_META[kind].hint, count }))
    .sort((a, b) => b.count - a.count || order.indexOf(a.kind) - order.indexOf(b.kind));
}
