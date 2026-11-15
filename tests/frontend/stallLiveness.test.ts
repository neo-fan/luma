/**
 * 卡顿看门狗的「慢 ≠ 死」契约。
 *
 * 这一层不跑真实视频（jsdom 没有 MSE），所以按源码文本钉住几条不能丢的判据：
 *
 * 1. `unknown` 要累计到阈值才换线，不能一次探活失败就跳；
 * 2. 暂停不参与判死，且暂停期间存活计时不能继续老化；
 * 3. 反代字节在涨（极慢源）也算活：`/meter` 的 `bytesTotal` 增长要把
 *    `unresponsiveProbes` 清零，否则 1~2 KB/s 的源会被误判成死线。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const engine = readFileSync(resolve(here, "../../src/hooks/usePlayerEngine.ts"), "utf8");

describe("stall watchdog", () => {
  it("needs repeated unknown probes before switching lines", () => {
    expect(engine).toContain("const STALL_UNRESPONSIVE_LIMIT = 3;");
    expect(engine).toContain("unresponsiveProbes += 1;");
    expect(engine).toContain("unresponsiveProbes >= STALL_UNRESPONSIVE_LIMIT");
    expect(engine).toContain("stall probe unresponsive");
  });

  it("never treats a paused video as a dead line", () => {
    expect(engine).toContain("if (video.paused && !video.ended)");
    // 暂停时把存活计时推到当前时刻：恢复播放后重新计窗口，而不是立刻判死。
    expect(engine).toContain("lastAliveAt = Date.now();");
  });

  it("counts proxy byte growth as a liveness signal", () => {
    expect(engine).toContain("bytesTotal");
    expect(engine).toContain("lastMeterTotal");
    // 关键顺序：先看字节有没有涨，再看控件是否还在（控件收起时也要记活）。
    const totalCheck = engine.indexOf("total > lastMeterTotal");
    const elementGuard = engine.indexOf("if (!speedEl) return;");
    expect(totalCheck).toBeGreaterThan(-1);
    expect(elementGuard).toBeGreaterThan(-1);
    expect(totalCheck).toBeLessThan(elementGuard);
    expect(engine).toContain("unresponsiveProbes = 0;");
  });
});
