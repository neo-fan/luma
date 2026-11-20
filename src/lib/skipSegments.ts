/**
 * 片头 / 片尾跳过配置（per-剧，落在 `HistoryItem.skipJson`）。
 *
 * 后端只把 `skip_json` 当不透明 JSON 文本透传并跨源继承（见
 * `src-tauri/src/infra/db/playback.rs`），结构与校验在这里单点负责——Rust 侧注释
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
 * 解析 `skipJson`：坏 JSON / 非对象项 / 非法 kind 一律丢弃，越界 ms 夹取。
 * 同一 kind 出现多次取最后一条（后者覆盖）。返回稳定顺序：intro 在前、outro 在后。
 *
 * 两种形状都吃：旧格式是裸数组 `[{kind,ms}]`，2.0 起是 `{enabled, segments}`
 * （开关按剧记，见 `parseSkipEnabled`）。这里只关心时长，开关由调用方各自读。
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
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { segments?: unknown }).segments)
      ? ((value as { segments: unknown[] }).segments)
      : null;
  if (!list) {
    return [];
  }
  const byKind = new Map<SkipKind, number>();
  for (const item of list) {
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

/**
 * 这部剧的「跳过」开关。旧格式（裸数组）与缺字段都按**开**读——手写或继承来的
 * 配置里没有这个键时，行为必须和以前一致，不能因为少一个键就把跳过关掉。
 */
export function parseSkipEnabled(raw: string | null | undefined): boolean {
  if (!raw || !raw.trim()) {
    return true;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return (value as { enabled?: unknown }).enabled !== false;
    }
  } catch {
    /* 坏 JSON 按默认（开）处理，时长那边同样会解析成空 */
  }
  return true;
}

/** 序列化回 `skipJson`：`{enabled, segments}`（段仍走同一套校验）。 */
export function serializeSkipConfig(segments: SkipSegment[], enabled = true): string {
  return JSON.stringify({
    enabled: enabled !== false,
    segments: parseSkipConfig(JSON.stringify(segments)),
  });
}

export function introMs(segments: SkipSegment[]): number {
  return segments.find((s) => s.kind === "intro")?.ms ?? 0;
}

export function outroMs(segments: SkipSegment[]): number {
  return segments.find((s) => s.kind === "outro")?.ms ?? 0;
}

/**
 * 原生设置面板里的可选时长（含 0=关闭）。片头给到 3 分钟、片尾到 90 秒一档，
 * 覆盖常见片头/片尾长度；比自由输入秒数更快、也不会填出荒谬值。
 */
export const INTRO_PRESET_MS = [0, 15_000, 30_000, 45_000, 60_000, 90_000, 120_000, 180_000];
export const OUTRO_PRESET_MS = [0, 10_000, 15_000, 30_000, 45_000, 60_000, 90_000];

/** 把毫秒数说成人话：0 → 「关闭」，其余「X秒 / X分Y秒 / X分钟」。用于菜单文案。 */
export function formatSkipMs(ms: number): string {
  const sec = Math.round(clampSkipMs(ms) / 1000);
  if (sec <= 0) {
    return "关闭";
  }
  if (sec < 60) {
    return `${sec}秒`;
  }
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest === 0 ? `${min}分钟` : `${min}分${rest}秒`;
}

/**
 * 把某 kind 的时长设为 `ms`（0 = 关闭即删除该类），其余保持不变，返回稳定顺序
 * （intro 在前、outro 在后）。设置面板 onSelect 与未来「进度取点」都走这里，
 * 保证写出的结构与 `serializeSkipConfig` 一致。
 */
export function withSkipMs(segments: SkipSegment[], kind: SkipKind, ms: number): SkipSegment[] {
  const kept = segments.filter((s) => s.kind !== kind);
  const clamped = clampSkipMs(ms);
  if (clamped > 0) {
    kept.push({ kind, ms: clamped });
  }
  return KINDS.flatMap((k) => kept.filter((s) => s.kind === k));
}

/**
 * 齿轮行右侧的展示值：`110s/45s`（片头/片尾，顺序与左侧标题一致）。
 *
 * 只写秒数：原先「片头1分50秒 · 片尾45秒」这种中文单位串把齿轮行右侧挤满，
 * 在窄窗口里会换行/截断；这一行本来就叫「片头/片尾」，单位再省成 `s` 即可读。
 * 只设一类时补上标题（`片头110s`），否则单独一个数字看不出是哪一类。
 * 关掉时直接写「已关闭」——比继续显示秒数更准确地反映「现在不跳」。
 */
export function formatSkipSummary(segments: SkipSegment[], enabled = true): string {
  if (!enabled) {
    return "已关闭";
  }
  const intro = Math.round(introMs(segments) / 1000);
  const outro = Math.round(outroMs(segments) / 1000);
  if (intro > 0 && outro > 0) {
    return `${intro}s/${outro}s`;
  }
  if (intro > 0) {
    return `片头${intro}s`;
  }
  if (outro > 0) {
    return `片尾${outro}s`;
  }
  return "未设置";
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

/**
 * 自动跳过的提示倒计时秒数：配置了片头/片尾后，进入窗口时不立刻跳，而是给
 * 这么多秒的「即将自动跳过 · 可取消」提示，到点才跳。避免「没看清就被瞬移」。
 */
export const AUTO_SKIP_COUNTDOWN_S = 3;

/** 倒计时显示用：剩余毫秒向上取整到秒（0 = 该跳了）。 */
export function countdownSeconds(remainingMs: number): number {
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

/** `useAutoSkipPrompt` 用来判定「刚刚进入某个窗口」的最小窗口快照。 */
export interface SkipWindowFlags {
  introMs: number;
  outroMs: number;
  inIntro: boolean;
  inOutro: boolean;
}

/**
 * 这次窗口态相对上一次，是否应当发起一次「自动跳过倒计时」。
 *
 * - 片头：`inIntro` 由 false（或首次报告 `prev=null`）翻到 true 即触发——新开一集
 *   从头播、进度落在片头里，正是要自动跳的场景。
 * - 片尾：只在**播放中真正进入**片尾窗口（`prev.inOutro` 确为 false 翻到 true）时
 *   触发；`prev=null` 的首次报告若已在片尾里（续播点本就接近结尾），**不**触发——
 *   那是「上次看到」的位置，不该被自动跳覆盖。
 *
 * 纯函数，无定时器 / 无副作用，便于单测。
 */
export function shouldAutoSkipPrompt(
  prev: SkipWindowFlags | null,
  cur: SkipWindowFlags | null,
): SkipKind | null {
  if (!cur) {
    return null;
  }
  if (cur.introMs > 0 && cur.inIntro && !prev?.inIntro) {
    return "intro";
  }
  if (cur.outroMs > 0 && cur.inOutro && prev && !prev.inOutro) {
    return "outro";
  }
  return null;
}
