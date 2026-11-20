/**
 * 断流后必须在原地重连，而不是让用户刷新页面。
 *
 * 这一层不跑真实 MSE（jsdom 没有），按源码文本钉住这次回归的两个成因：
 *
 * 1. hls.js 报 fatal 时**已经停止拉流**。以前「时间型失败」直接 `return` 交给
 *    看门狗复核，而看门狗面对「上游一个字节都不回」只能得出 `unknown`
 *    （证据不足、不判死），于是画面永久转圈——现网唯一出路是刷新整个页面。
 * 2. 反代用 `ClientBuilder::timeout`（整个请求的墙钟截止）搬运分片：慢 CDN 上
 *    一个 9MB 分片读到 20 秒就被掐断，播放器收到半截分片 → `fragLoadError`。
 *    分片该下多久由带宽决定，卡住要由「读不到数据」判定，不能用总时长。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const decoders = readFileSync(resolve(here, "../../src/hooks/playerDecoders.ts"), "utf8");
const proxyMod = readFileSync(resolve(here, "../../src-tauri/src/domain/proxy/mod.rs"), "utf8");

describe("in-place reconnect after a fatal network error", () => {
  it("retries the same url before reporting failure", () => {
    // 退避表就是预算：4 次，约 12 秒。改成 0 次等于回到「只能刷新」。
    expect(decoders).toContain("const RETRY_DELAYS_MS = [800, 1_600, 3_200, 6_400] as const;");
    // 时间型致命错误先走重连；顺序反了就等于永不重连。
    const retry = decoders.indexOf("if (timing && retryInPlace(");
    const failover = decoders.indexOf("host.session.failover(");
    expect(retry).toBeGreaterThan(-1);
    expect(failover).toBeGreaterThan(retry);
    // 恢复动作必须是 hls.js 官方给 network-error 的 startLoad()，不是换地址。
    expect(decoders).toContain("hls.startLoad();");
    expect(decoders).not.toContain("hls.loadSource(url);\n      }, delay);");
  });

  it("reloads the manifest when the manifest itself never arrived", () => {
    // `startLoad()` 在 levels 为空时是空操作（hls.js StreamController），
    // 清单级失败只重连分片等于没重连。
    expect(decoders).toContain('retryInPlace(String(data.details ?? "").startsWith("manifest"))');
    expect(decoders).toContain("hls.loadSource(url);");
  });

  it("resets the budget once fragments flow again", () => {
    // 播了十分钟再抖一次，应该重新拥有完整预算，而不是永久用光。
    const fragLoaded = decoders.indexOf("hls.on(Hls.Events.FRAG_LOADED");
    const reset = decoders.indexOf("retryCount = 0;", fragLoaded);
    expect(fragLoaded).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(fragLoaded);
  });

  it("never leaves a reconnect timer running past teardown", () => {
    // 换集/换源会销毁旧解码器；残留定时器只会对着已销毁的 Hls 调 startLoad。
    const destroy = decoders.indexOf("const destroy = () => {");
    const cancel = decoders.indexOf("cancelRetry();", destroy);
    expect(destroy).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(destroy);
    expect(cancel).toBeLessThan(decoders.indexOf("hls.destroy();", destroy));
  });

  it("tells the user it is reconnecting instead of staying silent", () => {
    expect(decoders).toContain("正在重连");
    // 过程态走播放器内 notice，不占用错误卡片。
    expect(decoders).toContain("host.ui.notice(");
  });
});

describe("proxy streaming timeouts", () => {
  it("bounds connect and idle reads, not the whole request", () => {
    expect(proxyMod).toContain(".connect_timeout(UPSTREAM_CONNECT_TIMEOUT)");
    expect(proxyMod).toContain(".read_timeout(UPSTREAM_READ_TIMEOUT)");
    // 这条就是本次卡住的根因：总时长截止会把「慢但在下」的分片掐断。
    expect(proxyMod).not.toContain(".timeout(UPSTREAM_TIMEOUT)");
  });
});