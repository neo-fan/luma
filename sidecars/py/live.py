"""M3U / TXT live playlist parsing (spec 7.2 `live.parseM3u`).

Only the plain M3U subset is handled: `#EXTINF` attributes plus the URL line.
Groups come from `group-title`; channels without a group fall into 未分组.
"""

from __future__ import annotations

import io
import re
from datetime import datetime, timedelta, timezone
from typing import Any

ATTR = re.compile(r'([\w-]+)="([^"]*)"')

DEFAULT_GROUP = "未分组"


def split_streams(text: str) -> list[str]:
    """Split a TVBox multi-line URL (`url1$url2`).

    Playlists also carry a label after the separator, e.g.
    `https://.../video.m3u8$LR•IPV4•2『线路1』`, so only the http-looking parts
    count. Keeping the whole string (the old behaviour) produces a 404 because
    the label ends up inside the URL.
    """
    out: list[str] = []
    for part in (text or "").split("$"):
        part = part.strip()
        if part.startswith(("http://", "https://")):
            out.append(part)
    return out


def _parse_extinf(line: str) -> dict[str, str]:
    attrs = {key.lower(): value for key, value in ATTR.findall(line)}
    comma = line.rfind(",")
    title = line[comma + 1 :].strip() if comma >= 0 else ""
    name = attrs.get("tvg-name") or title
    return {
        "name": name or "",
        "logo": attrs.get("tvg-logo", ""),
        "epg": attrs.get("tvg-id", ""),
        "group": attrs.get("group-title", "") or DEFAULT_GROUP,
    }


def parse_m3u(raw: str, url: str = "") -> dict[str, Any]:
    """Return `{groups:[{name, channels:[{name,url,urls,logo,epg}]}]}`.

    Channels sharing the same name inside one group are merged into a single
    entry whose `urls` collects every playable line (deduped, original order
    kept). This mirrors TVBox's 线路 behaviour: a station repeated by several
    providers becomes one chip with N switchable lines instead of N rows.
    """
    # group -> channel name -> merged channel
    groups: dict[str, dict[str, dict[str, Any]]] = {}
    pending: dict[str, str] | None = None
    current_group = DEFAULT_GROUP

    for line in (raw or "").splitlines():
        text = line.strip()
        if not text:
            continue
        if text.startswith("#EXTINF"):
            pending = _parse_extinf(text)
            current_group = pending.get("group") or DEFAULT_GROUP
            continue
        if text.startswith("#"):
            continue
        if pending is None:
            # A bare URL playlist: keep it, but with an empty name.
            pending = {"name": text, "logo": "", "epg": "", "group": DEFAULT_GROUP}
            if text.startswith("http"):
                pending["name"] = ""
            current_group = DEFAULT_GROUP
        streams = split_streams(text)
        if not streams:
            # Not a URL (or only a label after `$`); nothing to play.
            pending = None
            continue
        name = pending["name"] or streams[0].rsplit("/", 1)[-1]
        bucket = groups.setdefault(current_group, {})
        existing = bucket.get(name)
        if existing is None:
            bucket[name] = {
                "name": name,
                "url": streams[0],
                "urls": list(streams),
                "logo": pending["logo"],
                "epg": pending["epg"],
            }
        else:
            # 同名频道聚合：合并线路，去重且保留首次出现顺序。
            for stream in streams:
                if stream not in existing["urls"]:
                    existing["urls"].append(stream)
        pending = None

    out_groups = [
        {"name": gname, "channels": list(channels.values())}
        for gname, channels in groups.items()
    ]
    return {
        "groups": out_groups,
        "source": url,
        "count": sum(len(channels) for channels in groups.values()),
    }


def _epg_localize(value: str) -> str:
    """把 XMLTV 时间 `20261113060000 +0800` 转成 ISO 8601（`2026-11-13T06:00:00+08:00`）。
    解析失败则原样返回，交给前端兜底。"""
    if not value:
        return ""
    match = re.match(
        r"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?",
        value.strip(),
    )
    if not match:
        return value
    year, month, day, hour, minute, second, tz = match.groups()
    offset = None
    if tz:
        sign = 1 if tz[0] == "+" else -1
        offset = timezone(sign * timedelta(hours=int(tz[1:3]), minutes=int(tz[3:5])))
    try:
        dt = datetime(
            int(year), int(month), int(day), int(hour), int(minute), int(second), tzinfo=offset
        )
        return dt.isoformat()
    except ValueError:
        return value


def parse_epg(raw: str, channel: str, date: str | None = None) -> dict[str, Any]:
    """Parse an XMLTV payload and return programmes for one channel.

    `raw` can be tens of MB; stream with `iterparse` so the whole document is
    never built in memory. Two passes: first map channel id -> display names,
    then keep only programmes whose channel matches the requested name (by id
    or any display-name alias, with a substring fallback for common variants
    like `CCTV-1` vs `CCTV-1 综合`).
    """
    import xml.etree.ElementTree as ET

    target = (channel or "").strip()
    if not target:
        return {"channel": channel, "date": date, "programs": []}

    # Pass 1: channel id -> display names.
    id_to_names: dict[str, set[str]] = {}
    names_to_id: dict[str, str] = {}
    try:
        for _event, elem in ET.iterparse(io.BytesIO(raw.encode("utf-8")), events=("end",)):
            # 只在 channel 结束节点收集并清理：display-name 是 channel 的子，
            # 若在子节点 end 时提前 clear，父 channel 聚合时子节点已被清空 → 匹配全空。
            if elem.tag == "channel":
                cid = elem.get("id", "")
                names: set[str] = set()
                for child in elem:
                    if child.tag in ("display-name", "name"):
                        text = (child.text or "").strip()
                        if text:
                            names.add(text)
                id_to_names[cid] = names
                for name in names:
                    names_to_id.setdefault(name, cid)
                elem.clear()
            elif elem.tag == "tv":
                # 根节点收尾，释放整棵已解析子树，避免内存峰值。
                elem.clear()
    except ET.ParseError:
        return {"channel": channel, "date": date, "programs": []}

    # Resolve which channel ids match the requested name.
    matched: set[str] = set()
    if target in names_to_id:
        matched.add(names_to_id[target])
    if target in id_to_names:
        matched.add(target)
    for cid, names in id_to_names.items():
        if any(target in name or name in target for name in names):
            matched.add(cid)
    if not matched:
        return {"channel": channel, "date": date, "programs": []}

    # Pass 2: keep matching programmes only.
    programs: list[dict[str, Any]] = []
    # programme 的子标签（title/desc 等）不能在自身 end 时 clear，否则 programme 聚合时
    # 子节点已被清空、取不到标题；其余顶层元素（tv/channel/display-name）直接释放。
    programme_subtags = {"title", "desc", "sub-title", "credits", "category", "icon", "episode-num", "rating"}
    for _event, elem in ET.iterparse(io.BytesIO(raw.encode("utf-8")), events=("end",)):
        if elem.tag == "programme":
            if elem.get("channel") in matched:
                start = elem.get("start", "")
                stop = elem.get("stop")
                title = ""
                desc = ""
                for child in elem:
                    if child.tag == "title" and not title:
                        title = (child.text or "").strip()
                    elif child.tag == "desc" and not desc:
                        desc = (child.text or "").strip()
                programs.append(
                    {
                        "start": _epg_localize(start),
                        "stop": _epg_localize(stop) if stop else "",
                        "title": title,
                        "desc": desc,
                    }
                )
            elem.clear()
        elif elem.tag not in programme_subtags:
            elem.clear()

    programs.sort(key=lambda item: item["start"])
    return {"channel": channel, "date": date, "programs": programs}
