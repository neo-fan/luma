"""M3U / TXT live playlist parsing (spec 7.2 `live.parseM3u`).

Only the plain M3U subset is handled: `#EXTINF` attributes plus the URL line.
Groups come from `group-title`; channels without a group fall into 未分组.
"""

from __future__ import annotations

import re
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
