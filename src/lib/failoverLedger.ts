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
 * 自动跳转时透传 key，用户手动点播（非自动跳转）时清空重记。
 *
 * 两个预算语义（避免固定值「拍脑袋」）：
 * - **跳转次数按「连续失败」计**：媒体真正可解码（loadedmetadata）时
 *   `ledgerSuccess` 把计数清零——单条失败链内最多 MAX_SWITCHES 次自动跳转，
 *   但一次成功播放即恢复满额预算，长会话不会被历史失败永久卡死；
 *   死循环防护不依赖这个计数，靠的是 urls/sites 记账（试过的不再试）。
 * - **TTL 按活动滑动**：每次记账动作刷新时间戳，TTL 度量「最后一次记账以来
 *   的静默时长」，而不是从建桶起算的固定窗口——多坏线源慢慢换线不会被
 *   中途过期打回重来。
 */

/** 记账有效期：桶内最后一次记账后的静默时长，超过整桶作废。 */
const TTL_MS = 5 * 60_000;
/** 一条连续失败链内最多自动跳转次数；超过就停下报错，让人接管。 */
const MAX_SWITCHES = 4;
/** 单桶地址上限，防极端站点刷爆内存。 */
const MAX_URLS = 64;
/** 桶数上限：TTL 只在「同键回访」时生效，看完就不再回来的键必须靠这条兜底。 */
const MAX_KEYS = 128;

interface Entry {
  urls: Set<string>;
  sites: string[];
  switches: number;
  ts: number;
}

const ledger = new Map<string, Entry>();

/** 自动换线即将 navigate 时置位；由新播放页挂载时消费。 */
let autoNavPending = false;

function touch(entry: Entry): void {
  entry.ts = Date.now();
}

function bucket(key: string): Entry {
  const cur = ledger.get(key);
  if (cur && Date.now() - cur.ts < TTL_MS) {
    return cur;
  }
  if (ledger.size >= MAX_KEYS) {
    // 先清过期项（多数情况一次就够），仍超限再按插入序丢最旧的。
    const now = Date.now();
    for (const [k, entry] of ledger) {
      if (now - entry.ts >= TTL_MS) ledger.delete(k);
    }
    while (ledger.size >= MAX_KEYS) {
      const oldest = ledger.keys().next();
      if (oldest.done || oldest.value === key) break;
      ledger.delete(oldest.value);
    }
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
  touch(b);
  if (b.urls.size < MAX_URLS) {
    b.urls.add(url);
  }
}

export function ledgerSiteSeen(key: string, siteKey: string): boolean {
  return bucket(key).sites.includes(siteKey);
}

export function ledgerMarkSite(key: string, siteKey: string): void {
  const b = bucket(key);
  touch(b);
  if (!b.sites.includes(siteKey)) {
    b.sites.push(siteKey);
  }
}

/** 剩余自动跳转预算；0 表示该停了。 */
export function ledgerBudget(key: string): number {
  return MAX_SWITCHES - bucket(key).switches;
}

export function ledgerCountSwitch(key: string): void {
  const b = bucket(key);
  touch(b);
  b.switches += 1;
}

/**
 * 媒体真正开始解码（loadedmetadata）时调用：本线路确认可播，连续失败链
 * 中断，跳转预算恢复满额。urls/sites 记账保留——同一地址换个入口还是坏的。
 */
export function ledgerSuccess(key: string): void {
  const b = bucket(key);
  touch(b);
  b.switches = 0;
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
