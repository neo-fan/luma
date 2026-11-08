"""Parse-API rule resolution (spec 7.2 `parse.resolve`, 10 节四级降级).

Level 1/2 of the fallback chain only: given a parse rule and a play page URL,
build the URL the webview should open. Real sniffing (level 4) is P3/T-29 and
lives in an isolated webview, not here.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

TEMPLATE_KEYS = ("url", "parse", "api", "playUrl")


def resolve(url: str, rule: dict[str, Any] | None, headers: dict[str, str] | None = None) -> dict[str, Any]:
    rule = rule or {}
    target = ""
    for key in TEMPLATE_KEYS:
        value = rule.get(key)
        if isinstance(value, str) and value:
            target = value
            break

    if target:
        resolved = (
            target.replace("${url}", url)
            .replace("{url}", url)
            .replace("$url", url)
        )
        if resolved == target and url not in target:
            separator = "&" if "?" in target else "?"
            resolved = f"{target}{separator}url={quote(url, safe='')}"
    else:
        resolved = url

    merged_headers = {str(k): str(v) for k, v in (headers or {}).items()}
    extra = rule.get("headers")
    if isinstance(extra, dict):
        merged_headers.update({str(k): str(v) for k, v in extra.items()})

    return {
        "kind": "webview",
        "url": resolved,
        "headers": merged_headers,
        "parse": "direct",
    }
