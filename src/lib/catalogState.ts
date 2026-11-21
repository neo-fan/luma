/**
 * 目录（详情 + 剧集）数据链的状态词汇表。
 *
 * 播放页有两条互相独立的数据链：播放地址解析（`playerContent` → 反代 → 解码）与
 * 目录读取（`detailContent` → 简介 / 线路 / 剧集 / 换源候选）。两者只共享站点身份，
 * 失败互不影响：目录读不到时，简介、选集、换源仍要能显示和操作。
 *
 * 本模块只定义状态与「选集区该画哪一块」，不碰 React、不发请求；controller 产生
 * 状态，`EpisodePanel` / `PlayerAbout` 按状态渲染。
 */

/** 目录读取的三态。`ready` 也可能带着空剧集（源站只给了详情、没给线路）。 */
export type CatalogStatus = "loading" | "ready" | "error";

/** 选集区当前该画什么。 */
export type EpisodePanelView = "grid" | "loading" | "error" | "empty";

/**
 * 选集区的展示判定。
 *
 * 有数据就先给数据：只要线路已经解析出来，即便状态还是 loading（例如换源在途）
 * 或补拉失败，也不该把用户能点的剧集撤掉。
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
