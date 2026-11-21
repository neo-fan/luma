/**
 * 目录（详情 + 剧集）数据链的状态词汇表。
 *
 * 为什么单独抽出来：播放页有两条**互不相干**的数据链——
 *   1. 播放地址解析（`playerContent` → 反代 → 解码）；
 *   2. 目录读取（`detailContent` → 简介 / 线路 / 剧集 / 换源候选）。
 * 历史实现把两者混在同一个「页面还没准备好」的叙事里：目录没回来时简介区
 * 渲染成空壳、选集区整块不渲染（换源入口又恰好长在选集区里），于是用户看到
 * 的是「地址拿不到 → 简介、换源、换集一起消失」。它们本不该有因果关系。
 *
 * 这里只定义状态与「展示哪一块」的判定，不碰 React、不发请求：controller
 * 负责产生状态，EpisodePanel / PlayerAbout 只按状态渲染。
 */

/** 目录读取的三态。`ready` 也可能带着空剧集（源站只给了详情、没给线路）。 */
export type CatalogStatus = "loading" | "ready" | "error";

/** 选集区当前该画什么。 */
export type EpisodePanelView = "grid" | "loading" | "error" | "empty";

/**
 * 选集区的展示判定。
 *
 * 优先级按「有数据就先给数据」排：只要线路已经解析出来，即便状态还是 loading
 * （例如换源在途）、甚至后来的补拉失败了，也不该把用户能点的剧集撤掉——
 * 有东西可点永远比一条错误文案有用。
 */
export function episodePanelView(
  status: CatalogStatus,
  lineCount: number,
  episodeCount: number,
): EpisodePanelView {
  if (lineCount > 0) {
    return episodeCount > 0 ? "grid" : "empty";
  }
  if (status === "loading") {
    return "loading";
  }
  if (status === "error") {
    return "error";
  }
  // ready 但一条线路都没有：源站给了详情、没给播放串。
  return "empty";
}
