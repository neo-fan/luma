"""Configuration decrypt chain (spec 8.1).

Order: trim -> plain JSON -> `****` shell -> digit-prefixed shell -> base64 ->
gzip+base64. Every stage validates with json.loads; a failing stage falls
through to the next one, never raising until all stages fail.
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


def _try_json(text: str) -> dict | None:
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


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

    if _try_json(text) is not None:
        return text, "plain"

    if text.startswith("****"):
        data = _decode_b64(text[4:])
        if data is not None:
            plain = _xor(data, KEY).decode("utf-8", errors="strict")
            if _try_json(plain) is not None:
                return plain, "xor-base64"

    match = DIGIT_PREFIX.match(text)
    if match:
        data = _decode_b64(text[match.end():])
        if data is not None:
            inflated = _maybe_gunzip(data) or data
            plain = inflated.decode("utf-8", errors="strict")
            if _try_json(plain) is not None:
                return plain, "digit-gzip"

    data = _decode_b64(text)
    if data is not None:
        inflated = _maybe_gunzip(data)
        if inflated is not None:
            plain = inflated.decode("utf-8", errors="strict")
            if _try_json(plain) is not None:
                return plain, "gzip+base64"
        try:
            plain = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            plain = ""
        if plain and _try_json(plain) is not None:
            return plain, "base64"

    raise DecryptError("all decrypt stages failed")
