/**
 * 分类分页请求的通用兜底。
 *
 * 痛点：py 源常把网络异常在脚本里 catch 成 `{"list":[]}`，源站一次抖动就会
 * 把这个空结果写进 5 分钟 TTL 的 数据缓存 —— 之后点下一页、切走再回来、
 * 甚至换分类第 N 页都还是空，用户看到的就是「分页查询全都是失败的」。
 * 真正的 IPC 异常虽然不进缓存，但也值得立刻重试一次再报错误条。
 *
 * 规则（与 api.detail / 首页空结果一致）：**空结果不入缓存**，空或异常都强制
 * 重试一次；两次都空才把空结果交给 UI。抽成纯函数便于单测，不绑死 数据缓存。
 */
import type { ResultPage } from "../types/luma";

export async function loadCategoryPage(
  load: (force: boolean) => Promise<ResultPage>,
  invalidate: () => void,
  force = false,
  onRetry?: (reason: "empty" | "error", attempt: number) => void,
): Promise<ResultPage> {
  let first: ResultPage;
  try {
    first = await load(force);
  } catch (err) {
    onRetry?.("error", 1);
    // 数据缓存.load 的异常本来就不写缓存，直接强制重试；再失败由 UI 显示错误条。
    return load(true);
  }
  if (first?.list?.length) {
    return first;
  }
  // 第一次空：先删掉刚写进去的空缓存，再强制绕过缓存重试一次。
  invalidate();
  onRetry?.("empty", 1);
  let retry: ResultPage;
  try {
    retry = await load(true);
  } catch (err) {
    invalidate();
    onRetry?.("error", 2);
    throw err;
  }
  if (!retry?.list?.length) {
    // 真的没有内容也不能缓存，否则 5 分钟内无法自愈。
    invalidate();
    onRetry?.("empty", 2);
  }
  return retry;
}
