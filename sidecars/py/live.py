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


# 画质后缀：`东方卫视4K` 要能匹配到 `东方卫视` 的节目单。
_QUALITY_SUFFIX = re.compile(r"(?:2160p|1080p|720p|4k|8k|uhd|hd|超清|高清|标清|蓝光)$", re.I)
_SEPARATORS = re.compile(r"[\s\-_.·]+")


def _norm_channel(value: str) -> str:
    """频道名归一：去画质后缀、去空格与分隔符、统一小写。

    `CCTV-1 综合` → `cctv1综合`，`东方卫视4K` → `东方卫视`。
    """
    text = _QUALITY_SUFFIX.sub("", (value or "").strip())
    return _SEPARATORS.sub("", text).lower()


def _match_score(target: str, name: str) -> int:
    """0 = 不匹配；分数越高越可信。

    必须区分 `CCTV1` 与 `CCTV11`：真实的直播源里两者同时存在，用朴素的
    `target in name` 会让 CCTV1 频道把 CCTV11/12… 的节目单一起收进来（实测
    一次返回 240 条上限）。这里要求「短的一侧后面不能再跟数字」。
    """
    left = _norm_channel(target)
    right = _norm_channel(name)
    if not left or not right:
        return 0
    if left == right:
        return 100
    if right.startswith(left) or left.startswith(right):
        longer, shorter = (right, left) if right.startswith(left) else (left, right)
        rest = longer[len(shorter) :]
        if rest and rest[0].isdigit():
            return 0
        # 前缀越长越可信：`cctv1` vs `cctv1综合` 要压过 `c` vs `cctv1综合`
        # （后者是 channel id 只有一个字母时出现的假阳性）。
        if len(shorter) < 2:
            return 0
        return 80 + round(10 * len(shorter) / len(longer))
    if left in right or right in left:
        return 40
    return 0


def _match_channels(
    target: str,
    id_to_names: dict[str, set[str]],
    names_to_id: dict[str, str],
) -> set[str]:
    """按频道名找出要取节目单的 channel id 集合。

    优先级：完全同名 > 归一化后相等 / 前缀（带数字边界）> 包含。
    取到最高分就停，避免「CCTV1」把「CCTV11」也匹配进来。
    """
    exact: set[str] = set()
    if target in names_to_id:
        exact.add(names_to_id[target])
    if target in id_to_names:
        exact.add(target)
    if exact:
        return exact

    best_score = 0
    best: set[str] = set()
    for cid, names in id_to_names.items():
        score = max((_match_score(target, name) for name in names), default=0)
        score = max(score, _match_score(target, cid))
        if score == 0:
            continue
        if score > best_score:
            best_score = score
            best = {cid}
        elif score == best_score:
            best.add(cid)
    return best


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

    matched = _match_channels(target, id_to_names, names_to_id)
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
    return {"channel": channel, "date": date, "programs": _within_window(programs, date)}


# 单频道单日最多返回多少条：e.xml 一份覆盖 9 天，不裁剪的话 CCTV1 会吐 2213 条，
# 前端一次渲染 2000+ 个 <li>，面板直接卡住。
MAX_EPG_PROGRAMS = 240


def _within_window(programs: list[dict[str, Any]], date: str | None) -> list[dict[str, Any]]:
    """只保留 `date` 当天（本地时区）的节目；没有 date 时取前后 3/21 小时。

    e.xml 是滚动 9 天的整表，而界面只展示「今天的节目单」——不过滤的话既费
    IPC 又费 DOM。日期解析失败（如源给了别的时间格式）就原样返回，宁可多不可少。
    """
    now = datetime.now().astimezone()
    window_start = now - timedelta(hours=3)
    window_end = now + timedelta(hours=21)
    key = (date or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", key):
        try:
            day = datetime.strptime(key, "%Y-%m-%d").replace(tzinfo=now.tzinfo)
        except ValueError:
            day = None
        if day is not None:
            window_start = day
            window_end = day + timedelta(days=1)

    out: list[dict[str, Any]] = []
    for item in programs:
        try:
            start = datetime.fromisoformat(item["start"])
        except (ValueError, TypeError):
            out.append(item)
            continue
        if start.tzinfo is None:
            start = start.replace(tzinfo=now.tzinfo)
        if start >= window_end:
            continue
        stop = None
        if item.get("stop"):
            try:
                stop = datetime.fromisoformat(item["stop"])
                if stop.tzinfo is None:
                    stop = stop.replace(tzinfo=now.tzinfo)
            except (ValueError, TypeError):
                stop = None
        # 跨天节目（昨天 23:30 开始的）也要留在今天的列表里。
        if stop is not None:
            if stop <= window_start:
                continue
        elif start < window_start:
            continue
        out.append(item)
    return out[:MAX_EPG_PROGRAMS]
