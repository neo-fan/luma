/**
 * 卡顿看门狗的「慢 ≠ 死」判决——从 usePlayerEngine 的 stallCheck 探活回调里抽出的纯函数。
 *
 * 这里**只做判决**：把探针结论 + 计数 + 出画/直播态映射成「下一步动作」与「判决后的计数」。
 * 副作用（noteAlive、清慢提示、写日志、交棒换线/换源）一律留在调用方，由 action 分派，
 * 这样日志字面串（探针依赖的 "stall probe unresponsive" 等）与计数阈值都能逐字保留。
 *
 * 判决规则（2026-11 用户确认基线，与现网 usePlayerEngine 完全一致）：
 *   1. 出过画 → 永不自动换线：返回 notice，交回上层按网络抖动只撤慢提示；
 *   2. 探针 ok（清单 + 首分片都拿得到）→ stay，计数归零，源只是慢；
 *   3. 探针 dead（4xx / 非 m3u8 / 分片是占位图）→ 一次即 dead，计数**原样**（现状：
 *      明确失败分支不读写 unresponsiveProbes）；
 *   4. 探针 unknown（说不出所以然）→ 计数 +1；累计到 limit 才 dead，否则 notice。
 * 直播与点播共用同一套三态判决：isLive 是输入留痕 + 单测面，**当前不据此改变换线结论**。
 */

/** 探针给出的三态结论（与 lib/playProbe.probeLineVerdict 的返回值一致）。 */
export type ProbeVerdict = "dead" | "ok" | "unknown";

/**
 * 判决后的下一步动作枚举。
 *
 * - `stay`   ：源活着只是慢，重置计数、继续等。
 * - `notice` ：unknown 未达阈值（或已出画），只累计 / 提示、不换线。
 * - `dead`   ：明确失败，或 unknown 累计到阈值 → 交棒换线/换源。
 *
 * `probe` 是看门狗「取证据」这一步：本轮该不该真的发一次探活，取决于墙钟静默
 * 窗口与节流（lastAliveAt / Date.now()），属时间相关逻辑、不放进这个纯判决，
 * 由调用方 stallCheck 的计时闸门自行决定（保留在此仅为补全动作词汇表）。
 */
export type WatchdogAction = "stay" | "notice" | "probe" | "dead";

export interface WatchdogVerdictInput {
  /** 探针给出的三态结论。 */
  verdict: ProbeVerdict;
  /** 本轮判决前的「连续无响应」计数；纯函数不修改它以外的状态。 */
  unresponsiveProbes: number;
  /** 判定「连续无响应」换线的阈值（现网 STALL_UNRESPONSIVE_LIMIT = 3）。 */
  limit: number;
  /** 是否已经出过画：true 时永不自动换线（只 notice）。 */
  hasPlayed: boolean;
  /** 是否直播态：当前不参与判决（直播与点播同一规则），仅作输入留痕与单测面。 */
  isLive: boolean;
}

export interface WatchdogVerdictResult {
  /** 判决后的计数：ok 归零、unknown +1、dead 原样（与现状一致），由调用方写回。 */
  unresponsiveProbes: number;
  /** 调用方据此执行的下一步动作（不含 probe，probe 由计时闸门决定）。 */
  action: Exclude<WatchdogAction, "probe">;
}

export function decideWatchdogVerdict(
  input: WatchdogVerdictInput,
): WatchdogVerdictResult {
  const { verdict, unresponsiveProbes, limit, hasPlayed } = input;
  // 出过画绝不再自动换线：交回上层按网络抖动只提示，看门狗不判死。
  if (hasPlayed) {
    return { unresponsiveProbes, action: "notice" };
  }
  if (verdict === "ok") {
    // 清单和分片都拿得到 → 只是慢，继续等（计数归零）。
    return { unresponsiveProbes: 0, action: "stay" };
  }
  if (verdict === "dead") {
    // 明确失败一次即换线，计数原样（现状：dead 分支不读写 unresponsiveProbes）。
    return { unresponsiveProbes, action: "dead" };
  }
  // unknown：累计到阈值前一律继续等，绝不跳走。
  const next = unresponsiveProbes + 1;
  if (next >= limit) {
    return { unresponsiveProbes: next, action: "dead" };
  }
  return { unresponsiveProbes: next, action: "notice" };
}
