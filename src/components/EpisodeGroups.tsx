import { useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Icon from "./Icon";
import { EPISODE_GROUP_SIZE, groupEpisodes } from "../lib/episodeGroups";

interface EpisodeGroupsProps<T extends { index: number }> {
  /** 已过滤、排好序的剧集条目；`index` 指原始剧集数组位置。 */
  items: T[];
  /** 当前关注集的原索引：它所在段默认展开。换集 / 换线路后重新跟随。 */
  focusIndex?: number | null;
  renderItem: (item: T) => ReactNode;
  size?: number;
}

/**
 * 长剧集的折叠分段。
 *
 * 段数不足两段时退化成普通网格——短剧多一层段头只是噪音。展开状态跟着
 * `focusIndex` 走：切集后自动落到新的一段，手动点开别段只影响这一次浏览。
 */
export default function EpisodeGroups<T extends { index: number }>({
  items,
  focusIndex = null,
  renderItem,
  size = EPISODE_GROUP_SIZE,
}: EpisodeGroupsProps<T>) {
  const groups = useMemo(() => groupEpisodes(items, size), [items, size]);
  const baseId = useId();
  /** 手动展开的段；`key` 为 null 表示「全部收起」。null 状态本身代表跟随当前集。 */
  const [manual, setManual] = useState<{ key: string | null } | null>(null);

  const followKey = useMemo(() => {
    if (focusIndex !== null) {
      const hit = groups.find((group) =>
        group.items.some((item) => item.index === focusIndex),
      );
      if (hit) {
        return hit.key;
      }
    }
    return groups[0]?.key ?? null;
  }, [groups, focusIndex]);

  useEffect(() => {
    setManual(null);
  }, [followKey]);

  const openKey =
    manual === null
      ? followKey
      : groups.some((group) => group.key === manual.key)
        ? manual.key
        : null;

  if (groups.length <= 1) {
    return <div className="episode-grid">{(groups[0]?.items ?? []).map(renderItem)}</div>;
  }

  return (
    <div className="episode-groups">
      {groups.map((group, position) => {
        const open = group.key === openKey;
        const panelId = `${baseId}-group-${position}`;
        const holdsFocus =
          focusIndex !== null && group.items.some((item) => item.index === focusIndex);
        return (
          <div className="episode-group" key={group.key}>
            <button
              type="button"
              className={open ? "episode-group__head is-open" : "episode-group__head"}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setManual({ key: open ? null : group.key })}
            >
              <span className="episode-group__label">{group.label}</span>
              {holdsFocus ? (
                <span className="episode-group__here">
                  <span className="episode-group__dot" aria-hidden="true" />
                  当前
                </span>
              ) : null}
              <span className="episode-group__line" aria-hidden="true" />
              <Icon name="chevron" size={14} className="episode-group__caret" />
            </button>
            {open ? (
              <div className="episode-grid" id={panelId}>
                {group.items.map(renderItem)}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
