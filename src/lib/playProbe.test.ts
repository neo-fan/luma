/**
 * 线路探活的判据：HTTP 200 不等于「能播」。
 *
 * py_bubuzhuiju 的 PAN1 走网盘解析接口，token 失效时仍回 200 +
 * `{"code":201,"msg":"解析失败了","url":""}`；只看 response.ok 会把这条死线路
 * 当成可用切过去，hls.js 拿到 JSON 后报 manifestParsingError。所以判据必须读 body。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeLineVerdict, probePlayable } from "./playProbe";

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

  /**
   * 占位图假流：清单是合法 #EXTM3U，但分片是 1×1 透明 PNG（实测 PAN1/NBY）。
   * 只校验清单头会把死线路判活，用户先看十几秒转圈才被看门狗判死。
   */
  it("rejects a manifest whose first segment is a placeholder image", async () => {
    let call = 0;
    g.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, text: async () => "#EXTM3U\n#EXTINF:22,\nseg0.ts\n" };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        body: { cancel: async () => {} },
      };
    });
    await expect(probePlayable("http://127.0.0.1:9978/proxy?url=x", "hls")).resolves.toBe(false);
  });

  it("accepts a manifest whose first segment is real MPEG-TS", async () => {
    let call = 0;
    g.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, text: async () => "#EXTM3U\n#EXTINF:6,\nseg0.ts\n" };
      }
      return {
        ok: true,
        status: 206,
        headers: { get: () => "video/mp2t" },
        body: { cancel: async () => {} },
      };
    });
    await expect(probePlayable("http://127.0.0.1:9978/proxy?url=x", "hls")).resolves.toBe(true);
  });

  it("rejects a manifest whose first segment 404s", async () => {
    let call = 0;
    g.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, text: async () => "#EXTM3U\n#EXTINF:6,\nseg0.ts\n" };
      }
      return { ok: false, status: 404, headers: { get: () => null }, body: { cancel: async () => {} } };
    });
    await expect(probePlayable("http://127.0.0.1:9978/proxy?url=x", "hls")).resolves.toBe(false);
  });
});

/**
 * 三态判定：播放页「卡住要不要换走」只认 `dead`。
 *
 * 2026-11-14 用户实测：某条线路 20 秒后才出画，却被旧的「12 秒静默即判死」
 * 跳到了别的源。时间不是证据——超时只说明「还没回话」，必须归 unknown。
 */
describe("probeLineVerdict", () => {
  it("says dead only when the source clearly refuses", async () => {
    stubFetch(async () => ({ ok: false, status: 403, text: async () => "" }));
    await expect(probeLineVerdict("http://x/proxy?url=a", "hls")).resolves.toBe("dead");
  });

  it("says ok for a real manifest", async () => {
    stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => "#EXTM3U\n#EXTINF:4,\nseg.ts\n",
    }));
    await expect(probeLineVerdict("http://x/proxy?url=a", "hls")).resolves.toBe("ok");
  });

  it("says unknown when the request is aborted by our own timeout", async () => {
    stubFetch(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(probeLineVerdict("http://x/proxy?url=a", "hls", 50)).resolves.toBe("unknown");
  });

  it("says unknown on a transient connection failure", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(probeLineVerdict("http://x/proxy?url=a", "hls", 50)).resolves.toBe("unknown");
  });
});
