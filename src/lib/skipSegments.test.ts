import { describe, expect, it } from "vitest";
import {
  AUTO_SKIP_COUNTDOWN_S,
  MAX_SKIP_MS,
  clampSkipMs,
  formatSkipMs,
  introMs,
  outroMs,
  outroStartMs,
  parseSkipConfig,
  serializeSkipConfig,
  shouldAutoSkipPrompt,
  shouldSkipIntro,
  shouldSkipOutro,
  withSkipMs,
} from "./skipSegments";

describe("parseSkipConfig", () => {
  it("reads a well-formed intro + outro", () => {
    const segs = parseSkipConfig('[{"kind":"intro","ms":90000},{"kind":"outro","ms":60000}]');
    expect(segs).toEqual([
      { kind: "intro", ms: 90000 },
      { kind: "outro", ms: 60000 },
    ]);
  });

  it("returns [] for empty / null / bad JSON / non-array", () => {
    expect(parseSkipConfig("")).toEqual([]);
    expect(parseSkipConfig(undefined)).toEqual([]);
    expect(parseSkipConfig(null)).toEqual([]);
    expect(parseSkipConfig("not json")).toEqual([]);
    expect(parseSkipConfig('{"kind":"intro"}')).toEqual([]);
  });

  it("drops invalid kinds and non-object entries", () => {
    const segs = parseSkipConfig('[{"kind":"mid","ms":5000},{"nope":1},"str",{"kind":"intro","ms":4000}]');
    expect(segs).toEqual([{ kind: "intro", ms: 4000 }]);
  });

  it("clamps ms to the cap and floors negatives / non-finite to dropped", () => {
    expect(clampSkipMs(999_999_999)).toBe(MAX_SKIP_MS);
    expect(clampSkipMs(-5)).toBe(0);
    expect(clampSkipMs("abc")).toBe(0);
    expect(clampSkipMs(Number.NaN)).toBe(0);
    const segs = parseSkipConfig('[{"kind":"intro","ms":-100},{"kind":"outro","ms":999999999}]');
    expect(segs).toEqual([{ kind: "outro", ms: MAX_SKIP_MS }]);
  });

  it("last duplicate kind wins; 0ms clears that kind", () => {
    expect(parseSkipConfig('[{"kind":"intro","ms":1000},{"kind":"intro","ms":2000}]')).toEqual([
      { kind: "intro", ms: 2000 },
    ]);
    expect(parseSkipConfig('[{"kind":"intro","ms":5000},{"kind":"intro","ms":0}]')).toEqual([]);
  });

  it("normalizes order to intro then outro", () => {
    const segs = parseSkipConfig('[{"kind":"outro","ms":6000},{"kind":"intro","ms":9000}]');
    expect(segs.map((s) => s.kind)).toEqual(["intro", "outro"]);
  });
});

describe("serializeSkipConfig", () => {
  it("writes [] for an empty config (backend inheritance default)", () => {
    expect(serializeSkipConfig([])).toBe("[]");
  });

  it("round-trips and re-validates on the way out", () => {
    const json = serializeSkipConfig([
      { kind: "intro", ms: 90000 },
      { kind: "outro", ms: 999_999_999 },
    ]);
    expect(parseSkipConfig(json)).toEqual([
      { kind: "intro", ms: 90000 },
      { kind: "outro", ms: MAX_SKIP_MS },
    ]);
  });
});

