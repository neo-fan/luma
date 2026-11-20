/**
 * `player` 路由构造：可选字段只在有值时出现。
 *
 * 播放页依赖 `playFrom` 找线路 headers、依赖 `failoverKey` 续上自动换线账本；
 * 空串 / undefined 传进去会让新页面拿 `undefined` 当线路名去问源站。这里钉住
 * 「没有就真的没有」，避免调用点各自写对象字面量时把空串塞进去。
 */
import { describe, expect, it } from "vitest";
import { playerRoute } from "./playerRoute";

describe("playerRoute", () => {
  it("keeps the required fields and drops empty optional ones", () => {
    expect(
      playerRoute({
        siteKey: "s1",
        vodId: "42",
        vodName: "庆余年",
        playUrl: "https://cdn.example/1.m3u8",
        episodeName: "第01集",
        playFrom: "",
        failoverKey: "",
      }),
    ).toEqual({
      name: "player",
      siteKey: "s1",
      vodId: "42",
      vodName: "庆余年",
      playUrl: "https://cdn.example/1.m3u8",
      episodeName: "第01集",
    });
  });

  it("carries the line name and ledger key for cross-page hops", () => {
    const route = playerRoute({
      siteKey: "s2",
      vodId: "7",
      vodName: "庆余年",
      playUrl: "https://cdn.example/2.m3u8",
      episodeName: "第02集",
      playFrom: "线路二",
      failoverKey: "庆余年",
    });
    expect(route.playFrom).toBe("线路二");
    expect(route.failoverKey).toBe("庆余年");
    expect(route.name).toBe("player");
  });
});
