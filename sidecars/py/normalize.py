"""Field-dialect normalization (spec 6.1 / 6.2 / 8.2 / 8.3).

Converges community aliases into the normalized contract. Unknown fields are
kept under `_raw` instead of being dropped, so later adapters can use them.
"""

from __future__ import annotations

import hashlib
import json
from urllib.parse import urljoin
from datetime import datetime, timezone
from typing import Any

TOP_ALIASES = {"list": "sites", "parse": "parses", "jar": "spider"}
SITE_ALIASES = {"title": "name"}
BOOL_FIELDS = ("searchable", "quickSearch", "filterable")


def _base_dir(origin: str) -> str:
    """Directory part of the config source, used to resolve `./py/x.py` refs."""
    origin = (origin or "").strip()
    for scheme in ("http://", "https://", "file://"):
        if origin.startswith(scheme):
            head, _, tail = origin.rpartition("/")
            return head + "/" if tail else origin
    return ""


def _resolve(origin: str, value: Any) -> Any:
    """Resolve a relative spider/asset path against the config origin.

    TVBox configs commonly ship as `<dir>/box.json` plus `./py/*.py`,
    `./jar/*.jar`, `./lib/*.m3u`, `./js/*.js`. Without this, every relative
    site degrades to an unfetchable path and the whole config looks broken.
    """
    if not isinstance(value, str):
        return value
    text = value.strip()
    if not text or text.startswith(("http://", "https://", "data:")):
        return value
    if not text.startswith(("./", "../", "/")):
        # Bare spider class names (`csp_XBPQ`) and inline JSON stay untouched.
        return value
    base = _base_dir(origin)
    if not base:
        return value
    # urljoin keeps `https://` intact; posixpath.normpath would collapse it.
    joined = urljoin(base, text)
    return joined if joined.startswith(("http://", "https://", "file://")) else value


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
    # Group dividers (`{"key":"1","name":"--- 1 ---"}`) carry no api/ext/jar at
    # all. They used to inherit the global spider and be counted as jvm sites,
    # which burned one guaranteed-to-fail call per divider on every fan-out.
    if not api and not site.get("ext") and not site.get("jar"):
        return "none"
    if global_spider and not api:
        return "jvm"
    if type_no in (0, 1, 4):
        return "cms"
    if "provide/vod" in api or "api.php" in api:
        return "cms"
    return "cms"


def normalize_site(
    raw: dict[str, Any],
    global_spider: str | None = None,
    origin: str = "",
) -> dict[str, Any]:
    """Normalize one site and route it to a runtime (`cms` / `py` / ...).

    Relative references in `api`, `jar`, `spider` and `ext` are resolved against
    `origin` *before* routing. Every field not in `known` is preserved in
    `site["_raw"]`, but config-level fields such as `changeable`, `orderNum` and
    `playerType` still need an explicit copy here: listing them in `known` only
    keeps them out of `_raw`, it does not keep them in the normalized site.
    Group dividers return `"none"` and are disabled so they do not inherit the
    global spider (which used to burn one doomed jvm call per divider).
    """
    site = dict(raw)
    for alias, canonical in SITE_ALIASES.items():
        if canonical not in site and alias in site:
            site[canonical] = site[alias]

    # Resolve relative references before routing so `./py/x.py` is recognized as
    # a real URL and can actually be fetched.
    for field in ("api", "jar", "logo", "ext"):
        if field in site:
            site[field] = _resolve(origin, site[field])

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
        # 缺省语义在各分支相反：Box/TVBoxOS 的 `int searchable` 默认 0（不可搜），
        # FongMi 的 `Integer searchable` 缺省按 1（可搜）算。社区配置大量站点
        # 干脆不写这个字段，按 0 处理会把半个配置的可用源误判成不可搜（实测
        # 101 站里 52 站未声明，其中 19 站是能搜的 py/js 源）。这里取可搜为
        # 缺省，真实「显式关闭」由下面的 searchableDeclared 保住。
        "searchable": _bool(site.get("searchable", 1)),
        "quickSearch": _bool(site.get("quickSearch", 0)),
        "filterable": _bool(site.get("filterable", 0)),
        "categories": _categories(site.get("categories")),
        "timeoutMs": timeout_ms,
        # Group dividers stay in the snapshot (the UI can render them as
        # headings) but are excluded from every fan-out.
        "enabled": runtime != "none",
        "_raw": {k: v for k, v in site.items() if k not in known and k not in SITE_ALIASES},
    }
    # Spec 1773: `ext`/`header`/`ua`/`filter`/`quickSearch`/`timeout`/
    # `categories`/`playerType`/`flags` must pass through untouched. Listing a
    # field in `known` above only stops it landing in `_raw` — it still has to
    # be copied here or it disappears from the snapshot entirely.
    for passed in ("jar", "ext", "type", "ua", "filter", "playerType", "style", "indexs"):
        if site.get(passed) not in (None, "", []):
            out[passed] = site[passed]
    # 只有配置**显式写了** `searchable` 才输出这一项：聚合搜索扇出据此跳过
    # `searchable: 0` 的源（TVBox 的语义是「别对我发起搜索」，豆瓣这类发现/
    # 推荐源会这么标）。缺省不输出 → 扇出保持宽容，避免误杀未声明字段的源。
    if site.get("searchable") is not None:
        out["searchableDeclared"] = _bool(site.get("searchable"))
    if site.get("changeable") is not None:
        out["changeable"] = _bool(site.get("changeable"))
    order = site.get("order_num")
    if isinstance(order, (int, float)) and not isinstance(order, bool):
        out["orderNum"] = int(order)
    if runtime == "cms" and site.get("type") not in (0, 1, 4, None):
        out["_raw"]["needsProbe"] = True
    return out


