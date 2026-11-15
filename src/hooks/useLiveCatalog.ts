/**
 * 直播目录编排：源选择 → 分组频道 → 展平成一维列表。
 *
 * 从 `LivePage` 抽出（那个文件同时承担「列表页」与「播放页」两种身份，
 * 2026-11-14 重构为单一播放页）。这里只负责数据，不碰播放器：
 *   - **源记忆**：localStorage 记住上次选的 `sourceKey`，进页面直接回到那个源；
 *   - **列表缓存**：`lib/liveChannels` 的进程内缓存优先，刷新按钮才穿透重拉；
 *   - **容器型源**（只有 channels 没有 url）本地展开，不发网络请求。
 */
import { useEffect, useMemo, useState } from "react";
import { classifyFailure, type FailureReason } from "../lib/failureReason";
import { api, toAppError } from "../lib/invoke";
import {
  expandChannels,
  isListableSource,
  liveSourceKey,
  normalizeGroups,
  peekLiveGroups,
  primeLiveGroups,
  rememberLiveSource,
} from "../lib/liveChannels";
import type { LiveChannel, LiveGroup, LiveSource } from "../types/luma";

/** 上次选中的直播源（存 sourceKey，源顺序变了也认得）。 */
const SOURCE_KEY = "luma:live:source:v1";

function readSourceKey(): string {
  try {
    return window.localStorage.getItem(SOURCE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeSourceKey(key: string): void {
  try {
    window.localStorage.setItem(SOURCE_KEY, key);
  } catch {
    /* 记不住只影响下次落在哪个源，不影响本次。 */
  }
}

/** 第一个「能列出频道」的源；全都不能列时退回 0，让页面显示空态而不是白屏。 */
function firstListable(lives: LiveSource[]): number {
  const index = lives.findIndex(isListableSource);
  return index >= 0 ? index : 0;
}

/** 恢复上次的源；它已不在配置里（换配置 / 订阅更新）就回第一个可列源。 */
function restoreIndex(lives: LiveSource[]): number {
  if (lives.length === 0) {
    return 0;
  }
  const remembered = readSourceKey();
  if (remembered) {
    const hit = lives.findIndex(
      (item, index) =>
        liveSourceKey(item, index) === remembered && isListableSource(item),
    );
    if (hit >= 0) {
      return hit;
    }
  }
  return firstListable(lives);
}

export interface LiveCatalog {
  /** 配置里的全部直播源（用于下拉，含不可列的项）。 */
  lives: LiveSource[];
  /** 每个源能否列出频道：下拉里禁用不可列项，避免选中后一片空白。 */
  listable: boolean[];
  sourceIndex: number;
  source: LiveSource | undefined;
  /** 源的稳定标识：频道记忆与列表缓存的键。 */
  sourceKey: string;
  groups: LiveGroup[];
  /** 全部分组按顺序首尾相连：上一台 / 下一台与「第 N 台」计数都用它。 */
  flat: LiveChannel[];
  loading: boolean;
  /**
   * 加载失败的原因（已归类）。`null` = 没有错误。
   *
   * 这里**不存字符串**：直播源是用户自己填/导入的地址，报错原文里带着
   * 完整 URL（`fetch https://raw.githubusercontent.com/… failed`）。字符串
   * 状态一旦被直接渲染，界面就变成日志；交给 `classifyFailure` 归类后，
   * 界面只说「地址不可达」，原文折叠进技术详情。
   */
  error: FailureReason | null;
  switchSource: (index: number) => void;
  /** 刷新：穿透缓存重新下载并解析 m3u。 */
  refresh: () => void;
}

export function useLiveCatalog(lives: LiveSource[]): LiveCatalog {
  const [sourceIndex, setSourceIndex] = useState<number>(() =>
    restoreIndex(lives),
  );
  const [groups, setGroups] = useState<LiveGroup[]>([]);
  // 初值 true：冷启动首帧 effect 还没跑，false 会先闪一帧「没有可播放的
  // 频道」Empty。下方两个早退分支负责在无源时把它翻回 false。
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FailureReason | null>(null);
  /** 递增即重新下载；0 表示「优先用缓存」。 */
  const [reloadToken, setReloadToken] = useState(0);

  const listable = useMemo(() => lives.map(isListableSource), [lives]);

  // 重新导入配置后源数量可能变少（甚至换了一整套），旧索引会越界；
  // 当前源变成「不可列」时也要顺延，否则用户会停在一个永远空白的源上。
  useEffect(() => {
    if (lives.length === 0) {
      return;
    }
    const current = lives[sourceIndex];
    if (current && isListableSource(current)) {
      return;
    }
    setSourceIndex(firstListable(lives));
  }, [lives, sourceIndex]);

  const source = lives[sourceIndex];
  const sourceKey = source ? liveSourceKey(source, sourceIndex) : "";

  // 切源时先亮出缓存（有的话），没有就清空旧源的列表——留着上一套频道
  // 会让用户以为新源里就是这些台。
  useEffect(() => {
    if (!sourceKey) {
      setGroups([]);
      setLoading(false);
      return;
    }
    const cached = peekLiveGroups(sourceKey);
    setGroups(cached ?? []);
    setError(null);
    setLoading(!cached && Boolean(source?.url));
  }, [sourceKey, source?.url]);

  useEffect(() => {
    if (!source) {
      setGroups([]);
      setLoading(false);
      return;
    }
    // 播放页刷新直达时 pageState 已空，靠记住的 url/ua 重新拉列表。
    rememberLiveSource(sourceKey, source);
    writeSourceKey(sourceKey);

    // 缓存命中且不是「用户点了刷新」：直接复用，切回已看过的源零等待。
    if (reloadToken === 0) {
      const cached = peekLiveGroups(sourceKey);
      if (cached) {
        setGroups(cached);
        setLoading(false);
        return;
      }
    }

    // 分组容器：本地展开即可，别拿 undefined 去请求接口。
    if (!source.url) {
      const local = normalizeGroups(expandChannels(source));
      primeLiveGroups(sourceKey, local);
      setGroups(local);
      setError(
        local.length === 0
          ? {
              kind: "disabled",
              label: "该直播源是分组容器，没有可直接播放的地址",
              hint: "在配置里展开子源，或换一个直播源",
              raw: "",
            }
          : null,
      );
      setLoading(false);
      return;
    }

    let alive = true;
    setLoading(true);
    setError(null);
    void api
      .liveParse(source.url, source.ua, reloadToken > 0)
      .then((result) => {
        const next = normalizeGroups(result.groups ?? []);
        primeLiveGroups(sourceKey, next);
        if (alive) {
          setGroups(next);
        }
      })
      .catch((err) => {
        if (alive) {
          const appError = toAppError(err);
          setGroups([]);
          setError(classifyFailure(appError.code, appError.message));
        }
      })
      .finally(() => {
        if (alive) {
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [source, sourceKey, reloadToken]);

  const flat = useMemo(
    () => groups.flatMap((group) => group.channels),
    [groups],
  );

  return {
    lives,
    listable,
    sourceIndex,
    source,
    sourceKey,
    groups,
    flat,
    loading,
    error,
    switchSource: (index: number) => {
      if (index === sourceIndex || !lives[index]) {
        return;
      }
      setSourceIndex(index);
      setReloadToken(0);
    },
    refresh: () => setReloadToken((value) => value + 1),
  };
}
