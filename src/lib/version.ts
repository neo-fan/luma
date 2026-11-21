/**
 * 应用版本：由 Vite 在构建时从 package.json 注入（见 `vite.config.ts`）。
 * 不要在页面里硬编码版本号，Cargo / tauri.conf / package.json 必须一致。
 */
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
/** 构建时刻的 epoch 秒（不是提交时间）：一眼看出这次是不是新构建出来的包。 */
export const BUILD_TIME = typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "";

/**
 * 解析构建时间：输入 epoch 秒（后端诊断字段）或 ISO 字符串（旧构建注入过
 * `2026-11-14T12:48:05+0800`），解析不出来返回 null——调用方据此隐藏，
 * 不要显示 "Invalid Date"。
 */
function parseBuildTime(raw?: string | null): Date | null {
  const text = (raw ?? "").trim();
  if (!text || text === "unknown") return null;
  // `+0800` 没有冒号，Date.parse 在部分引擎里返回 NaN，先补成 `+08:00`。
  const epoch = /^\d+$/.test(text)
    ? Number(text) * (text.length >= 13 ? 1 : 1000)
    : Date.parse(text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const date = new Date(epoch);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * build 号 = 本地时区的 `yyyyMMddHHmmss`（14 位，字典序即时间序）。
 * 后端诊断字段与前端注入值走同一个函数，格式与展示处完全一致。
 */
export function formatBuildTime(raw?: string | null): string {
  const d = parseBuildTime(raw);
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** 人类可读形式 `2026-11-14 12:48:05`：只放在 title 悬停里，不占版面。 */
export function readableBuildTime(raw?: string | null): string {
  const d = parseBuildTime(raw);
  if (!d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** 前端 build 号（14 位时间戳）。 */
export const BUILD_STAMP = formatBuildTime(BUILD_TIME);

/**
 * 是否调试窗口：`tauri dev` 由 Vite dev server 供页面，`import.meta.env.DEV`
 * 恒为 true；`tauri build` 后的安装包跑的是产物，恒为 false。
 * 与后端判定同一场景（`tauri::is_dev()`，即未启用 `custom-protocol`），
 * 用来把调试窗口跟同机安装的正式版区分开（见 AppShell 侧栏与窗口标题）。
 */
export const IS_DEV_BUILD = import.meta.env.DEV;

/**
 * 版本展示：prerelease 缩写为业界常见形式（如 `2.0.0-beta.1` → `2.0.0.b1`）。
 * 数据源仍保持 package.json 的合法 semver，只在 UI 层做映射：
 * -alpha[.N]→.a[N]、-beta[.N]→.b[N]、-rc[.N]→.rc[N]；没有后缀的原样返回。
 */
export function formatVersion(raw?: string | null): string {
  return (raw ?? "")
    .replace(/-alpha(\.\d+)?$/i, (_, seq?: string) => `.a${seq ? seq.slice(1) : ""}`)
    .replace(/-beta(\.\d+)?$/i, (_, seq?: string) => `.b${seq ? seq.slice(1) : ""}`)
    .replace(/-rc(\.\d+)?$/i, (_, seq?: string) => `.rc${seq ? seq.slice(1) : ""}`);
}

/**
 * 比较两段版本号的主版本部分（忽略 `v` 前缀与 `-alpha/-beta/-rc` 后缀）。
 * 只用于「更新是否落地」这类粗粒度判断，不追求完整 semver 优先级。
 */
export function compareVersions(left: string, right: string): number {
  const parts = (raw: string): number[] =>
    (raw ?? "")
      .trim()
      .replace(/^v/i, "")
      .split(/[-+]/, 1)[0]
      .split(".")
      .map((part) => {
        const value = Number.parseInt(part, 10);
        return Number.isFinite(value) && value >= 0 ? value : 0;
      });
  const a = parts(left);
  const b = parts(right);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** 当前版本是否已达到（或超过）目标版本。 */
export function isVersionAtLeast(current: string, target: string): boolean {
  return compareVersions(current, target) >= 0;
}
