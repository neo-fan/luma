/**
 * 豆瓣信息补全（详情页自动补豆瓣）的契约测试。
 *
 * 这条链路有一个「坏了也不明显」的特点：豆瓣拿不到时界面完全静默，所以
 * 任何一处退化成「弹错误 / 留空区块 / 每次进页面都重打」都不会被肉眼立刻
 * 发现。因此这里同时守三层：
 * 1. `src/lib/doubanSettings.ts` 的持久化行为（纯函数，直接跑真代码）。
 * 2. `src/lib/douban.ts` 的静默回退 / 缓存 / IPC 出口约定（源码不变量）。
 * 3. 详情页挂载点、设置项结构、样式 token 与追加位置（源码 + CSS 不变量）。
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

// `fetchDoubanMeta` 的行为要真跑一遍：只读源码证明不了「关掉时一次 invoke
// 都不发」。IPC 出口与日志被替身拦下，node 环境里就能跑完整链路。
vi.mock("../../src/lib/invoke", () => ({
  api: { doubanMeta: vi.fn() },
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("../../src/lib/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { api } from "../../src/lib/invoke";
import {
  clearDoubanMetaCache,
  fetchDoubanMeta,
  normalizeDoubanMeta,
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

    // 越界枚举值 / 错类型全部回落，不能把 detail 页带崩。
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
    // 只改代理方式不能把开关悄悄掰回开启。
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
    expect(readDoubanPrefs(storage).proxyPrefix).toBe(
      "https://proxy.example/?url=",
    );
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
    // 写失败只丢持久化，返回值仍是合并后的可用设置。
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

describe("fetchDoubanMeta behavior", () => {
  const doubanMeta = api.doubanMeta as unknown as Mock;

  /** Rust `douban_meta` 的返回体（camelCase）。 */
  const payload = {
    id: "1291546",
    title: "霸王别姬",
    year: "1993",
    rating: 9.6,
    ratingCount: 2187654,
    intro: "段小楼与程蝶衣是一对打小一起长大的师兄弟……",
    directors: ["陈凯歌"],
    actors: ["张国荣", "张丰毅", "巩俐"],
    genres: ["剧情", "爱情"],
    pic: "https://img.example/pic.jpg",
    url: "https://movie.douban.com/subject/1291546/",
  };

  beforeEach(() => {
    clearDoubanMetaCache();
    // 用内存 localStorage 顶掉 window，设置读写走同一条真实代码路径。
    vi.stubGlobal("window", { localStorage: new MemoryStorage() });
    doubanMeta.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not invoke at all when the setting is off", async () => {
    writeDoubanPrefs({ enabled: false });
    expect(await fetchDoubanMeta("霸王别姬", "1993")).toBeNull();
    expect(doubanMeta).not.toHaveBeenCalled();
  });

  it("invokes once per title+year and reuses the cached result", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    doubanMeta.mockResolvedValue(payload);

    const first = await fetchDoubanMeta("霸王别姬", "1993");
    expect(first?.rating).toBe(9.6);
    expect(first?.actors).toContain("张国荣");
    // 同片名同年份（从播放页返回详情时会再触发一次）不再打豆瓣。
    expect(await fetchDoubanMeta("霸王别姬", "1993")).toEqual(first);
    expect(doubanMeta).toHaveBeenCalledTimes(1);
    expect(doubanMeta).toHaveBeenCalledWith(
      "霸王别姬",
      "1993",
      "direct",
      undefined,
    );

    // 年份不同是另一部候选，允许重新请求。
    doubanMeta.mockResolvedValue(payload);
    await fetchDoubanMeta("霸王别姬", "2003");
    expect(doubanMeta).toHaveBeenCalledTimes(2);
  });

  it("merges concurrent requests for the same key", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    doubanMeta.mockResolvedValue(payload);
    const [a, b] = await Promise.all([
      fetchDoubanMeta("霸王别姬", "1993"),
      fetchDoubanMeta("霸王别姬", "1993"),
    ]);
    expect(a).toEqual(b);
    expect(doubanMeta).toHaveBeenCalledTimes(1);
  });

  it("swallows failures into null and negative-caches them", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    doubanMeta.mockRejectedValue(new Error("network down"));
    expect(await fetchDoubanMeta("某部查不到的片", "2021")).toBeNull();
    // 失败也进缓存：反复进出详情页不该反复打豆瓣。
    expect(await fetchDoubanMeta("某部查不到的片", "2021")).toBeNull();
    expect(doubanMeta).toHaveBeenCalledTimes(1);
  });

  it("treats a null payload as 'no info' instead of an error", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    doubanMeta.mockResolvedValue(null);
    expect(await fetchDoubanMeta("冷门片", "1970")).toBeNull();
  });

  it("re-requests after the proxy mode changes", async () => {
    writeDoubanPrefs({ enabled: true, proxyType: "direct" });
    doubanMeta.mockResolvedValue(payload);
    await fetchDoubanMeta("霸王别姬", "1993");
    expect(doubanMeta).toHaveBeenCalledTimes(1);

    // 「切换代理即时生效」的落点：缓存键带 proxyType，下一次请求重新走。
    writeDoubanPrefs({ proxyType: "cmliussss-cdn-tencent" });
    await fetchDoubanMeta("霸王别姬", "1993");
    expect(doubanMeta).toHaveBeenCalledTimes(2);
    expect(doubanMeta).toHaveBeenLastCalledWith(
      "霸王别姬",
      "1993",
      "cmliussss-cdn-tencent",
      undefined,
    );
  });

  it("falls back to direct when custom is selected without a prefix", async () => {
    writeDoubanPrefs({ proxyType: "custom", proxyPrefix: "" });
    doubanMeta.mockResolvedValue(payload);
    await fetchDoubanMeta("霸王别姬", "1993");
    expect(doubanMeta).toHaveBeenCalledWith(
      "霸王别姬",
      "1993",
      "direct",
      undefined,
    );

    clearDoubanMetaCache();
    writeDoubanPrefs({ proxyPrefix: "https://proxy.example/?url=" });
    await fetchDoubanMeta("霸王别姬", "1993");
    expect(doubanMeta).toHaveBeenLastCalledWith(
      "霸王别姬",
      "1993",
      "custom",
      "https://proxy.example/?url=",
    );
  });

  it("returns null for an empty title without invoking", async () => {
    expect(await fetchDoubanMeta("   ")).toBeNull();
    expect(doubanMeta).not.toHaveBeenCalled();
  });

  it("normalizes unexpected payload shapes", () => {
    expect(normalizeDoubanMeta(null)).toBeNull();
    expect(normalizeDoubanMeta("nope")).toBeNull();
    expect(normalizeDoubanMeta({})).toBeNull();
    // 后端换了类型 / 缺字段也不该让详情页抛错。
    const loose = normalizeDoubanMeta({ title: "X", rating: "9.1", actors: [1, " A "] });
    expect(loose?.rating).toBe(9.1);
    expect(loose?.ratingCount).toBe(0);
    expect(loose?.actors).toEqual(["A"]);
    expect(loose?.genres).toEqual([]);
  });
});

