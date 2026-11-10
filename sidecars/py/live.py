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
    """Return `{groups:[{name, channels:[{name,url,logo,epg}]}]}`."""
    groups: dict[str, list[dict[str, str]]] = {}
    pending: dict[str, str] | None = None

    for line in (raw or "").splitlines():
        text = line.strip()
        if not text:
            continue
        if text.startswith("#EXTINF"):
            pending = _parse_extinf(text)
            continue
        if text.startswith("#"):
            continue
        if pending is None:
            # A bare URL playlist: keep it, but with an empty name.
            pending = {"name": text, "logo": "", "epg": "", "group": DEFAULT_GROUP}
            if text.startswith("http"):
                pending["name"] = ""
        streams = split_streams(text)
        if not streams:
            # Not a URL (or only a label after `$`); nothing to play.
            pending = None
            continue
        channel = {
            "name": pending["name"] or streams[0].rsplit("/", 1)[-1],
            "url": streams[0],
            # Alternate lines stay available for a retry on the same channel.
            "urls": streams,
            "logo": pending["logo"],
            "epg": pending["epg"],
        }
        groups.setdefault(pending["group"] or DEFAULT_GROUP, []).append(channel)
        pending = None

    return {
        "groups": [
            {"name": name, "channels": channels} for name, channels in groups.items()
        ],
        "source": url,
        "count": sum(len(items) for items in groups.values()),
    }
