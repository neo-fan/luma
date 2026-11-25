/**
 * 详情页「填充」过程的两条链路：豆瓣资料补全、播放线路到货。
 *
 * 这两处共同的失败模式是**静默跳变**：到货前一片安静，到货后整块内容硬切，
 * 用户既不知道在等什么，也不知道为什么变了。表现层没有 dom 环境可渲染，
 * 所以用源码契约钉住三件容易在重构里丢掉的事：
 *
 * 1. 在途状态真的有来源（`isDoubanPending` 由 `requestDouban` 主动 dispatch）；
 * 2. 提示放在**不新增行**的位置（元信息行尾 / section 标题行），失败时不回收版面；
 * 3. 线路等待期用与到货后同尺寸的骨架，而不是一行灰字。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";
import { blockAfter, blockFrom } from "./readSource";

const read = (path: string) => readFileSync(resolve(__dirname, "../../", path), "utf8");

describe("豆瓣补全的在途提示", () => {
  it("exposes an in-flight flag that is driven by the request itself", () => {
    const lib = read("src/lib/douban.ts");
    // 标记必须由「发请求」这个动作广播：挂在事件上会让提示晚一拍，
    // 慢网下终态可能就是第一个事件，提示等于没有。
    expect(lib).toContain("export function isDoubanPending(key: string): boolean");
    const request = blockAfter(lib, "export function requestDouban(", "export function isDoubanPending");
    expect(request).toContain("requested.add(key);");
    expect(request).toContain("dispatch(key);");
    // 失败也要清掉在途态，否则「补全中」会永久挂在那里。
    expect(request).toContain("requested.delete(key);\n      dispatch(key);");
  });

  it("surfaces the flag as a chip that adds no row", () => {
    const hero = read("src/components/VodMetaHero.tsx");
    expect(hero).toContain("doubanPending?: boolean");
    // 提示必须落在已有的元信息行里（横向增删），不能自起一行：
    // 自起一行的话失败时那一行消失，下面内容整体上移。
    expect(hero).toContain("chips.length > 0 || filling");
    expect(hero).toContain("chip--pending");
    expect(hero).toContain("豆瓣资料补全中");
    // 已经在补的时候不再提示（资料到了就是以资料为准）。
    expect(hero).toContain("const filling = Boolean(doubanPending) && !douban;");
  });

  it("does not claim 'no intro' while the intro is still coming", () => {
    const hero = read("src/components/VodMetaHero.tsx");
    // 「暂无简介」是断言这部片没有简介；等待期只能说在拿。
    expect(hero).toContain('(filling && descriptionFallback ? "正在获取简介…" : descriptionFallback)');
  });

  it("fades the swapped fields instead of re-mounting them", () => {
    const hero = read("src/components/VodMetaHero.tsx");
    const css = readCss();
    // data 属性翻转触发动画；换 key 重挂载会清掉简介的展开态与溢出测量。
    expect(hero).toContain('data-douban={source}');
    expect(hero).toContain('const source = douban ? "full" : "source";');
    expect(css).toContain('[data-douban="full"] .detail-content');
    expect(css).toContain("@keyframes hero-fill-in");
    // 只做透明度，不动布局。
    expect(css).toContain("animation: hero-fill-in 220ms var(--ease) both;");
  });
});

describe("播放线路的等待期", () => {
  it("uses a skeleton sized like the real lines section", () => {
    const skeleton = read("src/components/DetailSkeleton.tsx");
    const detail = read("src/pages/DetailPage.tsx");
    expect(skeleton).toContain("export function LinesSkeleton()");
    // 骨架必须是「chip 行 + 剧集格」，和到货后的两块同构。
    const lines = blockFrom(skeleton, "export function LinesSkeleton()");
    expect(lines).toContain("sk-detail__lines");
    expect(lines).toContain("sk-detail__episodes");
    // 过滤行也要占位，否则到货瞬间剧集格会整体上移。
    expect(lines).toContain("sk-detail__tools");
    // 类名不落进真实选择器，否则探针会把骨架当成已就绪的数据。
    expect(lines).not.toContain("chip-row--lines");
    expect(detail).toContain("<LinesSkeleton />");
    // 只有「在加载」才出骨架；没数据又不在加载，是空态而不是骨架。
    expect(detail).not.toContain('className="page-meta">正在获取剧集');
  });

  it("reports the wait in the section head so the row never moves", () => {
    const detail = read("src/pages/DetailPage.tsx");
    const head = blockAfter(detail, '<h2 className="section-title">播放线路</h2>', "detail-episode-tools");
    // 等待文案与到货文案占同一行 → 替换时版面不动。
    expect(head).toContain("正在获取剧集…");
    expect(head).toContain("条线路 · 当前线路");
  });

  it("explains the disabled play button instead of leaving it grey", () => {
    const detail = read("src/pages/DetailPage.tsx");
    expect(detail).toContain('className="icon-spin"');
    // 有地址就一定显示真正的动作文案，不能停在等待态。
    const footer = blockAfter(detail, "footer={", "<div className=\"section\">");
    expect(footer).toContain('resume ? "继续播放" : "播放第 1 集"');
    expect(footer).toContain("正在获取剧集…");
  });
});
