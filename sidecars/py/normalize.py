"""Field-dialect normalization (spec 6.1 / 6.2 / 8.2 / 8.3).

Converges community aliases into the normalized contract. Unknown fields are
kept under `_raw` instead of being dropped, so later adapters can use them.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

TOP_ALIASES = {"list": "sites", "parse": "parses", "jar": "spider"}
SITE_ALIASES = {"title": "name"}
BOOL_FIELDS = ("searchable", "quickSearch", "filterable")


def _bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _headers(value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items()}
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return {str(k): str(v) for k, v in parsed.items()}
    return {}


def _categories(value: Any) -> list[dict[str, str]]:
    if not isinstance(value, list):
        return []
    result = []
    for item in value:
        if isinstance(item, dict):
            result.append(
                {
                    "type_id": str(item.get("type_id") or item.get("id") or ""),
                    "type_name": str(item.get("type_name") or item.get("name") or ""),
                }
            )
        elif isinstance(item, str):
            result.append({"type_id": item, "type_name": item})
    return result


def route(site: dict[str, Any], global_spider: str | None) -> str:
    """Spec 8.3 priority; returns cms/python/quickjs/jvm."""
    jar = str(site.get("jar") or "")
    api = str(site.get("api") or "")
    key = str(site.get("key") or "")
    type_no = site.get("type")

    if jar == "py" or api.endswith(".py"):
        return "python"
    if jar == "js" or api.endswith(".js"):
        return "quickjs"
    if key.startswith("csp_") or jar.endswith(".jar"):
        return "jvm"
    # Spider class names are passed as bare identifiers (`api: "csp_Xxx"`).
    if api.startswith("csp_") or (api and not api.startswith(("http://", "https://")) and "/" not in api):
        return "jvm"
    if global_spider and not api:
        return "jvm"
    if type_no in (0, 1, 4):
        return "cms"
    if "provide/vod" in api or "api.php" in api:
        return "cms"
    return "cms"


def normalize_site(raw: dict[str, Any], global_spider: str | None = None) -> dict[str, Any]:
    site = dict(raw)
    for alias, canonical in SITE_ALIASES.items():
        if canonical not in site and alias in site:
            site[canonical] = site[alias]

    known = {
        "key",
        "name",
        "type",
        "api",
        "jar",
        "ext",
        "header",
        "headers",
        "ua",
        "searchable",
        "quickSearch",
        "filterable",
        "filter",
        "categories",
        "timeout",
        "playerType",
        "changeable",
        "style",
        "indexs",
        "title",
    }
    runtime = route(site, global_spider)
    timeout = site.get("timeout")
    try:
        timeout_ms = int(timeout) * 1000 if timeout else 15000
    except (TypeError, ValueError):
        timeout_ms = 15000

    out: dict[str, Any] = {
        "key": str(site.get("key") or ""),
        "name": str(site.get("name") or site.get("key") or ""),
        "runtime": runtime,
        "api": str(site.get("api") or ""),
        "headers": _headers(site.get("headers") or site.get("header")),
        "searchable": _bool(site.get("searchable", 0)),
        "quickSearch": _bool(site.get("quickSearch", 0)),
        "filterable": _bool(site.get("filterable", 0)),
        "categories": _categories(site.get("categories")),
        "timeoutMs": timeout_ms,
        "enabled": True,
        "_raw": {k: v for k, v in site.items() if k not in known and k not in SITE_ALIASES},
    }
    for optional in ("jar", "ext", "type"):
        if site.get(optional) not in (None, ""):
            out[optional] = site[optional]
    if runtime == "cms" and site.get("type") not in (0, 1, 4, None):
        out["_raw"]["needsProbe"] = True
    return out


def normalize_config(raw: dict[str, Any], origin: str) -> dict[str, Any]:
    config = dict(raw)
    for alias, canonical in TOP_ALIASES.items():
        if canonical not in config and alias in config:
            config[canonical] = config[alias]

    spider = config.get("spider") or config.get("jar")
    spider_value = spider if isinstance(spider, str) else None

    sites_raw = config.get("sites") or []
    if not isinstance(sites_raw, list):
        sites_raw = []
    sites = [normalize_site(s, spider_value) for s in sites_raw if isinstance(s, dict)]

    known_top = {
        "sites",
        "list",
        "lives",
        "parses",
        "parse",
        "spider",
        "jar",
        "wallpaper",
        "flags",
        "ua",
        "urls",
        "home",
        "rules",
        "hosts",
        "logo",
    }
    snapshot_id = hashlib.sha1(origin.encode("utf-8")).hexdigest()[:12]
    return {
        "id": snapshot_id,
        "name": str(config.get("name") or "stub"),
        "importedAt": datetime.now(timezone.utc).isoformat(),
        "sites": sites,
        "lives": config.get("lives") or [],
        "parses": config.get("parses") or config.get("parse") or [],
        "spider": spider_value,
        "wallpaper": config.get("wallpaper"),
        "flags": config.get("flags") or [],
        "_raw": {k: v for k, v in config.items() if k not in known_top},
    }


def merge_repos(snapshots: list[dict[str, Any]]) -> dict[str, Any]:
    """Merge several normalized snapshots; first occurrence of a site key wins."""
    seen: set[str] = set()
    merged_sites = []
    lives: list[Any] = []
    parses: list[Any] = []
    for snap in snapshots:
        for site in snap.get("sites", []):
            key = site.get("key", "")
            if key and key in seen:
                continue
            seen.add(key)
            merged_sites.append(site)
        lives.extend(snap.get("lives") or [])
        parses.extend(snap.get("parses") or [])
    return {
        "id": hashlib.sha1("|".join(s.get("id", "") for s in snapshots).encode()).hexdigest()[:12],
        "name": "merged",
        "importedAt": datetime.now(timezone.utc).isoformat(),
        "sites": merged_sites,
        "lives": lives,
        "parses": parses,
    }
