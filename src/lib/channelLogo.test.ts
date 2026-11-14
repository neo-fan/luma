/**
 * 台标候选：`fanmingming/live` 仓库按频道名存 PNG，所以「猜名字」的顺序很关键。
 *
 * 两类真实踩坑都锁在用例里：
 * 1. `CCTV4K` 必须先试原名——仓库里真有 `CCTV4K.png`，先收敛成 `CCTV4` 会显示
 *    成「CCTV-4」的台标；
 * 2. `CCTV-1 综合` 这种写法必须先收敛成 `CCTV1` 才能命中，仓库里没有带「综合」的图。
 */
import { describe, expect, it } from "vitest";
import { channelLogoNames, channelLogoUrls } from "./channelLogo";

describe("channelLogoNames", () => {
  it("标准频道名原样使用", () => {
    expect(channelLogoNames("CCTV1")).toEqual(["CCTV1"]);
    expect(channelLogoNames("湖南卫视")).toEqual(["湖南卫视"]);
  });

  it("CCTV-1 综合 收敛成 CCTV1，且保留原名作为第一候选", () => {
    const names = channelLogoNames("CCTV-1 综合");
    expect(names[0]).toBe("CCTV-1 综合");
    expect(names).toContain("CCTV1");
  });

  it("CCTV4K 不会被提前收敛成 CCTV4", () => {
    const names = channelLogoNames("CCTV4K");
    expect(names[0]).toBe("CCTV4K");
    expect(names).not.toContain("CCTV4");
  });

  it("去掉画质后缀", () => {
    expect(channelLogoNames("东方卫视4K")).toContain("东方卫视");
    expect(channelLogoNames("湖南卫视高清")).toContain("湖南卫视");
    expect(channelLogoNames("CCTV5+")).toEqual(["CCTV5+"]);
  });

  it("空名字没有候选", () => {
    expect(channelLogoNames("")).toEqual([]);
    expect(channelLogoNames("   ")).toEqual([]);
  });
});

describe("channelLogoUrls", () => {
  it("源里给了 tvg-logo 就排第一，猜名作为兜底", () => {
    const urls = channelLogoUrls("CCTV1", "https://example.com/a.png");
    expect(urls[0]).toBe("https://example.com/a.png");
    expect(urls[1]).toContain("CCTV1.png");
  });

  it("非 http 的 logo 值被忽略", () => {
    const urls = channelLogoUrls("CCTV1", "not-a-url");
    expect(urls.every((url) => url.startsWith("https://"))).toBe(true);
  });

  it("中文名按 URL 编码，且先试完主基址再落到备站", () => {
    const urls = channelLogoUrls("湖南卫视");
    const encoded = encodeURIComponent("湖南卫视.png");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(encoded);
    expect(urls[1]).toContain(encoded);
    // 主基址（jsDelivr）在前，备站（raw）在后：候选之间不应该交替换站。
    expect(new URL(urls[0]).host).toBe("cdn.jsdelivr.net");
    expect(new URL(urls[1]).host).toBe("raw.githubusercontent.com");
  });

  it("多个候选情况下同一个基址先聚在一起", () => {
    const urls = channelLogoUrls("东方卫视4K");
    const hosts = urls.map((url) => new URL(url).host);
    const firstRaw = hosts.indexOf("raw.githubusercontent.com");
    expect(firstRaw).toBeGreaterThan(0);
    // raw 之后不应再出现 jsDelivr（说明没有按候选交替）。
    expect(hosts.slice(firstRaw).every((host) => host === "raw.githubusercontent.com")).toBe(true);
  });

  it("候选不重复", () => {
    const urls = channelLogoUrls("CCTV1");
    expect(new Set(urls).size).toBe(urls.length);
  });
});
