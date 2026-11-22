/**
 * 直播失败归类契约。
 *
 * 直播页只有「刷新 / 换线路 / 换频道」三个动作，所以文案必须回答**哪一步失败**，
 * 而不是把 hls.js / Rust 的原始报错直接甩给用户。这里守住两件事：
 *   1. `src/lib/playErrors.ts` 的纯函数能把已知失败分到正确的原因；
 *   2. `src/pages/LivePage.tsx` 真的走这套分类，且保留探针依赖的 `.tip` 与
 *      ErrorBar 的「主文案 + 归因 + 技术详情」结构。
 *
 * 文案会随体验迭代，所以断言的是「原因 + 动作关键词」，不逐字锁定全文。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyLiveFailure,
  liveFailureMessage,
} from "../../src/lib/playErrors";

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("classifyLiveFailure 原因判定", () => {
  it("阶段确证的结论优先：所有线路都试过 → lines", () => {
    const info = classifyLiveFailure({
      stage: "exhausted",
      message: "视频分片解码失败",
    });
    expect(info.reason).toBe("lines");
    expect(info.hint).toContain("换一个频道");
  });

  it("阶段确证的结论优先：页面型地址嗅探不到源 → sniff", () => {
    const info = classifyLiveFailure({
      stage: "sniff",
      message: "源站超时",
    });
    expect(info.reason).toBe("sniff");
    expect(info.message).toContain("嗅探");
  });

  it("SITE_TIMEOUT 与「源响应超时」都归到 timeout", () => {
    expect(classifyLiveFailure({ code: "SITE_TIMEOUT" }).reason).toBe("timeout");
    const info = classifyLiveFailure({
      message:
        "源响应超时（首次加载源侧冷启动较慢），已保留当前线路，点刷新可重试",
    });
    expect(info.reason).toBe("timeout");
    expect(info.hint).toContain("刷新");
  });

  it("网盘 token / 私有 scheme 归到 plugin（源侧插件解析）", () => {
    const netdisk = classifyLiveFailure({
      message: "该线路需要源侧插件解析（网盘 token），内置播放器无法直接播放",
    });
    expect(netdisk.reason).toBe("plugin");
    expect(netdisk.message).toContain("插件解析");

    const scheme = classifyLiveFailure({
      code: "RUNTIME_UNAVAILABLE",
      message:
        'play url scheme `magnet` could not be resolved; available parsers: ["http"]',
    });
    expect(scheme.reason).toBe("plugin");
  });

  it("嗅探器找不到媒体地址 → sniff", () => {
    expect(
      classifyLiveFailure({ message: "sniffer found no media url" }).reason,
    ).toBe("sniff");
  });

  it("连接被拒绝 / DNS / 断网 → network，而不是 timeout", () => {
    const info = classifyLiveFailure({ message: "Connection refused" });
    expect(info.reason).toBe("network");
    expect(info.hint).toContain("网络");
  });

  it("解码失败 / 内核不支持该封装 → decode", () => {
    expect(
      classifyLiveFailure({ message: "HLS 播放失败：视频分片解码失败" }).reason,
    ).toBe("decode");
    expect(
      classifyLiveFailure({
        message: "当前环境不支持 HLS 内置播放，可尝试换源或稍后重试。",
      }).reason,
    ).toBe("decode");
  });

  it("单线路判死给出「换频道」结论，但不覆盖已知原因", () => {
    const bare = classifyLiveFailure({ stage: "single-line" });
    expect(bare.message).toContain("换一个频道");
    expect(bare.hint).toContain("只有一条线路");

    const known = classifyLiveFailure({
      stage: "single-line",
      message: "源响应超时，点刷新重试",
    });
    expect(known.reason).toBe("timeout");
    expect(known.message).toContain("超时");
  });

  it("未知原因与空输入走兜底 unknown", () => {
    expect(classifyLiveFailure({ message: "boom" }).reason).toBe("unknown");
    expect(classifyLiveFailure().reason).toBe("unknown");
  });

  it("明确错误码优先于 message 关键词", () => {
    const info = classifyLiveFailure({
      code: "SITE_TIMEOUT",
      message: "视频分片解码失败",
    });
    expect(info.reason).toBe("timeout");
  });

  it("输出形状固定为 {reason, message, hint}，且不把 URL 塞进主文案", () => {
    const samples = [
      classifyLiveFailure({ stage: "exhausted" }),
      classifyLiveFailure({ message: "网盘 token 缺失" }),
      classifyLiveFailure({ message: "Connection refused" }),
      classifyLiveFailure(),
    ];
    for (const info of samples) {
      expect(Object.keys(info).sort()).toEqual(["hint", "message", "reason"]);
      expect(info.message.length).toBeGreaterThan(0);
      expect(info.hint.length).toBeGreaterThan(0);
      expect(info.message).not.toContain("http");
      expect(info.hint).not.toContain("http");
    }
  });

  it("liveFailureMessage 只是主文案入口", () => {
    expect(liveFailureMessage({ stage: "exhausted" })).toBe(
      classifyLiveFailure({ stage: "exhausted" }).message,
    );
  });
});

describe("LivePage 接入分类文案", () => {
  const page = read("src/pages/LivePage.tsx");

  it("用 classifyLiveFailure / liveFailureMessage 生成提示", () => {
    expect(page).toContain("classifyLiveFailure");
    expect(page).toContain("liveFailureMessage");
    expect(page).toContain('stage: "exhausted"');
    expect(page).toContain('stage: "single-line"');
    expect(page).toContain("hint={");
  });

  it("换线/换台提示进播放器 notice，ErrorBar 保留主文案 / 归因 / 详情结构", () => {
    // 播放相关提示统一进播放器 notice，不再挂在页顶 .tip。
    expect(page).not.toContain('<p className="tip">');
    expect(page).toContain("engine.notice(text)");
    expect(page).toContain("const text = switchTip || slowNotice;");
    expect(page).toContain('lifetime="timed"');
    expect(page).toContain('lifetime={resolveError ? "timed" : "sticky"}');
    expect(page).toContain("resolveFailure?.message");
  });
});

describe("换线尝试预算：只允许自动换线路，绝不自动换台/换源", () => {
  const page = read("src/pages/LivePage.tsx");

  it("预算闸在 switchOrFailover 里、线路数多于预算才生效", () => {
    expect(page).toContain("LIVE_LINE_ATTEMPTS");
    expect(page).toContain(
      "total > LIVE_LINE_ATTEMPTS && tried.size >= LIVE_LINE_ATTEMPTS",
    );
    expect(page).toContain('reason: "probe-limit"');
    expect(page).toContain('stage: "probe-limit"');
  });

  it("手动刷新重新起一轮：换线预算一起归零", () => {
    // 没有这句，刷新后预算用完的频道一条线路都不敢再试。
    expect(page).toContain("换线尝试预算必须一起归零");
  });

  it("probe-limit 结论如实说「已停止」，不冒充「所有线路都试过」，动作留给用户", () => {
    const info = classifyLiveFailure({ stage: "probe-limit" });
    expect(info.message).toContain("已停止自动换线");
    expect(info.message).not.toContain("所有线路");
    expect(info.hint).toContain("不会替你换台");
    expect(info.hint).toContain("换一个频道");
  });

  it("线路少于预算的频道保持穷尽口径：全部试过才说「所有线路」", () => {
    const info = classifyLiveFailure({ stage: "exhausted" });
    expect(info.message).toContain("所有线路");
  });
});
