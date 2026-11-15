"""CMS field mapping for the offline source-audit tool.

Developer-tool copy: `tools/audit/scan_sources.py` needs to read community CMS
responses without starting the app. The runtime parser lives in Rust
(`src-tauri/src/domain/spider/cms_parse.rs`) and is the one that ships — keep
this file compatible when the contract changes, but do not import it from the
Python adapter.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from typing import Any

VOD_FIELDS = (
    "vod_id",
    "vod_name",
    "vod_pic",
    "vod_remarks",
    "vod_content",
    "vod_year",
    "vod_area",
    "vod_actor",
    "vod_director",
    "type_name",
    "vod_play_from",
    "vod_play_url",
)

JSON_ALIASES = {
    "id": "vod_id",
    "name": "vod_name",
    "pic": "vod_pic",
    "remarks": "vod_remarks",
    "des": "vod_content",
    "content": "vod_content",
    "year": "vod_year",
    "area": "vod_area",
    "actor": "vod_actor",
    "director": "vod_director",
}


def _vod(raw: dict[str, Any]) -> dict[str, Any]:
    item: dict[str, Any] = {}
    for field in VOD_FIELDS:
        if field in raw:
            item[field] = raw[field]
    for alias, field in JSON_ALIASES.items():
        if field not in item and alias in raw:
            item[field] = raw[alias]
    # The contract keeps ids as strings; CMS payloads often send numbers.
    item["vod_id"] = str(item.get("vod_id") or raw.get("id") or "")
    item.setdefault("vod_name", str(raw.get("vod_name") or raw.get("name") or ""))
    item.setdefault("vod_pic", str(raw.get("vod_pic") or raw.get("pic") or ""))
    item.setdefault("vod_play_from", str(raw.get("vod_play_from") or ""))
    item.setdefault("vod_play_url", str(raw.get("vod_play_url") or ""))
    return item


def _as_int(value: Any, default: int) -> int:
    """TVBox payloads carry numbers, numeric strings and occasionally junk."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _page_from_json(payload: dict[str, Any]) -> dict[str, Any]:
    # A third-party py spider may accidentally return a bound method / string
    # where a list is expected ("'method' object is not iterable"). Normalize
    # defensively here too, not just in pyspider, so the CMS path gets the same
    # guarantee and the caller always receives a JSON-safe envelope.
    items = payload.get("list")
    if not isinstance(items, (list, tuple)):
        items = []
    classes = payload.get("class")
    if classes is None:
        classes = payload.get("classes")
    if isinstance(classes, dict):
        classes = [
            {"type_id": str(k), "type_name": str(v)} for k, v in classes.items()
        ]
    elif not isinstance(classes, (list, tuple)):
        classes = []
    filters = payload.get("filters") or {}
    return {
        "list": [_vod(item) for item in items if isinstance(item, dict)],
        "filters": filters if isinstance(filters, dict) else {},
        "pagecount": _as_int(payload.get("pagecount"), 1),
        "page": _as_int(payload.get("page"), 1),
        "limit": _as_int(payload.get("limit"), 20),
        "total": _as_int(payload.get("total"), len(items)),
        "classes": classes,
    }


def _page_from_xml(raw: str) -> dict[str, Any]:
    root = ET.fromstring(raw)
    node = root.find(".//list")
    if node is None:
        node = root
    items = []
    for video in node.findall("video"):
        play_from = []
        play_url = []
        for dd in video.findall(".//dd"):
            play_from.append(dd.get("flag") or "")
            play_url.append((dd.text or "").strip())
        items.append(
            _vod(
                {
                    "vod_id": video.findtext("id", ""),
                    "vod_name": video.findtext("name", ""),
                    "vod_pic": video.findtext("pic", ""),
                    "vod_content": video.findtext("des", ""),
                    "type_name": video.findtext("type", ""),
                    "vod_play_from": "$$$".join(play_from),
                    "vod_play_url": "$$$".join(play_url),
                }
            )
        )
    attrib = node.attrib
    return {
        "list": items,
        "filters": {},
        "pagecount": int(attrib.get("pagecount") or 1),
        "page": int(attrib.get("page") or 1),
        "limit": int(attrib.get("pagesize") or 20),
        "total": int(attrib.get("recordcount") or len(items)),
        "classes": [],
    }


def parse_page(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty CMS response")
    if text.startswith("{"):
        payload = json.loads(text)
        if not isinstance(payload, dict):
            raise ValueError("CMS json must be an object")
        return _page_from_json(payload)
    return _page_from_xml(text)


def parse_home(params: dict[str, Any]) -> dict[str, Any]:
    return parse_page(str(params.get("raw") or ""))


def parse_category(params: dict[str, Any]) -> dict[str, Any]:
    return parse_page(str(params.get("raw") or ""))


def parse_search(params: dict[str, Any]) -> dict[str, Any]:
    return parse_page(str(params.get("raw") or ""))


_DETAIL_KEYS = ("vod_id", "vod_name", "vod_play_url", "vod_play_from", "vod_pic")


def _is_vod(value: Any) -> bool:
    return isinstance(value, dict) and any(key in value for key in _DETAIL_KEYS)


def _detail_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Recover a vod from non-standard `ac=detail` JSON envelopes.

    A few CMS deployments answer `ac=detail` with the vod object directly, with
    `{"list": vod}`, or wrap it in `data` / `result` / `vod` instead of a list.
    This is a boundary-level fallback shared by every site, not a per-source
    patch; the standard `{"list": [...]}` still wins via `parse_page`.
    """
    for key in ("list", "data", "result", "vod"):
        value = payload.get(key)
        if isinstance(value, list):
            return [_vod(item) for item in value if isinstance(item, dict)]
        if _is_vod(value):
            return [_vod(value)]
    if _is_vod(payload):
        return [_vod(payload)]
    return []


def parse_detail(params: dict[str, Any]) -> list[dict[str, Any]]:
    raw = str(params.get("raw") or "")
    try:
        items = parse_page(raw)["list"]
    except (ValueError, ET.ParseError):
        items = []
    if items:
        return items
    text = raw.strip()
    if not text.startswith("{"):
        return []
    try:
        payload = json.loads(text)
    except ValueError:
        return []
    return _detail_from_payload(payload) if isinstance(payload, dict) else []
