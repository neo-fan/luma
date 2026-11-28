/**
 * 原地换集的「地址挂上」必须可收口。
 *
 * `ArtPlayer.switchUrl` 内部等新地址的 `loadedmetadata`：死链（manifest 恒 502）
 * 上永不 resolve。那段原本是裸 `await`，于是整条切换协程挂死、串行队列的 running
 * 永不释放——**之后每次换集 / 换线都只进 pending 不执行**，用户看到的正是
 * 「判死后点『换下一条线路』毫无反应，错误卡也不消失」。
 *
 * 实测（2026-11-27）：死链判死后点换线，队列因 `peekRunning()` 还是那条卡住的
 * pick 而走 `same()` 早退，界面上什么都不会发生。
 *
 * 这里钉住三件事：封顶常量存在且早于出画封顶、switchUrl 在 race 里、定时器
 * 登记进切换句柄回收器。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const constant = (name: string) => {
  const hit = read("src/lib/constants.ts").match(
    new RegExp(`${name}\\s*=\\s*([\\d_]+)`),
  );
  return hit ? Number(hit[1].replace(/_/g, "")) : Number.NaN;
};

describe("原地换集不会因死链把队列挂死", () => {
  it("地址挂上的封顶比分出画更早，且留出余量", () => {
    const attach = constant("SWITCH_URL_ATTACH_CAP_MS");
    const source = constant("SWITCH_SOURCE_CAP_MS");
    expect(Number.isNaN(attach)).toBe(false);
    expect(attach).toBeGreaterThan(0);
    expect(attach).toBeLessThan(source);
  });

  it("switchUrl 的等待被包在带超时的 race 里", () => {
    const engine = read("src/hooks/usePlayerEngine.ts");
    expect(engine).toContain("SWITCH_URL_ATTACH_CAP_MS");
    // 裸 await 是回退信号：必须成对出现 race + 超时 Promise。
    expect(engine).not.toMatch(/await art\.switchUrl\(url\);/);
    expect(engine).toMatch(
      /Promise\.race\(\[[\s\S]{0,400}art\.switchUrl\(url\)[\s\S]{0,400}SWITCH_URL_ATTACH_CAP_MS/,
    );
  });

  it("超时定时器登记进切换句柄回收器", () => {
    const engine = read("src/hooks/usePlayerEngine.ts");
    const start = engine.indexOf("Promise.race([");
    expect(start, "锚点丢失：race 写法变了？").toBeGreaterThanOrEqual(0);
    const block = engine.slice(start, start + 900);
    expect(block).toContain("trackSwitchDisposer");
  });
});
