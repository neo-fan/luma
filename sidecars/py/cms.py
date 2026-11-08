"""CMS parsing for site.parseHome / parseCategory / parseDetail / parseSearch.

Accepts the raw body returned by `cms.rs` and converts JSON or XML CMS
responses into the normalized contract (spec 7.2 / 8.2). Parsing stays here so
Rust never re-implements field mapping.
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


def _page_from_json(payload: dict[str, Any]) -> dict[str, Any]:
    items = payload.get("list") or []
    classes = payload.get("class") or payload.get("classes") or []
    if isinstance(classes, dict):
        classes = [
            {"type_id": str(k), "type_name": str(v)} for k, v in classes.items()
        ]
    filters = payload.get("filters") or {}
    return {
        "list": [_vod(item) for item in items if isinstance(item, dict)],
        "filters": filters if isinstance(filters, dict) else {},
        "pagecount": int(payload.get("pagecount") or 1),
        "page": int(payload.get("page") or 1),
        "limit": int(payload.get("limit") or 20),
        "total": int(payload.get("total") or len(items)),
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


def parse_detail(params: dict[str, Any]) -> list[dict[str, Any]]:
    return parse_page(str(params.get("raw") or ""))["list"]
