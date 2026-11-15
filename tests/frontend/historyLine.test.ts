/**
 * 播放页收藏 / 历史线路的源码契约。
 *
 * 这两条都是「UI 在，但数据没写」的典型退化点：收藏按钮漏了 toVodRef 会存空条目，
 * 历史漏了 playFrom / episodeName 则历史页与详情页续播都退回到「只按地址匹配」。
 * 与 `playerLifecycle.test.ts` 一样，用源码不变量守住，避免后续重构悄悄回退。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readCss } from "./readCss";

// tests/frontend -> project root
const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("player favourites & history line contract", () => {
  it("renders a favourite star next to the player title", () => {
    const header = read("src/components/player/PlayerHeader.tsx");
    // 收藏是剧名旁的单图标星（不是右侧工具栏的文字按钮）：片名单独成盒，
    // 星插在「片名」与「集名」之间。
    expect(header).toContain("FavStar");
    expect(header).toContain("page-title__name");
    expect(header).toContain("onToggleFavorite");
    expect(header).not.toContain("btn--fav");
    // 直播没有 vod 条目，传 null 隐藏按钮。
    expect(header).toContain("favorite === null");
  });

  it("renders a favourite star next to the detail title", () => {
    const page = read("src/pages/DetailPage.tsx");
    // 详情 hero 已抽成 `VodMetaHero`（详情页与播放页共用），星通过
    // `titleExtra` 插在片名行里；行布局由组件负责。
    const hero = read("src/components/VodMetaHero.tsx");
    expect(page).toContain("<VodMetaHero");
    expect(page).toContain("titleExtra={");
    expect(page).toContain("FavStar");
    expect(hero).toContain('titleRow: "detail-title-row"');
    // 旧的「☆ 收藏」文字按钮（在右上角工具栏里）必须已经拿掉。
    expect(page).not.toContain("btn--fav");
    expect(page).not.toContain("☆ 收藏");
  });

  it("keeps the star icon-only but accessible", () => {
    const star = read("src/components/FavStar.tsx");
    // 没有文字，状态只能落在 aria-pressed；探针也按它断言。
    expect(star).toContain("aria-pressed");
    expect(star).toContain("aria-label");
    // 类名按需拼 `is-on`（收藏页会再叠一个 `.fav-item__unfav` 定位类）。
    expect(star).toMatch(/fav-star.*is-on/);
    expect(star).toContain("className");
    // 已收藏靠填充表达，样式里要能把描边星变实心。
    const css = readCss();
    expect(css).toContain(".fav-star.is-on svg");
    expect(css).not.toContain(".btn--fav");
  });

  it("toggles favourites through the shared library store", () => {
    const page = read("src/pages/PlayerPage.tsx");
    expect(page).toContain("toVodRef(activeSiteKey, activeSiteName, favVod)");
    expect(page).toContain("api.favoritesToggle(favRef)");
    expect(page).toContain("api.favoritesList()");
  });

  it("carries the cover and site name into history and favourites", () => {
    const page = read("src/pages/PlayerPage.tsx");
    expect(page).toContain("pic: historyMetaRef.current.pic");
    expect(page).toContain("remarks: historyMetaRef.current.remarks");
    expect(page).toContain("siteName: historyMetaRef.current.siteName");
    // 详情没到就点收藏时，等详情回来补一次元数据。
    expect(page).toContain("api.favoritesPatchMeta(toVodRef(activeSiteKey, activeSiteName, vod))");
  });

  it("backfills covers on both list pages", () => {
    for (const page of ["src/pages/HistoryPage.tsx", "src/pages/FavoritesPage.tsx"]) {
      const source = read(page);
      expect(source).toContain("backfillCovers(");
      expect(source).toContain("mergeMeta(");
    }
  });

  it("writes the current line and episode into history", () => {
    const page = read("src/pages/PlayerPage.tsx");
    expect(page).toContain("episodeName: historyLabelRef.current.episodeName");
    expect(page).toContain("playFrom: historyLabelRef.current.playFrom");
    // 自动换线路时 navigate 不带 playFrom，必须优先取当前线路名。
    expect(page).toContain("activeLine?.name || playFrom");
    expect(page).toContain("activeEpisodeName");
  });

  it("resumes on the recorded line before falling back to the first one", () => {
    const detail = read("src/pages/DetailPage.tsx");
    expect(detail).toContain("resume.playFrom");
    expect(detail).toContain("resume.episodeName");
  });

  it("surfaces line and episode in the history list", () => {
    const history = read("src/lib/history.ts");
    expect(history).toContain("item.playFrom");
    expect(history).toContain("item.episodeName");
  });
});
