/**
 * `playerContent` 返回的 `header` 归一化。
 *
 * TVBox 源对 `header` 的返回形态不统一：多数给对象（`{"User-Agent": …}`），
 * 但部分源（如 pianku 系的 4k01）给的是 **JSON 字符串**。若不归一化：
 * - `header["User-Agent"]` 在字符串上取不到值 → UA/Referer/Cookie 丢失；
 * - 把字符串当 `headers` 传给 `parse_resolve` → Rust 端 `HashMap` 反序列化失败
 *   （`invalid type: string …, expected a map`），整条解析池被静默跳过。
 *
 * 这里统一收敛成对象；非法输入（null / 数组 / 坏 JSON）一律返回空对象。
 */
export function normalizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || Array.isArray(raw)) {
    return {};
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as Record<string, string>;
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? (raw as Record<string, string>) : {};
}
