/**
 * 提示的「生命周期策略」唯一来源。
 *
 * 为什么要有这张表：项目里提示散落在 40+ 处（`.tip` / `ErrorBar` / toast），
 * 每处自己 `setTimeout` 的结果是同一类信息活 3s、8s、10s、永不 —— 用户没法
 * 建立预期，代码也没法统一改。现在**时长只在这里定义**，页面只声明语义。
 *
 * 分档依据：
 *  - 中文阅读速度约 5~8 字/秒，本项目提示文案 14~22 字 → 读完需 2~4s；
 *  - 读完还要判断「要不要动手」（换台 / 重试 / 忽略）→ 再 3~4s；
 *  - 纯告知 4s 足够（对齐 antd message / Android Toast）；
 *  - 要用户注意但不强制动作的警告 8s（短于 5s 读不完，长于 12s 变成噪音，
 *    Material 对带操作的 Snackbar 下限也是这个量级）；
 *  - 需要用户决策的错误**不自动消失**（0）：它本身就是「该你操作了」的指令，
 *    自动收起等于把出口藏起来。
 */
export type NoticeTone = "info" | "success" | "warn" | "error";

/** 毫秒；0 = 常驻（等用户处理，或由调用方显式清除）。 */
export const NOTICE_TTL: Record<NoticeTone, number> = {
  info: 4_000,
  success: 4_000,
  warn: 8_000,
  error: 0,
};

/** 0 表示常驻，不允许出现「负数时长」这种写法。 */
export function noticeTtl(tone: NoticeTone): number {
  return Math.max(NOTICE_TTL[tone], 0);
}
