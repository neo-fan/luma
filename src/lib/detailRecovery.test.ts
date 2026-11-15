/**
 * Regression guard for "详情加载失败：未获取到影片详情".
 *
 * Two distinct defects were involved:
 *  1. `adapterlog` was imported before pyrun.py fixed up sys.path. The bundled
 *     embeddable CPython (`python311._pth`) does not add the script directory,
 *     so every py spider child died with ModuleNotFoundError and produced no
 *     frame. Diagnostics must never be a hard dependency.
 *  2. A source that genuinely returns `{"list": []}` (e.g. discovery-only
 *     spiders such as douban.py) left the user on a dead-end page with no
 *     context and no recovery path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { MIN_RECOVERY_SCORE, pickRecoveryCandidate } from "./detailRecovery";
import { api } from "./invoke";
import { pageCache } from "./pageCache";
import type { VodInfo } from "../types/luma";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const invokeMock = vi.mocked(invoke);

const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

const vod = (id: string, name: string): VodInfo => ({
  vod_id: id,
  vod_name: name,
  vod_pic: "",
  vod_play_from: "line",
  vod_play_url: `1$https://example.invalid/${id}.m3u8`,
});

describe("api.detail recovery (mocked IPC)", () => {
  const spiderCalls = () =>
    invokeMock.mock.calls
      .map((entry) => (entry[1] as { request?: { method?: string; args?: unknown[] } } | undefined)?.request)
      .filter((req): req is { method: string; args: unknown[] } => Boolean(req?.method));

  beforeEach(() => {
    pageCache.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd !== "spider_invoke") {
        return {};
      }
      const req = (args as { request?: { method?: string; args?: unknown[] } })?.request;
      if (req?.method === "detailContent") {
        // The stale id returns an empty list; the fresh one resolves.
        return req.args?.[0] === "42" ? [] : [vod("43", "走马上任")];
      }
      if (req?.method === "searchContent") {
        return {
          list: [vod("42", "走马上任"), vod("43", "走马上任")],
          filters: {},
          pagecount: 1,
          page: 1,
          limit: 20,
          total: 2,
        };
      }
      return [];
    });
  });

  it("recovers an empty detail and caches the recovered list", async () => {
    const first = await api.detail("py_douban", "42", false, "走马上任");
    expect(first.map((item) => item.vod_id)).toEqual(["43"]);
    expect(spiderCalls().map((req) => req.method)).toEqual([
      "detailContent",
      "searchContent",
      "detailContent",
    ]);
    expect(spiderCalls()[2].args).toEqual(["43"]);

    // The recovered result was written back under the original key.
    const second = await api.detail("py_douban", "42", false, "走马上任");
    expect(second.map((item) => item.vod_id)).toEqual(["43"]);
    expect(spiderCalls()).toHaveLength(3);
  });

  it("does not search when no title is known (warm-up / player callers)", async () => {
    const out = await api.detail("py_douban", "42");
    expect(out).toEqual([]);
    expect(spiderCalls().map((req) => req.method)).toEqual(["detailContent"]);
  });

  it("skips a doomed IPC when the vod id is empty", async () => {
    await api.detail("py_douban", "", false, "走马上任");
    expect(spiderCalls().map((req) => req.method)).toEqual([
      "searchContent",
      "detailContent",
    ]);
  });
});

describe("pickRecoveryCandidate", () => {
  it("prefers an exact title match over a weak one", () => {
    const list = [vod("1", "走马上任 花絮"), vod("2", "走马上任"), vod("3", "上任")];
    expect(pickRecoveryCandidate(list, "走马上任", "999")?.vod_id).toBe("2");
  });

  it("skips the id that already produced the empty detail", () => {
    const list = [vod("42", "走马上任"), vod("43", "走马上任 第二季")];
    expect(pickRecoveryCandidate(list, "走马上任", "42")?.vod_id).toBe("43");
  });

  it("refuses weak matches so recovery never opens the wrong film", () => {
    expect(MIN_RECOVERY_SCORE).toBe(2);
    expect(pickRecoveryCandidate([vod("1", "完全无关")], "走马上任", "9")).toBeNull();
  });

  it("is a no-op without a title, a list, or an id", () => {
    expect(pickRecoveryCandidate([], "走马上任", "9")).toBeNull();
    expect(pickRecoveryCandidate([vod("1", "走马上任")], "", "9")).toBeNull();
    expect(pickRecoveryCandidate([{ ...vod("", "走马上任") }], "走马上任", "9")).toBeNull();
  });
});

describe("py adapter: diagnostics must not break the protocol", () => {
  it("fixes sys.path before importing any local module", () => {
    const pyrun = read("sidecars/py/pyrun.py");
    const insert = pyrun.indexOf("sys.path.insert(0, _HERE)");
    const localImport = pyrun.indexOf("from adapterlog import");
    expect(insert).toBeGreaterThan(-1);
    expect(localImport).toBeGreaterThan(insert);
    // A missing log module degrades to a no-op instead of killing every spider.
    expect(pyrun).toContain("except ImportError:");
    expect(pyrun).toContain("def log_crash(**_kwargs: object)");
  });

  it("passes the adapter dir to the child via PYTHONPATH", () => {
    const pyspider = read("sidecars/py/pyspider.py");
    expect(pyspider).toContain('env["PYTHONPATH"]');
    expect(pyspider).toContain("env=env,");
    expect(pyspider).toContain("except ImportError:");
  });

  it("logs empty detail from the host with the script url and vod id", () => {
    // Normalization moved into Rust so the adapter only executes scripts; the
    // diagnostic has to survive the move or "未获取到影片详情" is untraceable again.
    const runtime = read("src-tauri/src/domain/spider/python.rs");
    expect(runtime).toContain("spider detailContent returned no video");
    expect(runtime).toContain('source_api = %api, vod_id = %vod_id');
  });

  it("normalizes every common detailContent shape in Rust", () => {
    const parse = read("src-tauri/src/domain/spider/cms_parse.rs");
    expect(parse).toContain("fn detail_items(");
    expect(parse).toContain('["list", "data", "result", "vod"]');
    expect(parse).toContain("pub(crate) fn normalize_spider_result(");
  });
});

describe("frontend: empty detail is visible and recoverable", () => {
  it("logs the empty result and tries a title-based recovery", () => {
    const invoke = read("src/lib/invoke.ts");
    expect(invoke).toContain('log.warn("detail empty"');
    expect(invoke).toContain("async function recoverDetail(");
    expect(invoke).toContain("pageCache.put(cacheKey, list, CACHE_TTL.detail)");
  });

  it("passes the known film title from the detail page", () => {
    const page = read("src/pages/DetailPage.tsx");
    // 允许格式化器把调用拆成多行：断言的是「传了片名」，不是排版。
    expect(page).toMatch(/api\.detail\([\s\S]{0,160}reload > 0,[\s\S]{0,80}\.trim\(\)/);
    // 空列表不等于请求失败：文案要说清「这个源没有播放列表」，并区分是否为
    // 已经证实过的榜单/推荐源（noDetailSources 记忆）。
    expect(page).toContain("不提供播放列表");
    expect(page).toContain("只提供榜单/推荐");
    expect(page).toContain("noDetailSources.has(siteKey)");
  });
});
