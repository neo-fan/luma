"""M3U / TXT live playlist parsing (spec 7.2 `live.parseM3u`).

Only the plain M3U subset is handled: `#EXTINF` attributes plus the URL line.
Groups come from `group-title`; channels without a group fall into 未分组.
"""

from __future__ import annotations

import re
from typing import Any

ATTR = re.compile(r'([\w-]+)="([^"]*)"')

DEFAULT_GROUP = "未分组"


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
        channel = {
            "name": pending["name"] or text.rsplit("/", 1)[-1],
            "url": text,
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
