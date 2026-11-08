#!/usr/bin/env python3
"""Inspect a TVBox image-seed config and extract its embedded JSONC payload.

Dev-only helper. It never performs network requests and never writes external
URLs into product code. Input/output stay inside tests/fixtures/manual/,
which is ignored by Git.

Usage:
    python3 tools/inspect_config.py [path/to/seed.txt]
"""

from __future__ import annotations

import base64
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INPUT = ROOT / "tests" / "fixtures" / "manual" / "fantaiying-tv.txt"
MARKER = b"BFkMrNQT**"


def find_payload(seed: bytes) -> bytes:
    """Return the base64 region following the image-seed marker."""
    pos = seed.find(MARKER)
    if pos < 0:
        raise ValueError("image-seed marker not found; not a TVBox seed file")
    tail = seed[pos + len(MARKER):]
    encoded = re.sub(rb"[^A-Za-z0-9+/=]", b"", tail)
    if not encoded:
        raise ValueError("empty base64 region")
    padded = encoded + b"=" * ((-len(encoded)) % 4)
    return base64.b64decode(padded, validate=False)


def strip_line_comments(text: str) -> str:
    """Remove // comments outside string literals, keeping // inside URLs."""
    out: list[str] = []
    in_string = False
    escaped = False
    i = 0
    while i < len(text):
        ch = text[i]
        if in_string:
            out.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
            continue
        if ch == "/" and i + 1 < len(text) and text[i + 1] == "/":
            while i < len(text) and text[i] not in "\r\n":
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def summarize(config: dict) -> dict:
    sites = config.get("sites") or []
    lives = config.get("lives") or []
    parses = config.get("parses") or config.get("parse") or []
    types = Counter(str(s.get("type", "-")) for s in sites if isinstance(s, dict))
    keys = Counter()
    for site in sites:
        if isinstance(site, dict):
            keys.update(site.keys())
    return {
        "top_level_keys": sorted(config.keys()),
        "sites_count": len(sites),
        "site_type_distribution": dict(sorted(types.items())),
        "sites_with_jar": sum(1 for s in sites if isinstance(s, dict) and s.get("jar")),
        "sites_with_api": sum(1 for s in sites if isinstance(s, dict) and s.get("api")),
        "sites_with_ext": sum(1 for s in sites if isinstance(s, dict) and s.get("ext")),
        "sites_with_header": sum(1 for s in sites if isinstance(s, dict) and s.get("header")),
        "sites_with_ua": sum(1 for s in sites if isinstance(s, dict) and s.get("ua")),
        "site_field_frequency": dict(keys.most_common()),
        "lives_count": len(lives),
        "parses_count": len(parses),
        "has_spider": bool(config.get("spider")),
        "has_wallpaper": bool(config.get("wallpaper")),
        "has_flags": bool(config.get("flags")),
        "has_ua": bool(config.get("ua")),
        "has_multi_repo_urls": bool(config.get("urls")),
    }


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_INPUT
    if not src.is_absolute():
        src = ROOT / src
    seed = src.read_bytes()
    payload = find_payload(seed)
    text = payload.decode("utf-8")

    out = src.with_suffix(".jsonc")
    out.write_bytes(payload)

    report = {"seed_bytes": len(seed), "jsonc_bytes": len(payload), "jsonc_path": str(out)}
    try:
        parsed = json.loads(strip_line_comments(text))
        report["jsonc_parse"] = "ok (after stripping // comments)"
        report.update(summarize(parsed))
    except json.JSONDecodeError as exc:
        report["jsonc_parse"] = f"failed: {exc}"

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
