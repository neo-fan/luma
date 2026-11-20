/**
 * 切换代次令牌：所有「会改播放目标」的异步流程（原地换集、手动换源、手动换线、
 * 自动换线 / 换源）共用一份。
 *
 * 它解决的是并发竞争：一次切换的解析要 `await` 数秒到数十秒，期间用户又点了
 * 别的集 / 换了源 / 触发了自动恢复，旧的那次解析不能把页面拽回去。
 *
 * 规则只有一条 —— **任何落地副作用之前，必须先确认自己仍是最新代次**：
 *  - `begin()` 推进代次、返回带 `gen` 与 `signal` 的 attempt，并 `abort` 上一个
 *    attempt 的 signal（让还在 `await` 的并发探活能真早停；底层 IPC 不接 signal
 *    的解析靠 `isCurrent` 在落地前丢弃）；
 *  - `isCurrent(gen)` 比对，非最新代次的结果整段丢弃，绝不 `navigate` / 写缓存 /
 *    改播放目标 / 收口提示。
 *
 * 「立即结束上一个、只认最新一次」= 新意图 `begin()` 即抢占，旧 attempt 的
 * `isCurrent` 从此恒为 `false`。
 */

export interface SwitchAttempt {
  /** 本次 attempt 的代次；落地前用它调 `isCurrent`。 */
  readonly gen: number;
  /** 本次 attempt 的中止信号；新 attempt 诞生时它被 abort。 */
  readonly signal: AbortSignal;
}

export interface SwitchToken {
  /** 开始一次新切换：中止上一个、推进代次、返回本次 attempt。 */
  begin(): SwitchAttempt;
  /** 某个代次是否仍是最新。 */
  isCurrent(gen: number): boolean;
  /** 当前最新代次（无在途时也有效，供读取/日志）。 */
  current(): number;
  /** 中止当前在途但不推进代次（卸载 / 路由接管时用）。 */
  abortCurrent(): void;
}

export function createSwitchToken(): SwitchToken {
  let gen = 0;
  let controller: AbortController | null = null;
  return {
    begin(): SwitchAttempt {
      // 抢占：先掐掉上一个 attempt 还在跑的探活，再自增代次。
      controller?.abort();
      controller = new AbortController();
      gen += 1;
      return { gen, signal: controller.signal };
    },
    isCurrent(candidate: number): boolean {
      return candidate === gen;
    },
    current(): number {
      return gen;
    },
    abortCurrent(): void {
      controller?.abort();
      controller = null;
    },
  };
}

/**
 * 串行提交门：把「真正改画面」的副作用（`engine.switchSource` 及其随后的集身份
 * 落地）排队串行执行，并用 `switchToken` 的代次只放行最新一次。
 *
 * 为什么不能只靠 token 的 `isCurrent`：底层 `resolvePlay` 不接 abort，并发解析
 * 的完成顺序不可控；若直接 `await switchSource`，两个解析完成会并发切画面
 * （后完成者赢，画面可能跳回旧集，正是历史注释反复警告的竞态）。所以：
 *  - 解析**允许并发**（只读、幂等，最多各发一次请求）；
 *  - **切画面串行**：进锁后先校验 `isCurrent(gen)`，等锁期间已被更新选中抢占的
 *    旧提交直接跳过、根本不碰画面；
 *  - 锁链不被单次异常打断。
 *
 * 由此保证：**最终落到画面的一定是最新一次选中**；旧结果要么在锁前就被判过期
 * 跳过，要么即便切了画面也会被更新一次立刻覆盖（更新那次仍在锁内、必然最后）。
 */
export interface CommitGate {
  commit(gen: number, run: () => Promise<void>): Promise<void>;
}

export function createCommitGate(token: SwitchToken): CommitGate {
  let tail: Promise<void> = Promise.resolve();
  return {
    commit(gen, run) {
      const next = tail.then(async () => {
        // 等锁期间被更新的选中抢占 → 这次不碰画面。
        if (!token.isCurrent(gen)) {
          return;
        }
        await run();
      });
      // 不让一次失败卡死后续提交；调用方各自的 promise 仍能 await 到真实结果/异常。
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

/**
 * 手动意图持有器：**用户显式选择必须压过自动恢复**。
 *
 * 当前源已死时，watchdog / hls fatal 会反复触发 `switchOrFailover`，每次 `begin()`
 * 都把用户刚发起的手动换源/换集/换线判成过期、静默丢弃（实测：手动切换日志在打，
 * 画面却永远不动）。所以任何手动动作起一个持有期，持有期内自动恢复直接让位；
 * 手动落地或持有到期后，自愈自动恢复。
 */
export interface ManualHold {
  /** 手动动作发起时调用，续期到 now + ttlMs。 */
  engage(ttlMs: number): void;
  /** 自动恢复入口检查：true = 让位，本轮不 begin、不抢占。 */
  active(): boolean;
  /**
   * 手动动作已明确收口（失败 / 取消 / 提前返回）时立即释放，让自愈无需等满
   * ttlMs 就恢复。成功落地不必调：持有到期本就会放行。
   */
  release(): void;
}

export function createManualHold(): ManualHold {
  let until = 0;
  return {
    engage(ttlMs: number): void {
      until = Date.now() + Math.max(0, ttlMs);
    },
    active(): boolean {
      return Date.now() < until;
    },
    release(): void {
      until = 0;
    },
  };
}
