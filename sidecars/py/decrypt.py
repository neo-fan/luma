"""Configuration decrypt chain (spec 8.1).

Order: trim -> image seed (`<image>**<base64>`) -> plain JSON -> `****` shell ->
digit-prefixed shell -> base64 -> gzip+base64. Every stage validates with
json.loads; a failing stage falls through to the next one, never raising until
all stages fail. JSONC (comments + trailing commas) is normalized to strict JSON
before validation, because the host parses with serde_json.
"""

from __future__ import annotations

import base64
import gzip
import json
import re

KEY = b"tvbox-stub-key"
DIGIT_PREFIX = re.compile(r"^\d+\*\*")


class DecryptError(Exception):
    pass


def _xor(data: bytes, key: bytes) -> bytes:
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


def strip_jsonc(text: str) -> str:
    """Remove // and /* */ comments and trailing commas without touching strings."""
    out: list[str] = []
    index = 0
    length = len(text)
    in_string = False
    while index < length:
        char = text[index]
        nxt = text[index + 1] if index + 1 < length else ""
        if in_string:
            out.append(char)
            if char == "\\":
                if nxt:
                    out.append(nxt)
                    index += 2
                    continue
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            out.append(char)
            index += 1
            continue
        if char == "/" and nxt == "/":
            newline = text.find("\n", index)
            index = length if newline < 0 else newline
            continue
        if char == "/" and nxt == "*":
            end = text.find("*/", index + 2)
            index = length if end < 0 else end + 2
            continue
        out.append(char)
        index += 1

    cleaned = "".join(out)
    # Drop trailing commas before } or ].
    return re.sub(r",(\s*[}\]])", r"\1", cleaned)


def _try_json(text: str) -> dict | None:
    for candidate in (text, strip_jsonc(text)):
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _image_seed(text: str) -> str | None:
    """`<jpeg bytes>**<base64 jsonc>` seeds served with an image content-type."""
    marker = text.find("**")
    if marker <= 0 or marker > 8192:
        return None
    prefix = text[:marker]
    # A text config would be printable ASCII before the marker; an image is not.
    if prefix.isprintable() and prefix.isascii():
        return None
    cleaned = re.sub(r"[^A-Za-z0-9+/=]", "", text[marker + 2 :])
    if len(cleaned) < 8:
        return None
    data = _decode_b64(cleaned)
    if data is None:
        return None
    for candidate in (data, _maybe_gunzip(data) or b""):
        if not candidate:
            continue
        try:
            plain = candidate.decode("utf-8")
        except UnicodeDecodeError:
            continue
        stripped = strip_jsonc(plain)
        if _try_json(stripped) is not None:
            return stripped
    return None


def _decode_b64(text: str) -> bytes | None:
    cleaned = re.sub(r"\s+", "", text)
    try:
        return base64.b64decode(cleaned, validate=False)
    except (ValueError, TypeError):
        return None


def _maybe_gunzip(data: bytes) -> bytes | None:
    if data[:2] != b"\x1f\x8b":
        return None
    try:
        return gzip.decompress(data)
    except OSError:
        return None


def decrypt(raw: str) -> tuple[str, str]:
    """Return (plain_json_text, method). Raises DecryptError when every stage fails."""
    text = raw.lstrip("\ufeff").strip()
    if not text:
        raise DecryptError("empty payload")

    seeded = _image_seed(text)
    if seeded is not None:
        return seeded, "image-seed"

    if _try_json(text) is not None:
        return strip_jsonc(text), "plain"

    if text.startswith("****"):
        data = _decode_b64(text[4:])
        if data is not None:
            plain = _xor(data, KEY).decode("utf-8", errors="strict")
            if _try_json(plain) is not None:
                return strip_jsonc(plain), "xor-base64"

    match = DIGIT_PREFIX.match(text)
    if match:
        data = _decode_b64(text[match.end():])
        if data is not None:
            inflated = _maybe_gunzip(data) or data
            plain = inflated.decode("utf-8", errors="strict")
            if _try_json(plain) is not None:
                return strip_jsonc(plain), "digit-gzip"

    data = _decode_b64(text)
    if data is not None:
        inflated = _maybe_gunzip(data)
        if inflated is not None:
            plain = inflated.decode("utf-8", errors="strict")
            if _try_json(plain) is not None:
                return strip_jsonc(plain), "gzip+base64"
        try:
            plain = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            plain = ""
        if plain and _try_json(plain) is not None:
            return strip_jsonc(plain), "base64"

    raise DecryptError("all decrypt stages failed")
