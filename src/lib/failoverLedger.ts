/**
 * 自动换线的「记账本」：跨播放页重挂载存活的模块级单例。
 *
 * 之前「试过的地址 / 站点」放在组件 ref 里，而自动换线以 navigate 结束、
 * PlayerPage 按 `siteKey:vodId:playUrl` 换 key 重建——新实例的 ref 全是空的，
 * 于是形成死循环：
 *
 *   A 站失败 → 切到 B 站 → B 播放失败 → 换源又搜回 A 站同一条线 → 再失败 → …
 *
 * （探活只验 manifest，manifest 正常但流播不动的地址每次探都会「通过」，同一
 * 条地址能被反复选中。）这里把账记到模块级，按 `failoverKey` 分桶、带 TTL；
 * 自动跳转时透传 key，用户手动点播（非自动跳转）时清空重记。另设跳转次数
 * 上限：预算用完就停下来报错，把控制权交还用户。
 */

/** 记账有效期：超过后整桶作废，用户再点一次就是全新的一轮。 */
const TTL_MS = 5 * 60_000;
/** 一轮内最多自动跳转次数；超过就停下报错，让人接管。 */
const MAX_SWITCHES = 4;
/** 单桶地址上限，防极端站点刷爆内存。 */
const MAX_URLS = 64;

interface Entry {
  urls: Set<string>;
  sites: string[];
  switches: number;
  ts: number;
}

const ledger = new Map<string, Entry>();

/** 自动换线即将 navigate 时置位；由新播放页挂载时消费。 */
let autoNavPending = false;

function bucket(key: string): Entry {
  const cur = ledger.get(key);
  if (cur && Date.now() - cur.ts < TTL_MS) {
    return cur;
  }
  const fresh: Entry = { urls: new Set(), sites: [], switches: 0, ts: Date.now() };
  ledger.set(key, fresh);
  return fresh;
}

export function ledgerHasUrl(key: string, url: string): boolean {
  return bucket(key).urls.has(url);
}

export function ledgerMarkUrl(key: string, url: string): void {
  const b = bucket(key);
  if (b.urls.size < MAX_URLS) {
    b.urls.add(url);
  }
}

export function ledgerSiteSeen(key: string, siteKey: string): boolean {
  return bucket(key).sites.includes(siteKey);
}

export function ledgerMarkSite(key: string, siteKey: string): void {
  const b = bucket(key);
  if (!b.sites.includes(siteKey)) {
    b.sites.push(siteKey);
  }
}

/** 剩余自动跳转预算；0 表示该停了。 */
export function ledgerBudget(key: string): number {
  return MAX_SWITCHES - bucket(key).switches;
}

export function ledgerCountSwitch(key: string): void {
  bucket(key).switches += 1;
}

/** 自动换线导航前调用：新播放页凭此知道「不是用户手动点播」。 */
export function markAutoNav(): void {
  autoNavPending = true;
}

/**
 * 播放页挂载时消费自动跳转标记。返回 false 说明是用户手动点播，
 * 调用方应 `ledgerReset` 清空记账。注意 React StrictMode 会把挂载 effect
 * 连跑两次，调用方必须用 ref 守卫，否则第二次会误消费成「手动」。
 */
export function consumeAutoNav(): boolean {
  const v = autoNavPending;
  autoNavPending = false;
  return v;
}

export function ledgerReset(key: string): void {
  ledger.delete(key);
}
