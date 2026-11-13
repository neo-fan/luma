import { describe, expect, it } from "vitest";
import { classifyFailure, groupFailures } from "./failureReason";

describe("classifyFailure", () => {
  it("按错误码归类（最可靠路径）", () => {
    expect(classifyFailure("SITE_TIMEOUT", "whatever").kind).toBe("timeout");
    expect(classifyFailure("RUNTIME_UNAVAILABLE", "jar 缺失").kind).toBe("runtime");
    expect(classifyFailure("SPIDER_CRASH", "py 崩了").kind).toBe("runtime");
    expect(classifyFailure("CONFIG_FETCH_FAIL", "取配置失败").kind).toBe("network");
  });

  it("源站直抛的错没有错误码时按消息特征归类", () => {
    expect(classifyFailure(undefined, "read timed out").kind).toBe("timeout");
    expect(classifyFailure(undefined, "站点要求验证码验证").kind).toBe("captcha");
    expect(classifyFailure(undefined, "mismatched tag: line 25, column 2").kind).toBe("parse");
    expect(classifyFailure(undefined, "unexpected token < in JSON").kind).toBe("parse");
    expect(classifyFailure(undefined, "Connection refused").kind).toBe("network");
  });

  it("兜底为 unknown，不丢信息", () => {
    const r = classifyFailure(undefined, "某种没见过的情况");
    expect(r.kind).toBe("unknown");
    expect(r.label).toBe("源站未响应");
    expect(r.raw).toBe("某种没见过的情况");
  });

  it("错误码优先于消息特征", () => {
    // 有明确错误码时以错误码为准，不被消息里的关键词带偏
    expect(classifyFailure("SITE_TIMEOUT", "jar 崩溃").kind).toBe("timeout");
  });

  it("界面文案不含原始 URL / 解析器位置", () => {
    const r = classifyFailure(undefined, "fetch https://caj.dbzy5.com/api.php/x failed");
    expect(r.label).not.toContain("http");
    expect(r.hint).not.toContain("http");
    // 原文仍保留在 raw 里，供日志与诊断使用
    expect(r.raw).toContain("https://caj.dbzy5.com");
  });

  it("空 message 与空 code 都能兜住", () => {
    expect(classifyFailure(undefined, undefined).kind).toBe("unknown");
    expect(classifyFailure("", "").raw).toBe("");
  });
});

describe("groupFailures", () => {
  it("按类型聚合并按数量降序", () => {
    const groups = groupFailures([
      { code: "SITE_TIMEOUT" },
      { code: "SITE_TIMEOUT" },
      { code: "SITE_TIMEOUT" },
      { message: "需要验证码" },
      { message: "mismatched tag: line 25, column 2" },
    ]);
    expect(groups[0].kind).toBe("timeout");
    expect(groups[0].count).toBe(3);
    expect(groups.map((g) => g.count)).toEqual([...groups.map((g) => g.count)].sort((a, b) => b - a));
    expect(groups.reduce((sum, g) => sum + g.count, 0)).toBe(5);
  });

  it("同频时按固定顺序（超时在前）", () => {
    const groups = groupFailures([
      { message: "mismatched tag: line 1" },
      { code: "SITE_TIMEOUT" },
    ]);
    expect(groups[0].kind).toBe("timeout");
  });

  it("空数组返回空列表", () => {
    expect(groupFailures([])).toEqual([]);
  });

  it("分组标签不含原始报错", () => {
    const groups = groupFailures([{ message: "fetch https://x.com/a failed" }]);
    expect(groups[0].label).not.toContain("http");
    expect(groups[0].hint).not.toContain("http");
  });
});