def normalize_config(raw: dict[str, Any], origin: str) -> dict[str, Any]:
    """Normalize a whole config: aliases, top-level `headers[]`, and the
    relative paths in `spider`, `lives[].url` / `channels` and `parses[].url`.

    `origin` is the URL the config was imported from; every relative reference
    is resolved against it (never against a bare `./` path). Sites are
    normalized one by one with `normalize_site`, and config-level fields are
    kept even when a site-level counterpart exists.
    """
    config = dict(raw)
    for alias, canonical in TOP_ALIASES.items():
        if canonical not in config and alias in config:
            config[canonical] = config[alias]

    spider = config.get("spider") or config.get("jar")
    spider_value = _resolve(origin, spider) if isinstance(spider, str) else None

    sites_raw = config.get("sites") or []
    if not isinstance(sites_raw, list):
        sites_raw = []
    sites = [normalize_site(s, spider_value, origin) for s in sites_raw if isinstance(s, dict)]

    # Spec 8.3 / T-24: `csp_*` sites carry no per-site jar; the config-level
    # `spider` is the jar that supplies their classes. Attach it at import time
    # so the jar reference stays visible on jar-classified sites and a stale
    # snapshot still routes to jvm. 1.0.3 已移除 JVM 运行时：jar 站点只保留分类
    # 并在导入时屏蔽，这个字段不再用于探测或加载。
    if spider_value:
        for site in sites:
            if site.get("runtime") == "jvm" and not site.get("jar"):
                site["jar"] = spider_value

    lives_raw = config.get("lives") or []
    lives = []
    for item in lives_raw if isinstance(lives_raw, list) else []:
        if isinstance(item, dict) and "url" in item:
            item = {**item, "url": _resolve(origin, item.get("url"))}
        lives.append(item)

    parses_raw = config.get("parses") or config.get("parse") or []
    parses = []
    for item in parses_raw if isinstance(parses_raw, list) else []:
        if isinstance(item, dict) and "url" in item:
            item = {**item, "url": _resolve(origin, item.get("url"))}
        parses.append(item)

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
        "headers",
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
        "name": _config_name(config, origin),
        "importedAt": datetime.now(timezone.utc).isoformat(),
        "sites": sites,
        "lives": lives,
        "parses": parses,
        # Host -> header table for anti-leech CDNs (UA/Referer injected per host).
        "headers": _host_rules(config.get("headers")),
        "spider": spider_value,
        "wallpaper": config.get("wallpaper"),
        "flags": config.get("flags") or [],
        "_raw": {k: v for k, v in config.items() if k not in known_top},
    }


def _host_rules(value: Any) -> list[dict[str, Any]]:
    """Normalise the top-level `headers` table (TVBox host → header)."""
    out: list[dict[str, Any]] = []
    for item in value if isinstance(value, list) else []:
        if not isinstance(item, dict):
            continue
        host = str(item.get("host") or "").strip()
        header = item.get("header") or item.get("headers") or {}
        if not host or not isinstance(header, dict):
            continue
        pairs = {str(k): str(v) for k, v in header.items() if v not in (None, "")}
        if not pairs:
            continue
        out.append({"host": host, "header": pairs})
    return out


def _config_name(config: dict[str, Any], origin: str) -> str:
    """Configs rarely carry a `name`; showing "stub" in the UI looks broken."""
    explicit = str(config.get("name") or "").strip()
    if explicit:
        return explicit
    cleaned = (origin or "").rstrip("/")
    tail = cleaned.rsplit("/", 1)[-1]
    if tail and not tail.startswith("http") and "?" not in tail:
        stem = tail.rsplit(".", 1)[0]
        if stem:
            return stem
    for scheme in ("https://", "http://"):
        if cleaned.startswith(scheme):
            host = cleaned[len(scheme) :].split("/", 1)[0]
            if host:
                return host
    return "本地配置"


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
