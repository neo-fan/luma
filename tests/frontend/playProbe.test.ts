/**
 * 线路探活的判据：HTTP 200 不等于「能播」。
 *
 * py_bubuzhuiju 的 PAN1 走网盘解析接口，token 失效时仍回 200 +
 * `{"code":201,"msg":"解析失败了","url":""}`。旧实现只看 response.ok，把这条
 * 死线路当成可用线路切过去，hls.js 拿到 JSON 后报 manifestParsingError。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probePlayable } from "../../src/lib/playProbe";

const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  g.window = { setTimeout, clearTimeout };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete g.window;
  delete g.fetch;
});

function stubFetch(impl: () => Promise<unknown>) {
  g.fetch = vi.fn(impl);
}

describe("probePlayable", () => {
  it("accepts a real m3u8 body", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => "#EXTM3U\n#EXTINF:4,\nseg.ts\n",
    }));
    await expect(probePlayable("http://127.0.0.1:9978/proxy?url=x", "hls")).resolves.toBe(true);
  });

  it("rejects a 200 JSON payload from a dead netdisk resolver", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"code":201,"msg":"解析失败了","url":""}',
    }));
    await expect(probePlayable("http://127.0.0.1:9978/proxy?url=x", "hls")).resolves.toBe(false);
  });

  it("rejects an HTML error page served in place of a manifest", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => "<html><body>频道不存在</body></html>",
    }));
    await expect(probePlayable("http://127.0.0.1:9978/proxy?url=x", "hls")).resolves.toBe(false);
  });

  it("keeps the old ok/405/416 rule for direct media", async () => {
    stubFetch(async () => ({ ok: false, status: 416, text: async () => "" }));
    await expect(probePlayable("http://127.0.0.1:9978/proxy?url=y", "file")).resolves.toBe(true);

    stubFetch(async () => ({ ok: false, status: 404, text: async () => "" }));
    await expect(probePlayable("http://127.0.0.1:9978/proxy?url=y", "file")).resolves.toBe(false);
  });

  it("treats a network failure as unplayable", async () => {
    stubFetch(async () => {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    });
    await expect(probePlayable("http://127.0.0.1:9978/proxy?url=z", "hls")).resolves.toBe(false);
  });
});
