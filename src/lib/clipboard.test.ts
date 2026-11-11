import { describe, expect, it } from "vitest";
import { copyText } from "./clipboard";

describe("copyText", () => {
  it("优先用可用 writer，原文一字不改地写入", async () => {
    const written: string[] = [];
    const result = await copyText("播放地址解析失败：404", {
      writeText: async (text) => {
        written.push(text);
      },
    });
    expect(result).toBe("ok");
    expect(written).toEqual(["播放地址解析失败：404"]);
  });

  it("现代 API 抛错且无 DOM 兜底时返回 failed，不抛异常", async () => {
    const result = await copyText("boom", {
      writeText: async () => {
        throw new Error("permission denied");
      },
    });
    // node 环境没有 document，execCommand 兜底也不可用。
    expect(result).toBe("failed");
  });

  it("无 navigator / 无 document 时安全返回 failed", async () => {
    await expect(copyText("boom")).resolves.toBe("failed");
  });
});