describe("douban fetch contract", () => {
  const source = read("src/lib/douban.ts");

  it("goes through the single IPC exit and passes the proxy choice", () => {
    expect(source).toContain('from "./invoke"');
    expect(source).toContain("api.doubanMeta(");
    expect(source).toContain("proxyType");
    expect(source).toContain("proxyPrefix");
    // 不允许绕过 invoke.ts 直接 import @tauri-apps/api。
    expect(source).not.toContain("@tauri-apps/api");
    expect(source).not.toMatch(/\binvoke\(/);
  });

  it("returns null instead of throwing when disabled or unavailable", () => {
    // 关掉 = 完全不发请求。
    expect(source).toContain("if (!prefs.enabled)");
    expect(source).toContain("log.info(\"douban meta unavailable\"");
    expect(source).not.toContain("throw ");
    // 不弹提示、不弹 toast：失败就是没有这块信息。
    expect(source).not.toContain("../lib/notify");
    expect(source).not.toContain("notify(");
  });

  it("dedupes by title+year+proxy with a bounded FIFO cache", () => {
    expect(source).toContain("const CACHE_LIMIT = 200;");
    expect(source).toContain("const cached = readCache(key);");
    expect(source).toContain("inflight.get(key)");
    // 缓存键必须带代理模式：切换代理后下一次请求要重新走。
    expect(source).toContain("${proxyType}\\u0000${custom}");
    // 没命中的只留一分钟：豆瓣被限流时不能把「暂时没有」记成永久没有。
    expect(source).toContain("const MISS_TTL_MS = 60_000;");
    expect(source).toContain("const HIT_TTL_MS = 10 * 60_000;");
    // 同时在途数量有限，避免一屏海报把豆瓣打到限流。
    expect(source).toContain("const MAX_PARALLEL = 2;");
    expect(source).toContain("await acquireSlot(options.priority === true);");
    // 播放页/详情页的请求可以插队到一屏推荐卡的预取之前。
    expect(source).toContain("const index = waiters.findIndex((waiter) => waiter.priority);");
    expect(source).toContain("const next = waiters.splice(index >= 0 ? index : 0, 1)[0];");
  });

  it("falls back to direct when a custom prefix is empty", () => {
    expect(source).toContain('prefs.proxyType === "custom" && !proxyPrefix');
    expect(source).toContain('"direct"');
  });
});

describe("douban ui contract", () => {
  it("wraps the rust command once in invoke.ts", () => {
    const invoke = read("src/lib/invoke.ts");
    expect(invoke).toContain(
      'call("douban_meta", { title, year, proxyType, proxyPrefix })',
    );
    expect(invoke).toContain("doubanMeta(");
  });

  it("prefers douban metadata on the detail page and keeps source as fallback", () => {
    const detail = read("src/pages/DetailPage.tsx");
    const hero = read("src/components/VodMetaHero.tsx");
    // 详情页把「豆瓣优先、源站兜底」交给共用组件，自己只负责取数与兜底参数。
    expect(detail).toContain('<VodMetaHero');
    expect(detail).toContain('variant="detail"');
    expect(detail).toContain("douban={doubanMeta}");
    expect(detail).toContain('descriptionFallback="暂无简介"');
    // 片名一到位就并行拉豆瓣，不等详情落地：先画源站数据，豆瓣到了再升级。
    expect(detail).toContain("if (!doubanTitle) {");
    expect(detail).not.toContain("doubanReady");
    // 独立的豆瓣块已并入 hero，不再单独渲染。
    expect(detail).not.toContain("DoubanMetaBlock");
    expect(detail).not.toContain("douban-meta");
    // 豆瓣命中时用豆瓣的评分 / 年份 / 类型 / 导演 / 主演 / 简介。
    expect(hero).toContain("`★ ${douban.rating.toFixed(1)}");
    expect(hero).toContain("douban.genres.join");
    expect(hero).toContain("douban.directors.join");
    expect(hero).toContain("douban.actors.join");
    expect(hero).toContain("plainText(douban?.intro)");
    // 源站只保留播放状态（更新到第几集），播放线路 / 剧集仍来自源站。
    expect(hero).toContain("vod?.vod_remarks?.trim()");
    // 海报：豆瓣命中优先，源站只做兜底（版式统一、2:3 标准裁切）。
    expect(hero).toContain(
      "doubanPoster.src && !doubanPoster.broken ? doubanPoster : sourcePoster",
    );
    // 源站没有详情（发现型源）但豆瓣命中：用同一套 hero 渲染豆瓣页。
    expect(detail).toContain('className="detail-douban-page"');
    expect(detail).toContain("全站搜索此片");
  });

  it("lets the player info card use douban too, with source fallback", () => {
    const about = read("src/components/player/PlayerAbout.tsx");
    const hero = read("src/components/VodMetaHero.tsx");
    // 播放页与详情页共用同一个组件：豆瓣取值逻辑只允许存在一份，
    // 否则两处口径迟早漂移（这次重构前就是各写一遍）。
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
    // 懒加载：进视口才请求，且只在源站没有封面时。
    expect(card).toContain("const needsDouban = Boolean(doubanTitle) && (!sourcePic || sourceBroken);");
    expect(card).toContain("void fetchDoubanMeta(doubanTitle, doubanYear || undefined)");
    for (const page of [
      "src/pages/HistoryPage.tsx",
      "src/pages/FavoritesPage.tsx",
    ]) {
      expect(read(page)).toContain("doubanTitle={item.name}");
    }
    // 搜索 / 首页只用源站数据，不为了封面打豆瓣。
    for (const page of [
      "src/pages/HomePage.tsx",
      "src/pages/SearchPage.tsx",
    ]) {
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
    // 目录顺序与 block 顺序一致：s-epgs < s-douban < s-proxy。
    const epg = page.indexOf('{ id: "s-epgs"');
    const douban = page.indexOf('{ id: "s-douban"');
    const proxy = page.indexOf('{ id: "s-proxy"');
    expect(epg).toBeGreaterThanOrEqual(0);
    expect(douban).toBeGreaterThan(epg);
    expect(proxy).toBeGreaterThan(douban);
  });
});

describe("douban styles contract", () => {
  /** 取新增段落到文件末尾的片段（约定：新规则追加在模块末尾）。 */
  const tail = (source: string, marker: string) => {
    const index = source.indexOf(marker);
    expect(index).toBeGreaterThanOrEqual(0);
    return source.slice(index);
  };

  it("keeps no standalone douban block styles in detail.css", () => {
    const css = read("src/styles/detail.css");
    // 豆瓣信息并入 hero 后，独立的 `.douban-meta` 区块连同样式一起删掉；
    // 设置页的 `.douban-settings` 仍在 pages.css 里。
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
    // 豆瓣样式只进已有模块，不新增 @import（新增会改变级联顺序）。
    expect(index).not.toContain("douban");
    const css = readCss();
    expect(css).toContain(".douban-settings__switch-label");
  });
});
