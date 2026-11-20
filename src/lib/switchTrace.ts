/**
 * 切换链路埋点：一次「解析 / 换台 / 换线 / 换集」= 一个 trace。
 *
 * 目的有两个，都是给真实窗口的排障用（CDP 探针 + 设置页导出的日志）：
 *
 * 1. **性能**：把「点下去 → 拿到直链 → 反代建连 → 出画」拆成阶段打点。
 *    只记相对毫秒，不记绝对时间戳的语义（时间戳由日志行自己带），
 *    这样同一条 trace 的各阶段可以直接相减看哪一段慢。
 * 2. **错误**：失败时带上 outcome 与原因（超时 / 源拒绝 / 解码失败），
 *    和成功的 trace 用同一个 `message` 落盘，一条 grep 就能把一次切换的
 *    全过程拉出来。
 *
 * 约束：
 * - 只走 `log.info`（dev 里 `debug` 也会发，但用户反馈的问题必须能在正式
 *   构建的日志里看到，所以统一 info；错误原因由 outcome 表达，不重复 warn）。
 * - 上下文只放短标量：不带完整播放地址（`logger` 本身也会脱敏 URL）。
 * - id 单调递增，`kind#n` 形式，同一次会话内可直接对齐「谁在谁之后」。
 */
import { log } from "./logger";

const MESSAGE = "trace";

let seq = 0;

export interface SwitchTrace {
  readonly id: string;
  /** 打一个阶段点，返回从 trace 开始到此刻的毫秒数。 */
  mark(stage: string, context?: Record<string, unknown>): number;
  /** 结束（幂等）：ok / fail / aborted 三选一。 */
  end(outcome: "ok" | "fail" | "aborted", context?: Record<string, unknown>): void;
}

export function startTrace(
  kind: string,
  context: Record<string, unknown> = {},
): SwitchTrace {
  const id = `${kind}#${++seq}`;
  const startedAt = performance.now();
  let ended = false;

  const mark = (stage: string, extra?: Record<string, unknown>): number => {
    const ms = Math.round(performance.now() - startedAt);
    log.info(MESSAGE, { id, kind, stage, ms, ...context, ...extra });
    return ms;
  };

  mark("start");

  return {
    id,
    mark,
    end(outcome, extra) {
      if (ended) {
        return;
      }
      ended = true;
      mark(`end:${outcome}`, extra);
    },
  };
}