describe("accessors + decisions", () => {
  const segs = parseSkipConfig('[{"kind":"intro","ms":90000},{"kind":"outro","ms":60000}]');

  it("introMs / outroMs read the per-kind duration", () => {
    expect(introMs(segs)).toBe(90000);
    expect(outroMs(segs)).toBe(60000);
    expect(introMs([])).toBe(0);
    expect(outroMs([])).toBe(0);
  });

  it("shouldSkipIntro only inside the intro window, and only when set", () => {
    expect(shouldSkipIntro(0, 90000)).toBe(true);
    expect(shouldSkipIntro(89999, 90000)).toBe(true);
    expect(shouldSkipIntro(90000, 90000)).toBe(false);
    expect(shouldSkipIntro(120000, 90000)).toBe(false);
    expect(shouldSkipIntro(0, 0)).toBe(false); // 未设片头 → 永不跳
  });

  it("outroStartMs guards against missing outro / invalid duration", () => {
    expect(outroStartMs(600000, 60000)).toBe(540000);
    expect(outroStartMs(600000, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(outroStartMs(0, 60000)).toBe(Number.POSITIVE_INFINITY);
    expect(outroStartMs(Number.NaN, 60000)).toBe(Number.POSITIVE_INFINITY);
    // outro 比整集还长 → 起点夹到 0（整集都在片尾窗口，但不为负）
    expect(outroStartMs(30000, 60000)).toBe(0);
  });

  it("shouldSkipOutro fires at or after the outro window start", () => {
    expect(shouldSkipOutro(540000, 600000, 60000)).toBe(true);
    expect(shouldSkipOutro(539999, 600000, 60000)).toBe(false);
    expect(shouldSkipOutro(1000, 600000, 0)).toBe(false); // 未设片尾
  });
});

describe("formatSkipMs", () => {
  it("turns ms into menu-friendly labels", () => {
    expect(formatSkipMs(0)).toBe("关闭");
    expect(formatSkipMs(30_000)).toBe("30秒");
    expect(formatSkipMs(60_000)).toBe("1分钟");
    expect(formatSkipMs(90_000)).toBe("1分30秒");
    expect(formatSkipMs(180_000)).toBe("3分钟");
    // 越界夹取到上限，仍出可读文案
    expect(formatSkipMs(MAX_SKIP_MS)).toBe("30分钟");
  });
});

describe("withSkipMs", () => {
  const base = [
    { kind: "intro" as const, ms: 60_000 },
    { kind: "outro" as const, ms: 30_000 },
  ];

  it("sets a kind while keeping the other", () => {
    expect(withSkipMs(base, "intro", 90_000)).toEqual([
      { kind: "intro", ms: 90_000 },
      { kind: "outro", ms: 30_000 },
    ]);
  });

  it("0 removes that kind (关闭)", () => {
    expect(withSkipMs(base, "outro", 0)).toEqual([{ kind: "intro", ms: 60_000 }]);
  });

  it("keeps stable intro-before-outro order", () => {
    expect(withSkipMs([], "outro", 45_000).map((s) => s.kind)).toEqual(["outro"]);
    expect(withSkipMs([{ kind: "outro", ms: 45_000 }], "intro", 90_000).map((s) => s.kind)).toEqual([
      "intro",
      "outro",
    ]);
  });

  it("result round-trips through serialize/parse unchanged", () => {
    const next = withSkipMs(base, "intro", 120_000);
    expect(parseSkipConfig(serializeSkipConfig(next))).toEqual(next);
  });
});

describe("shouldAutoSkipPrompt", () => {
  const inWindow = { introMs: 90_000, outroMs: 30_000, inIntro: false, inOutro: false };
  const cur = (patch: Partial<typeof inWindow>) => ({ ...inWindow, ...patch });

  it("首次报告就落在片头里 → 触发 intro（新集从头播）", () => {
    expect(shouldAutoSkipPrompt(null, cur({ inIntro: true }))).toBe("intro");
  });

  it("片头窗口 false→true 边沿 → 触发 intro", () => {
    expect(shouldAutoSkipPrompt(cur({ inIntro: false }), cur({ inIntro: true }))).toBe("intro");
  });

  it("已在片头内（无翻转）→ 不重复触发", () => {
    expect(shouldAutoSkipPrompt(cur({ inIntro: true }), cur({ inIntro: true }))).toBeNull();
  });

  it("未设片头 → 即便在窗口也不自动提示", () => {
    expect(shouldAutoSkipPrompt(null, cur({ introMs: 0, inIntro: true }))).toBeNull();
  });

  it("播放中进入片尾窗口 → 触发 outro", () => {
    expect(shouldAutoSkipPrompt(cur({ inOutro: false }), cur({ inOutro: true }))).toBe("outro");
  });

  it("续播点直接落在片尾（首次报告 prev=null）→ 不触发 outro（尊重『上次看到』）", () => {
    expect(shouldAutoSkipPrompt(null, cur({ inOutro: true }))).toBeNull();
  });

  it("未设片尾 → 进入窗口也不提示", () => {
    expect(shouldAutoSkipPrompt(cur({ inOutro: false }), cur({ outroMs: 0, inOutro: true }))).toBeNull();
  });

  it("cur 为 null（媒体重置）→ 不触发", () => {
    expect(shouldAutoSkipPrompt(cur({ inIntro: true }), null)).toBeNull();
  });

  it("intro 与 outro 同时有效时 intro 优先（片头先发生）", () => {
    expect(shouldAutoSkipPrompt(null, cur({ inIntro: true }))).toBe("intro");
  });

  it("倒计时秒数是 3（用户要求：3 秒内可取消）", () => {
    expect(AUTO_SKIP_COUNTDOWN_S).toBe(3);
  });
});
