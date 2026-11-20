/**
 * 豆瓣信息补全的契约测试（2.0.0 push 模型）。
 *
 * 这条链路「坏了也不明显」：豆瓣拿不到时界面完全静默。所以守三层：
 * 1. `doubanSettings.ts` 持久化（纯函数，跑真代码）。
 * 2. `douban.ts` 的 push/store 行为：`douban_request` 触发、`douban-meta` 事件
 *    分 cover/full/none/error 驱动中心 store；同 key 去重；静默回退。
 * 3. 详情页/播放页/卡片/设置的挂载点与样式 token（源码 + CSS 不变量）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

import {
  DEFAULT_DOUBAN_PREFS,
  DOUBAN_PROXY_OPTIONS,
  readDoubanPrefs,
  writeDoubanPrefs,
} from "../../src/lib/doubanSettings";
import { readCss } from "./readCss";

// IPC 出口与日志被替身拦下：`doubanRequest` 记录调用，`onDoubanMeta` 把事件处理
// 函数交出来，测试据此模拟后端推送。node 环境即可跑完整 push/store 链路。
const bus = vi.hoisted(() => ({
  handler: null as null | ((evt: { key: string; phase: string; meta: unknown }) => void),
}));
vi.mock("../../src/lib/invoke", () => ({
  api: {
    doubanMeta: vi.fn(),
    doubanRequest: vi.fn(() => Promise.resolve()),
    onDoubanMeta: vi.fn((cb: (evt: never) => void) => {
      bus.handler = cb as unknown as typeof bus.handler;
      return Promise.resolve(() => undefined);
    }),
  },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("../../src/lib/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { api } from "../../src/lib/invoke";
import {
  clearDoubanMetaCache,
  doubanKey,
  fetchDoubanMeta,
  getDoubanFullSnapshot,
  getDoubanSnapshot,
  normalizeDoubanMeta,
  requestDouban,
} from "../../src/lib/douban";

// tests/frontend -> project root
const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

/** 内存版 Storage：node 环境没有 localStorage，也用不着 jsdom。 */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const KEY = "luma:douban:prefs";

describe("douban prefs storage", () => {
  it("defaults to enabled + direct when nothing is stored", () => {
    const storage = new MemoryStorage();
    expect(readDoubanPrefs(storage)).toEqual(DEFAULT_DOUBAN_PREFS);
    expect(DEFAULT_DOUBAN_PREFS).toEqual({
      enabled: true,
      proxyType: "direct",
      proxyPrefix: "",
    });
  });

  it("falls back to defaults on broken JSON and out-of-range values", () => {
    const broken = new MemoryStorage();
    broken.setItem(KEY, "{不是 JSON");
    expect(readDoubanPrefs(broken)).toEqual(DEFAULT_DOUBAN_PREFS);

    const nulled = new MemoryStorage();
    nulled.setItem(KEY, "null");
    expect(readDoubanPrefs(nulled)).toEqual(DEFAULT_DOUBAN_PREFS);

    const junk = new MemoryStorage();
    junk.setItem(
      KEY,
      JSON.stringify({ enabled: "yes", proxyType: "socks5", proxyPrefix: 42 }),
    );
    expect(readDoubanPrefs(junk)).toEqual(DEFAULT_DOUBAN_PREFS);
  });

  it("keeps an explicit enabled:false (关掉补全) across writes", () => {
    const storage = new MemoryStorage();
    writeDoubanPrefs({ enabled: false }, storage);
    expect(readDoubanPrefs(storage).enabled).toBe(false);
    writeDoubanPrefs({ proxyType: "cmliussss-cdn-tencent" }, storage);
    const prefs = readDoubanPrefs(storage);
    expect(prefs.enabled).toBe(false);
    expect(prefs.proxyType).toBe("cmliussss-cdn-tencent");
  });

  it("trims a custom prefix and drops it when the type is not custom", () => {
    const storage = new MemoryStorage();
    const written = writeDoubanPrefs(
      { proxyType: "custom", proxyPrefix: "  https://proxy.example/?url=  " },
      storage,
    );
    expect(written.proxyPrefix).toBe("https://proxy.example/?url=");
    expect(readDoubanPrefs(storage).proxyPrefix).toBe("https://proxy.example/?url=");
  });

  it("survives a storage that throws on read and on write", () => {
    const hostile: Storage = {
      length: 0,
      clear: () => undefined,
      getItem: () => {
        throw new Error("denied");
      },
      key: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readDoubanPrefs(hostile)).toEqual(DEFAULT_DOUBAN_PREFS);
    expect(writeDoubanPrefs({ enabled: false }, hostile).enabled).toBe(false);
  });

  it("offers exactly the five supported proxy modes", () => {
    expect(DOUBAN_PROXY_OPTIONS.map((item) => item.value)).toEqual([
      "direct",
      "custom",
      "cors-proxy-zwei",
      "cmliussss-cdn-tencent",
      "cmliussss-cdn-ali",
    ]);
    for (const option of DOUBAN_PROXY_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint.length).toBeGreaterThan(0);
    }
  });
});

