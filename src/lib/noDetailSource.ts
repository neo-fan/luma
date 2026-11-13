/**
 * 「无详情源」记忆：`detailContent` 成功返回空、按片名同站也搜不到的源。
 *
 * 典型是「豆瓣[py]」这类纯发现/榜单源：脚本里 `detailContent` 直接
 * `return {"list": []}`、`searchContent` 也返回空，卡片能点开却永远没有
 * 播放列表。这不是客户端故障，但只说「详情加载失败」会让用户以为坏了。
 *
 * 判据来自实际调用而不是猜：详情空 **且** 同站按名搜索返回 0 条，两者同时
 * 成立才记一笔。记录只用来把详情页文案换成「这个源没有播放列表」，不改变
 * 任何兜底行为（同站回查、跨源自愈照旧），所以误标最多是措辞偏差。
 *
 * siteKey 只在同一份配置内有意义，因此记忆带 scope：切配置即清空，
 * 重启（同一 scope）保留。
 */
export const NO_DETAIL_KEY = "luma:no-detail-sources:v1";
/** 最多记 60 个源，超出丢最早标记的。 */
const MAX_SOURCES = 60;
const DEFAULT_SCOPE = "default";

export interface NoDetailStoreOptions {
  /** 注入假存储便于单测；传 null 表示不持久化。 */
  storage?: Storage | null;
}

export interface NoDetailStore {
  has(siteKey: string): boolean;
  /** 详情空 + 同站搜索空时调用；返回是否首次标记该源。 */
  note(siteKey: string, vodId: string): boolean;
  /** 用户手动重试时清掉，让下一次判定重新开始。 */
  forget(siteKey: string): void;
  /** 配置切换：scope 变了才清（与 sourceCache 的 scope 语义一致）。 */
  setScope(scope: string): void;
  clear(): void;
  list(): string[];
}

interface Persisted {
  scope: string;
  sites: string[];
}

/** 隐私模式 / 禁用存储时 localStorage 取值本身就可能抛错。 */
function safeStorage(injected?: Storage | null): Storage | null {
  if (injected !== undefined) {
    return injected;
  }
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readPersisted(storage: Storage | null): Persisted {
  const empty: Persisted = { scope: "", sites: [] };
  if (!storage) {
    return empty;
  }
  try {
    const raw = storage.getItem(NO_DETAIL_KEY);
    if (!raw) {
      return empty;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return empty;
    }
    const record = parsed as Partial<Persisted>;
    const sites = Array.isArray(record.sites)
      ? record.sites.filter(
          (item): item is string => typeof item === "string" && item.trim() !== "",
        )
      : [];
    return {
      scope: typeof record.scope === "string" ? record.scope : "",
      sites: sites.slice(-MAX_SOURCES),
    };
  } catch {
    return empty;
  }
}

export function createNoDetailStore(options: NoDetailStoreOptions = {}): NoDetailStore {
  const storage = safeStorage(options.storage);
  const persisted = readPersisted(storage);
  const known = new Set<string>(persisted.sites);
  let scope = persisted.scope;

  const persist = () => {
    if (!storage) {
      return;
    }
    try {
      const payload: Persisted = { scope, sites: [...known].slice(-MAX_SOURCES) };
      storage.setItem(NO_DETAIL_KEY, JSON.stringify(payload));
    } catch {
      // 存储被禁用：内存里仍然生效，本会话内文案照常。
    }
  };

  return {
    has: (siteKey) => known.has(siteKey),
    note(siteKey, vodId) {
      if (!siteKey || !vodId || known.has(siteKey)) {
        return false;
      }
      known.add(siteKey);
      while (known.size > MAX_SOURCES) {
        const oldest = known.values().next().value;
        if (oldest === undefined) {
          break;
        }
        known.delete(oldest);
      }
      persist();
      return true;
    },
    forget(siteKey) {
      if (known.delete(siteKey)) {
        persist();
      }
    },
    setScope(next) {
      const normalized = next || DEFAULT_SCOPE;
      if (normalized === scope) {
        return;
      }
      scope = normalized;
      known.clear();
      persist();
    },
    clear() {
      known.clear();
      if (storage) {
        try {
          storage.removeItem(NO_DETAIL_KEY);
        } catch {
          // 忽略：下次 note 时会重写。
        }
      }
    },
    list: () => [...known],
  };
}

export const noDetailSources = createNoDetailStore();
