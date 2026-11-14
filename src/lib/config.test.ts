import { describe, expect, it } from "vitest";
import {
  cleanConfigName,
  configNameFromUrl,
  describeConfigSource,
  formatImportedAt,
} from "./config";

describe("configNameFromUrl", () => {
  it("取域名并去掉 www 前缀", () => {
    expect(configNameFromUrl("https://www.例子.测试/tv/box.json")).toBe("例子.测试");
    expect(configNameFromUrl("http://example.com:8080/api.json")).toBe("example.com");
  });

  it("中文域名保留原字符，不转成 punycode", () => {
    expect(configNameFromUrl("https://例子.测试/api.json")).toBe("例子.测试");
  });

  it("缺少协议时也能解析（用户常这样粘贴）", () => {
    expect(configNameFromUrl("box.example.org/api.json")).toBe("box.example.org");
  });

  it("IPv6 主机保留方括号", () => {
    expect(configNameFromUrl("http://[::1]:8787/api.json")).toBe("[::1]");
  });

  it("空串或半截输入不报错，交给后端兜底", () => {
    expect(configNameFromUrl("")).toBe("");
    expect(configNameFromUrl("   ")).toBe("");
    expect(configNameFromUrl("http://")).toBe("");
    expect(configNameFromUrl("not a url")).toBe("");
  });
});

describe("cleanConfigName", () => {
  it("去首尾空白与控制字符", () => {
    expect(cleanConfigName("  我的配置\n")).toBe("我的配置");
    expect(cleanConfigName("a\tb")).toBe("ab");
    expect(cleanConfigName("   ")).toBe("");
  });

  it("限制长度，避免列表换行", () => {
    expect(cleanConfigName("x".repeat(80))).toHaveLength(48);
    expect(cleanConfigName("x".repeat(80), 8)).toHaveLength(8);
  });
});

describe("describeConfigSource", () => {
  it("URL 只显示域名，文本与文件给中文说明", () => {
    expect(describeConfigSource({ kind: "url", value: "https://www.a.com/x.json" })).toBe("a.com");
    expect(describeConfigSource({ kind: "text", value: "{}" })).toBe("粘贴文本");
    expect(describeConfigSource({ kind: "file", value: "C:\\tmp\\box.json" })).toBe("文件 · box.json");
    expect(describeConfigSource(undefined)).toBe("未知来源");
  });
});

describe("formatImportedAt", () => {
  it("按本地时区格式化到分钟", () => {
    const iso = new Date(2026, 0, 2, 3, 4, 5).toISOString();
    expect(formatImportedAt(iso)).toBe("2026-01-02 03:04");
  });

  it("解析失败时原样返回", () => {
    expect(formatImportedAt("not-a-date")).toBe("not-a-date");
  });
});