describe("douban push/store behavior", () => {
  const doubanRequest = api.doubanRequest as unknown as Mock;

  const coverPayload = {
    id: "1291546",
    title: "霸王别姬",
    year: "1993",
    rating: 0,
    ratingCount: 0,
    intro: "",
    directors: [],
    actors: [],
    genres: [],
    pic: "https://img.example/cover.jpg",
    url: "https://movie.douban.com/subject/1291546/",
  };
  const fullPayload = {
    ...coverPayload,
    rating: 9.6,
    ratingCount: 2187654,
    intro: "段小楼与程蝶衣是一对打小一起长大的师兄弟……",
    directors: ["陈凯歌"],
    actors: ["张国荣", "张丰毅", "巩俐"],
    genres: ["剧情", "爱情"],
    pic: "https://img.example/pic.jpg",
  };

  /** 模拟后端把某 key 的事件推到前端 store。 */
  function push(key: string, phase: string, meta: unknown): void {
    expect(bus.handler, "onDoubanMeta 应已订阅").not.toBeNull();
    bus.handler!({ key, phase, meta });
  }

  beforeEach(() => {
    clearDoubanMetaCache();
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
    doubanRequest.mockReset();
    doubanRequest.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not request at all when the setting is off", async () => {
    writeDoubanPrefs({ enabled: false });
    expect(await fetchDoubanMeta("霸王别姬", "1993")).toBeNull();
    expect(doubanRequest).not.toHaveBeenCalled();
  });

  it("fires one request per title+year and resolves the promise on the full push", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    const key = doubanKey("霸王别姬", "1993");
    const pending = fetchDoubanMeta("霸王别姬", "1993");

    expect(doubanRequest).toHaveBeenCalledTimes(1);
    expect(doubanRequest).toHaveBeenCalledWith(
      "霸王别姬",
      "1993",
      "direct",
      undefined,
      false,
      key,
      undefined,
    );

    // 后端分两段推：cover 不结束 Promise，full 才终态。
    push(key, "cover", coverPayload);
    push(key, "full", fullPayload);
    const meta = await pending;
    expect(meta?.rating).toBe(9.6);
    expect(meta?.actors).toContain("张国荣");

    // 已有终态 → 第二次不再打后端。
    await fetchDoubanMeta("霸王别姬", "1993");
    expect(doubanRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the coarse cover away from consumers that wait for the full payload", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    const key = doubanKey("霸王别姬", "1993");
    const pending = fetchDoubanMeta("霸王别姬", "1993");

    push(key, "cover", coverPayload);
    // 卡片读中间态：封面这时就该出。
    expect(getDoubanSnapshot(key)?.pic).toBe(coverPayload.pic);
    // 头图读终态：cover 相一律给 null，同屏的评分/简介才不会先跳一次文字再换图。
    expect(getDoubanFullSnapshot(key)).toBeNull();

    push(key, "full", fullPayload);
    expect(getDoubanFullSnapshot(key)?.intro).toContain("程蝶衣");
    expect(getDoubanSnapshot(key)?.intro).toContain("程蝶衣");
    await pending;

    // none 是「确认无匹配」：两个读口都该给 null，源站字段继续显示。
    const missKey = doubanKey("冷门片", "1970");
    const missPending = fetchDoubanMeta("冷门片", "1970");
    push(missKey, "none", null);
    expect(getDoubanSnapshot(missKey)).toBeNull();
    expect(getDoubanFullSnapshot(missKey)).toBeNull();
    await missPending;
  });

  it("carries the source-provided subject id through to the backend", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    const subjectId = "36344548";
    const key = doubanKey("童年阴影", "2025", subjectId);
    requestDouban("童年阴影", "2025", false, subjectId);

    expect(doubanRequest).toHaveBeenCalledWith(
      "童年阴影",
      "2025",
      "direct",
      undefined,
      false,
      key,
      subjectId,
    );
    // 槽位键必须含 id：按 id 直取与按标题匹配是两条证据链，共享键会让
    // 标题路径的「无匹配」负缓存压掉 id 直取。
    expect(key).toContain(subjectId);
    expect(key).not.toBe(doubanKey("童年阴影", "2025"));
  });

  it("fetchDoubanMeta passes subjectId through the promise view", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    const subjectId = "36344548";
    const pending = fetchDoubanMeta("童年阴影", "2025", { priority: true, subjectId });

    expect(doubanRequest).toHaveBeenCalledWith(
      "童年阴影",
      "2025",
      "direct",
      undefined,
      true,
      doubanKey("童年阴影", "2025", subjectId),
      subjectId,
    );

    // 终态按同一个槽位键结算：标题路径的缓存不能顶掉它。
    push(doubanKey("童年阴影", "2025", subjectId), "full", fullPayload);
    expect((await pending)?.rating).toBe(fullPayload.rating);
  });

  it("merges concurrent requests for the same key into one", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    const key = doubanKey("霸王别姬", "1993");
    const a = fetchDoubanMeta("霸王别姬", "1993");
    const b = fetchDoubanMeta("霸王别姬", "1993");
    expect(doubanRequest).toHaveBeenCalledTimes(1);
    push(key, "full", fullPayload);
    expect(await a).toEqual(await b);
  });

  it("resolves none as null (确认无匹配) and stops re-requesting", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    const key = doubanKey("冷门片", "1970");
    const pending = fetchDoubanMeta("冷门片", "1970");
    push(key, "none", null);
    expect(await pending).toBeNull();
    // none 是终态：再取不再打后端。
    await fetchDoubanMeta("冷门片", "1970");
    expect(doubanRequest).toHaveBeenCalledTimes(1);
  });

  it("resolves error as null but allows a retry (传输失败可重试)", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    const key = doubanKey("某部片", "2021");
    const pending = fetchDoubanMeta("某部片", "2021");
    push(key, "error", null);
    expect(await pending).toBeNull();
    // error 非终态：清掉在途标记后允许重新请求（用 requestDouban 触发，不吊 Promise）。
    requestDouban("某部片", "2021");
    expect(doubanRequest).toHaveBeenCalledTimes(2);
  });

  it("re-requests after the proxy mode changes (key 含代理)", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    const keyDirect = doubanKey("霸王别姬", "1993");
    const p1 = fetchDoubanMeta("霸王别姬", "1993");
    push(keyDirect, "full", fullPayload);
    await p1;
    expect(doubanRequest).toHaveBeenCalledTimes(1);

    writeDoubanPrefs({ proxyType: "cmliussss-cdn-tencent" });
    const keyCdn = doubanKey("霸王别姬", "1993");
    expect(keyCdn).not.toEqual(keyDirect);
    const p2 = fetchDoubanMeta("霸王别姬", "1993");
    expect(doubanRequest).toHaveBeenCalledTimes(2);
    expect(doubanRequest).toHaveBeenLastCalledWith(
      "霸王别姬",
      "1993",
      "cmliussss-cdn-tencent",
      undefined,
      false,
      keyCdn,
      undefined,
    );
    push(keyCdn, "full", fullPayload);
    await p2;
  });

  it("falls back to direct when custom is selected without a prefix", async () => {
    writeDoubanPrefs({ proxyType: "custom", proxyPrefix: "" });
    const key = doubanKey("霸王别姬", "1993");
    requestDouban("霸王别姬", "1993");
    expect(doubanRequest).toHaveBeenLastCalledWith(
      "霸王别姬",
      "1993",
      "direct",
      undefined,
      false,
      key,
      undefined,
    );

    clearDoubanMetaCache();
    writeDoubanPrefs({ proxyPrefix: "https://proxy.example/?url=" });
    const keyCustom = doubanKey("霸王别姬", "1993");
    requestDouban("霸王别姬", "1993");
    expect(doubanRequest).toHaveBeenLastCalledWith(
      "霸王别姬",
      "1993",
      "custom",
      "https://proxy.example/?url=",
      false,
      keyCustom,
      undefined,
    );
  });

  it("passes priority through to the backend scheduler", () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    requestDouban("霸王别姬", "1993", true);
    expect(doubanRequest).toHaveBeenLastCalledWith(
      "霸王别姬",
      "1993",
      "direct",
      undefined,
      true,
      doubanKey("霸王别姬", "1993"),
      undefined,
    );
  });

  it("returns null for an empty title without requesting", async () => {
    expect(await fetchDoubanMeta("   ")).toBeNull();
    expect(doubanRequest).not.toHaveBeenCalled();
  });

  it("normalizes unexpected payload shapes", () => {
    expect(normalizeDoubanMeta(null)).toBeNull();
    expect(normalizeDoubanMeta("nope")).toBeNull();
    expect(normalizeDoubanMeta({})).toBeNull();
    const loose = normalizeDoubanMeta({ title: "X", rating: "9.1", actors: [1, " A "] });
    expect(loose?.rating).toBe(9.1);
    expect(loose?.ratingCount).toBe(0);
    expect(loose?.actors).toEqual(["A"]);
    expect(loose?.genres).toEqual([]);
  });
});

