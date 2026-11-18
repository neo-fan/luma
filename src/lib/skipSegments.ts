/**
 * 片头 / 片尾跳过配置（per-剧，落在 `HistoryItem.skipJson`）。
 *
 * 后端只把 `skip_json` 当不透明 JSON 文本透传并跨源继承（见
 * `src-tauri/src/infra/db/history.rs`），结构与校验在这里单点负责——Rust 侧注释
 * 也指名本文件是校验方。设计成「按剧」而非全局：一部悬疑剧片头 90s、一部综艺
 * 片头 0s 是常态，跟倍速一样属于「看这部剧的习惯」。
 *
 * 模型：最多一条 intro + 一条 outro。
 *  - intro：`ms` = 跳过开头这么多秒（片头时长）。
 *  - outro：`ms` = 距结尾 `ms` 秒内视为进入片尾窗口（片尾时长）。
 * 用数组承载（`SkipSegment[]`）是为将来同一剧多段（如分段片头）留位；当前每类
 * 取最后一条生效，重复 kind 不报错、后者覆盖前者。
 */

export type SkipKind = "intro" | "outro";

export interface SkipSegment {
  kind: SkipKind;
  /** 毫秒；intro 是「开头跳过多长」，outro 是「距结尾多长内触发」。 */
  ms: number;
}

/** 片头 / 片尾各自上限：30 分钟，挡住脏数据把整集吃掉。 */
export const MAX_SKIP_MS = 30 * 60 * 1000;

const KINDS: readonly SkipKind[] = ["intro", "outro"];

function isKind(value: unknown): value is SkipKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

/** 合法化单条时长：非有限 / 负 → 0；超上限 → 截到上限。 */
export function clampSkipMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(MAX_SKIP_MS, Math.round(n));
}

/**
 * 解析 `skipJson`：坏 JSON / 非数组 / 非对象项 / 非法 kind 一律丢弃，越界 ms 夹取。
 * 同一 kind 出现多次取最后一条（后者覆盖）。返回稳定顺序：intro 在前、outro 在后。
 */
export function parseSkipConfig(raw: string | null | undefined): SkipSegment[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const byKind = new Map<SkipKind, number>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (!isKind(rec.kind)) {
      continue;
    }
    const ms = clampSkipMs(rec.ms);
    if (ms <= 0) {
      // 0 = 该类没设过；显式清掉，避免残留一条无意义的 0ms 段。
      byKind.delete(rec.kind);
      continue;
    }
    byKind.set(rec.kind, ms);
  }
  const out: SkipSegment[] = [];
  for (const kind of KINDS) {
    const ms = byKind.get(kind);
    if (ms && ms > 0) {
      out.push({ kind, ms });
    }
  }
  return out;
}

/** 序列化回 `skipJson`；空配置写 `"[]"`（与后端默认/继承语义一致）。 */
export function serializeSkipConfig(segments: SkipSegment[]): string {
  const normalized = parseSkipConfig(JSON.stringify(segments));
  return JSON.stringify(normalized);
}

export function introMs(segments: SkipSegment[]): number {
  return segments.find((s) => s.kind === "intro")?.ms ?? 0;
}

export function outroMs(segments: SkipSegment[]): number {
  return segments.find((s) => s.kind === "outro")?.ms ?? 0;
}

/**
 * 片头跳过判定：从头播（或进度仍在片头内）时跳到 `introMs`。
 * 调用方负责先排除「续播点已晚于片头」的情况——这里只回答「当前点是否落在片头里」。
 */
export function shouldSkipIntro(currentMs: number, intro: number): boolean {
  return intro > 0 && currentMs >= 0 && currentMs < intro;
}

/** 片尾窗口起点（绝对毫秒）；duration 无效或 outro 未设 → Infinity（永不触发）。 */
export function outroStartMs(durationMs: number, outro: number): number {
  if (outro <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, durationMs - outro);
}

/** 片尾跳过判定：当前点进入片尾窗口。 */
export function shouldSkipOutro(currentMs: number, durationMs: number, outro: number): boolean {
  return currentMs >= outroStartMs(durationMs, outro);
}
