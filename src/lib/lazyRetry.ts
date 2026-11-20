/**
 * 页面级懒加载的「一次重试」辅助。
 *
 * `lazy()` 的动态 import 会因**开发期 Vite 重启/重新预打包**或**弱网加载失败**
 * 抛 `Failed to fetch dynamically imported module`：旧代码没人接这个 rejection，
 * 页面直接白屏（「直播页打不开」的实测根因之一），而路由错误边界只在渲染期
 * 报错时出现，救不回「chunk 没加载上」。
 *
 * 用法（保留 React.lazy 自身的类型推断，不给它套泛型约束）：
 *
 *   const LivePage = lazy(() => loadWithRetry("LivePage", () => import("./pages/LivePage")));
 *
 * 策略刻意保守：失败 → 短暂等待 → 再试一次；第二次仍失败就照抛，让错误边界
 * 给出「重试 / 回首页」的可操作界面。不无限重试——源真没了，重试只是刷日志。
 */
import { log } from "./logger";

const RETRY_DELAY_MS = 400;

/** 跑 `load`，失败后等 `delayMs` 再跑一次；第二次的结果（含错误）原样返回。 */
export async function loadWithRetry<T>(
  name: string,
  load: () => Promise<T>,
  delayMs: number = RETRY_DELAY_MS,
): Promise<T> {
  try {
    return await load();
  } catch (err) {
    log.warn("lazy chunk retry", {
      name,
      reason: String((err as Error | undefined)?.message ?? err).slice(0, 160),
    });
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return await load();
  }
}