describe("douban push contract (source invariants)", () => {
  const source = read("src/lib/douban.ts");

  it("goes through the single IPC exit and never imports the event API directly", () => {
    expect(source).toContain('from "./invoke"');
    expect(source).toContain(".doubanRequest(");
    expect(source).toContain(".onDoubanMeta(");
    expect(source).not.toContain("@tauri-apps/api");
    expect(source).not.toMatch(/\binvoke\(/);
  });

  it("routes pushes by an opaque key and treats cover as non-terminal", () => {
    // 事件按 key 路由；cover 不结算 Promise，full/none 才终态。
    expect(source).toContain('evt.phase === "full" || evt.phase === "none"');
    // 写入统一走 setStore：它在写入处给 store 封顶（键含代理维度，换代理会
    // 换一整套键空间，不封顶就是常驻内存泄漏）。
    expect(source).toContain('setStore(key, { meta, phase: evt.phase })');
    expect(source).toContain("MAX_STORE_ENTRIES");
    // 四种阶段齐全。
    expect(source).toContain('"cover" | "full" | "none" | "error"');
  });

  it("dedupes by an in-flight set instead of a frontend queue", () => {
    // 并发/限流已上收到后端调度器，前端不再有 MAX_PARALLEL/acquireSlot。
    expect(source).not.toContain("MAX_PARALLEL");
    expect(source).not.toContain("acquireSlot");
    expect(source).toContain("requested.has(key)");
    expect(source).toContain("requested.add(key)");
  });

  it("keys the store by title+year+proxy so a proxy switch re-requests", () => {
    expect(source).toContain("${proxyType}\\u0000${custom}");
    expect(source).toContain('prefs.proxyType === "custom" && !prefix');
    expect(source).toContain('"direct"');
  });

  it("stays silent on failure — no throw, no toast", () => {
    expect(source).toContain("readDoubanPrefs().enabled");
    expect(source).not.toContain("throw ");
    expect(source).not.toContain("../lib/notify");
    expect(source).not.toContain("notify(");
  });
});

describe("douban ui contract", () => {
  it("wraps the push command and the event subscription in invoke.ts", () => {
    const invoke = read("src/lib/invoke.ts");
    expect(invoke).toContain(
      'call("douban_request", { title, year, proxyType, proxyPrefix, priority, key, subjectId })',
    );
    expect(invoke).toContain('listen<DoubanMetaEvent>("douban-meta"');
    expect(invoke).toContain("doubanRequest(");
    expect(invoke).toContain("onDoubanMeta(");
  });

  it("detail and player pages actually hand the source's subject id to the request", () => {
    // 后端能吃 subjectId、lib 会透传，都不等于页面真的把卡片/详情上的字段取出来了。
    // 这一段没有网络就不能在窗口里稳定复现（源的 id 覆盖率约 62%，取样会飘），
    // 所以用源码契约钉住「取值 + 传参」，真源出数时另有探针补实测。
    const detail = read("src/pages/DetailPage.tsx");
    const player = read("src/pages/PlayerPage.tsx");
    expect(detail).toContain("vod?.vod_douban_id || emptyCard?.vod_douban_id");
    expect(detail).toContain("subjectId: doubanSubjectId || undefined");
    // 派生值必须进 effect 依赖：详情是异步到的，不依赖它就只会用标题发一次。
    expect(detail).toContain("[doubanTitle, doubanYear, doubanSubjectId]");
    expect(player).toContain("subjectId: vod?.vod_douban_id?.trim() || undefined");
    expect(player).toContain("vod?.vod_douban_id, vodName]");
  });

  it("keeps vod_douban_id through the card index that feeds the detail page", () => {
    // 卡片→详情是主路径：白名单里没有这个字段，页面就拿不到 id、按 id 直取轮不上。
    const index = read("src/lib/cardIndex.ts");
    expect(index).toContain("vod_douban_id: vod.vod_douban_id");
  });

  it("prefers douban metadata on the detail page and keeps source as fallback", () => {
    const detail = read("src/pages/DetailPage.tsx");
    const hero = read("src/components/VodMetaHero.tsx");
    expect(detail).toContain("<VodMetaHero");
    expect(detail).toContain('variant="detail"');
    expect(detail).toContain("douban={doubanMeta}");
    expect(detail).toContain('descriptionFallback="暂无简介"');
    expect(detail).toContain("if (!doubanTitle) {");
    expect(detail).not.toContain("doubanReady");
    expect(detail).not.toContain("DoubanMetaBlock");
    expect(detail).not.toContain("douban-meta");
    expect(hero).toContain("`★ ${douban.rating.toFixed(1)}");
    expect(hero).toContain("douban.genres.join");
    expect(hero).toContain("douban.directors.join");
    expect(hero).toContain("douban.actors.join");
    expect(hero).toContain("plainText(douban?.intro)");
    expect(hero).toContain("vod?.vod_remarks?.trim()");
    expect(hero).toContain(
      "doubanPoster.src && !doubanPoster.broken ? doubanPoster : sourcePoster",
    );
    expect(detail).toContain('className="detail-douban-page"');
    expect(detail).toContain("全站搜索此片");
  });

  it("lets the player info card use douban too, with source fallback", () => {
    const about = read("src/components/player/PlayerAbout.tsx");
    const hero = read("src/components/VodMetaHero.tsx");
    expect(about).toContain("douban?: DoubanMeta | null;");
    expect(about).toContain("<VodMetaHero");
    expect(about).toContain('variant="player"');
    expect(about).toContain("douban={douban}");
    expect(about).not.toContain("formatVotes");
    expect(hero).toContain("formatVotes(douban.ratingCount)");
    const page = read("src/pages/PlayerPage.tsx");
    expect(page).toContain("fetchDoubanMeta(name");
    expect(page).toContain("douban={doubanMeta}");
  });

  it("lazily falls back to douban covers for history and favorites only", () => {
    const card = read("src/components/VodCard.tsx");
    expect(card).toContain("doubanTitle?: string;");
    expect(card).toContain("new IntersectionObserver(");
    expect(card).toContain(
      "const needsDouban = Boolean(doubanTitle) && (!sourcePic || sourceBroken);",
    );
    expect(card).toContain("void fetchDoubanMeta(doubanTitle, doubanYear || undefined)");
    for (const page of ["src/pages/HistoryPage.tsx", "src/pages/FavoritesPage.tsx"]) {
      expect(read(page)).toContain("doubanTitle={item.name}");
    }
    for (const page of ["src/pages/HomePage.tsx", "src/pages/SearchPage.tsx"]) {
      expect(read(page)).not.toContain("fetchDoubanMeta");
      expect(read(page)).not.toContain("doubanTitle=");
    }
  });

  it("adds a douban section to settings between epg and proxy", () => {
    const page = read("src/pages/SettingsPage.tsx");
    expect(page).toContain('{ id: "s-douban", label: "豆瓣信息" }');
    expect(page).toContain('id: "s-douban"');
    expect(page).toContain("readDoubanPrefs()");
    expect(page).toContain("writeDoubanPrefs(patch)");
    expect(page).toContain("DOUBAN_PROXY_OPTIONS");
    expect(page).toContain("isDoubanProxyType(value)");
    expect(page).toContain("disabled={!doubanPrefs.enabled}");
    const epg = page.indexOf('{ id: "s-epgs"');
    const douban = page.indexOf('{ id: "s-douban"');
    const proxy = page.indexOf('{ id: "s-proxy"');
    expect(epg).toBeGreaterThanOrEqual(0);
    expect(douban).toBeGreaterThan(epg);
    expect(proxy).toBeGreaterThan(douban);
  });
});

describe("douban styles contract", () => {
  const tail = (source: string, marker: string) => {
    const index = source.indexOf(marker);
    expect(index).toBeGreaterThanOrEqual(0);
    return source.slice(index);
  };

  it("keeps no standalone douban block styles in detail.css", () => {
    const css = read("src/styles/detail.css");
    expect(css).not.toContain(".douban-meta");
    expect(css).not.toContain("豆瓣信息补全");
  });

  it("keeps the settings rules at the end of pages.css using tokens", () => {
    const css = read("src/styles/pages.css");
    const section = tail(css, "/* ---------- 设置 · 豆瓣信息补全 ---------- */");
    expect(section).toContain(".douban-settings {");
    expect(section).toContain(".douban-settings__switch");
    expect(section).toContain(".douban-settings__input");
    expect(css.indexOf(".douban-settings {")).toBeGreaterThan(
      css.indexOf(".resume-actions {"),
    );
    expect(section).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(section).not.toMatch(/\brgba?\(/);
    expect(section).toContain("var(--border)");
    expect(section).toContain("var(--fs-xs)");
  });

  it("does not disturb the cascade order in index.css", () => {
    const index = read("src/styles/index.css");
    expect(index).not.toContain("douban");
    const css = readCss();
    expect(css).toContain(".douban-settings__switch-label");
  });
});
