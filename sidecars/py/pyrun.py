#!/usr/bin/env python3
"""Child process that executes one py spider call (spec 7.2 `spider.py`).

Reads a single JSON payload on stdin, `exec`s the spider source, instantiates
`Spider(ext)` and calls one method. Only the final JSON result goes to stdout;
anything the spider prints is redirected to stderr so the protocol stays clean.
Exiting here is cheap — the caller can kill this process at any time.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import sys
import types
import traceback
from pathlib import Path

# The bundled CPython is an *embeddable* distribution: its `python311._pth`
# controls sys.path entirely and the script directory is NOT added when running
# `python.exe path/to/pyrun.py`. Insert our own dir BEFORE importing any local
# module. Importing `adapterlog` first (as an earlier revision did) made every
# spider child die with "ModuleNotFoundError: No module named 'adapterlog'",
# which surfaced as "py spider produced no frame" on every py site.
_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# Diagnostics are a best-effort facility. A missing/unsynced log module (e.g.
# a portable bundle built before it existed) must degrade to a no-op, never to
# a hard import failure that takes down the whole spider runtime.
try:
    from adapterlog import log_crash, log_event
except ImportError:  # noqa: BLE001 - logging must never break protocol
    def log_event(_event: dict) -> None:
        return None

    def log_crash(**_kwargs: object) -> None:
        return None

SIGNATURES = {
    "homeContent": 1,
    # TVBox standard: home recommendation list, no args (`def homeVideoContent(self)`).
    # Sources that keep homeContent strictly class-only (e.g. Douban) put all
    # their cards here; py/js runtimes call the same-named script method
    # (jar 站点在导入时即被屏蔽，不会派发到任何运行时).
    "homeVideoContent": 0,
    "categoryContent": 4,
    "detailContent": 1,
    "searchContent": 3,
    "playerContent": 3,
    "liveContent": 1,
    # TVBox local proxy: `Spider.proxy(Map) -> [contentType, headers, bytes]`.
    "proxy": 1,
}


def _fingerprint(source: str) -> str:
    """Stable short id for a spider source (used to correlate log lines)."""
    return hashlib.sha1(source.encode("utf-8", "replace")).hexdigest()[:12]


# TVBox host parity: the Java/Kotlin host calls spider methods reflectively and a
# source that does NOT implement one (e.g. a non-searchable site omitting
# `searchContent`) receives an empty envelope rather than a crash. Community py
# configs frequently ship `class Spider:` with no `base.spider.Spider` parent,
# so `getattr(instance, method)` would raise AttributeError. We mirror the host:
# missing method -> empty envelope, and we log it as an INFO capability gap.
DEFAULT_ENVELOPES = {
    "homeContent": {"class": [], "list": []},
    "homeVideoContent": {"list": []},
    "categoryContent": {"list": [], "page": 1, "pagecount": 0, "limit": 60, "total": 0},
    "detailContent": {"list": []},
    "searchContent": {"list": []},
    "playerContent": {"url": "", "header": "", "parse": 0, "playUrl": ""},
    "liveContent": {"list": []},
    "proxy": {"contentType": "application/octet-stream", "headers": {}, "body": ""},
}


def json_safe(value: object, path: str = "$", dropped: list | None = None, depth: int = 0):
    """Force any third-party spider return value into a JSON-serializable shape.

    TVBox spiders are untrusted community code: a source can return a bound
    method, a custom object, a non-string dict key or NaN. Those crash
    `json.dumps(frame)` ("Object of type method is not JSON serializable") so the
    child emits *no frame at all*, and the caller only sees a generic "py spider
    produced no frame". Sanitizing at the process boundary keeps the protocol
    frame intact; every replaced value is logged with its JSON path so the
    offending field can still be diagnosed (never silently swallowed).

    This is a general guarantee, not a per-source patch: it applies to every
    method (home/category/detail/search/player/live/proxy).
    """
    if dropped is None:
        dropped = []
    if depth > 8:
        dropped.append(f"{path}:max-depth")
        return None
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        # serde_json parses integers into i64/u64; anything larger would abort
        # the whole frame on the Rust side. IDs are strings in the contract.
        if value > 2**63 - 1 or value < -(2**63):
            dropped.append(f"{path}:int-overflow")
            return str(value)
        return value
    if isinstance(value, float):
        # Python's json.dumps emits NaN/Infinity, which serde_json rejects.
        if not math.isfinite(value):
            dropped.append(f"{path}:non-finite-float")
            return 0
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, dict):
        return {
            str(k): json_safe(v, f"{path}.{k}", dropped, depth + 1)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [
            json_safe(v, f"{path}[{i}]", dropped, depth + 1)
            for i, v in enumerate(value)
        ]
    # Callable (bound method / function), module, class, arbitrary object...
    dropped.append(f"{path}:{type(value).__name__}")
    return f"<{type(value).__name__}>"


def proxy_result(result: object) -> dict:
    """Turn `Spider.proxy()` output into a JSON-safe payload (body as base64).

    Sources return either `[contentType, headers, bytes]` or a dict with the
    same fields; a file-like object is read once. Bytes cannot cross the JSON
    frame, so the body is base64-encoded here and decoded by the Rust host.
    """
    content_type = "application/octet-stream"
    headers: dict[str, str] = {}
    body = b""
    if isinstance(result, (list, tuple)):
        if len(result) > 0 and isinstance(result[0], str):
            content_type = result[0] or content_type
        if len(result) > 1 and isinstance(result[1], dict):
            headers = {str(k): str(v) for k, v in result[1].items()}
        if len(result) > 2:
            data = result[2]
            if isinstance(data, (bytes, bytearray, memoryview)):
                body = bytes(data)
            elif isinstance(data, str):
                body = data.encode("utf-8")
            elif hasattr(data, "read"):
                body = data.read()
    elif isinstance(result, dict):
        content_type = str(result.get("contentType") or content_type)
        headers = {str(k): str(v) for k, v in (result.get("headers") or {}).items()}
        data = result.get("body") or b""
        if isinstance(data, (bytes, bytearray, memoryview)):
            body = bytes(data)
        elif isinstance(data, str):
            body = data.encode("utf-8")
    return {
        "contentType": content_type,
        "headers": headers,
        "body": base64.b64encode(body).decode("ascii"),
    }


def to_args(method: str, raw: list) -> list:
    """Map our internal arg order to the TVBox spider signature.

    A bare string payload must not be indexed character-by-character (`raw[0]`
    would become the first *character* of the vod id). Normalize once at the
    process boundary so every method sees a list, whatever the caller sent.
    """
    if not isinstance(raw, (list, tuple)):
        raw = [] if raw is None else [raw]
    raw = list(raw)
    if method == "homeContent":
        return [bool(raw[0]) if raw else False]
    if method == "homeVideoContent":
        # 无参方法：必须返回空列表。若照搬 homeContent 补 [False]，会变成
        # homeVideoContent(False)，对 def homeVideoContent(self) 直接 TypeError。
        return []
    if method == "categoryContent":
        tid = str(raw[0]) if len(raw) > 0 else ""
        pg = str(raw[1]) if len(raw) > 1 else "1"
        filt = bool(raw[2]) if len(raw) > 2 else False
        extend = raw[3] if len(raw) > 3 and isinstance(raw[3], dict) else {}
        return [tid, pg, filt, extend]
    if method == "searchContent":
        key = str(raw[0]) if raw else ""
        quick = bool(raw[1]) if len(raw) > 1 else False
        pg = str(raw[2]) if len(raw) > 2 else "1"
        return [key, quick, pg]
    if method == "detailContent":
        ids = raw[0] if raw else ""
        # TVBox passes `List<String>`; community scripts also accept a plain
        # string. Keep the list form (the standard) and never slice a string.
        if isinstance(ids, (list, tuple)):
            ids = list(ids)
        elif isinstance(ids, str):
            ids = [ids]
        else:
            ids = [str(ids)]
        return [ids]
    if method == "playerContent":
        flag = str(raw[0]) if len(raw) > 0 else ""
        pid = str(raw[1]) if len(raw) > 1 else ""
        vip = raw[2] if len(raw) > 2 else []
        return [flag, pid, vip]
    if method == "liveContent":
        return [str(raw[0]) if raw else ""]
    if method == "proxy":
        params = raw[0] if raw and isinstance(raw[0], dict) else {}
        return [{str(k): str(v) for k, v in params.items()}]
    raise ValueError(f"unsupported method: {method}")


def main() -> int:
    # Read bytes and let json detect UTF-8/16/32: text mode would decode with the
    # OS code page (cp936 on a Chinese Windows) and mangle non-ASCII names.
    raw = json.load(sys.stdin.buffer)
    payload = raw if isinstance(raw, dict) else {}
    # Initialized before the try block so the crash handler can always compute
    # a fingerprint / source api even when loading or compiling failed.
    source = ""
    real_stdout = sys.stdout
    sys.stdout = sys.stderr  # protect the protocol stream

    try:
        # Community sources are frequently saved with a UTF-8 BOM, which makes
        # `compile` fail with "invalid non-printable character".
        source = str(payload.get("source") or "").lstrip("\ufeff")
        if not source.strip():
            raise ValueError("empty spider source")

        module = types.ModuleType("luma_py_spider")
        module.__dict__["__name__"] = "luma_py_spider"
        filename = str(payload.get("filename") or "<spider>")
        exec(compile(source, filename, "exec"), module.__dict__)  # noqa: S102

        class_name = str(payload.get("className") or "Spider")
        spider_cls = getattr(module, class_name, None)
        if spider_cls is None:
            raise ValueError(f"class {class_name} not found in source")

        # Some configs override `__init__(self)` without accepting ext.
        try:
            instance = spider_cls(str(payload.get("ext") or ""))
        except TypeError:
            instance = spider_cls()
        method = str(payload.get("method") or "")
        if method not in SIGNATURES:
            raise ValueError(f"unsupported method: {method}")

        args = to_args(method, payload.get("args") or [])
        handler = getattr(instance, method, None)
        if handler is None:
            # TVBox host parity: a spider that does not implement a standard
            # method is treated as a non-browsable / non-searchable source and
            # returns an empty envelope instead of crashing. This is exactly how
            # fongmi/catvod handle a missing `searchContent` (e.g. juzong).
            log_event(
                {
                    "level": "INFO",
                    "kind": "missing_method",
                    "method": method,
                    "spiderClass": class_name,
                    "sourceFingerprint": _fingerprint(source),
                    "message": f"{class_name} does not implement {method}",
                }
            )
            result = dict(DEFAULT_ENVELOPES.get(method, {"list": []}))
        else:
            result = handler(*args)
        if result is None:
            result = {}
        if method == "proxy":
            result = proxy_result(result)
        # Boundary guarantee: never let a malformed third-party return value
        # break the JSON frame. Replaced fields are logged with their paths.
        dropped: list[str] = []
        result = json_safe(result, dropped=dropped)
        if dropped:
            log_event(
                {
                    "level": "WARN",
                    "kind": "unsafe_result",
                    "method": method,
                    "spiderClass": class_name,
                    "sourceFingerprint": _fingerprint(source),
                    "sourceApi": str(payload.get("api") or ""),
                    "paths": dropped[:20],
                    "droppedCount": len(dropped),
                    "message": "spider returned non-JSON values; sanitized",
                }
            )
        frame = {"ok": True, "result": result}
    except Exception as exc:  # noqa: BLE001 - process boundary
        tb = traceback.format_exc(limit=6)
        log_crash(
            stage="spider",
            method=str(payload.get("method") or ""),
            spider_class=str(payload.get("className") or "Spider"),
            fingerprint=_fingerprint(source),
            source_api=str(payload.get("api") or ""),
            message=f"{exc}",
            trace=tb,
        )
        frame = {
            "ok": False,
            "error": {"code": "SPIDER_CRASH", "message": f"{exc}"},
            "trace": tb,
        }
    finally:
        sys.stdout = real_stdout

    try:
        line = json.dumps(frame, ensure_ascii=False, allow_nan=False)
    except Exception as exc:  # noqa: BLE001 - last-resort protocol guard
        # Still emit a frame: a child that produces no stdout is reported as
        # "py spider produced no frame", which hides the real cause.
        log_crash(
            stage="serialize",
            method=str(payload.get("method") or ""),
            spider_class=str(payload.get("className") or "Spider"),
            fingerprint=_fingerprint(source),
            source_api=str(payload.get("api") or ""),
            message=f"frame not serializable: {exc}",
            trace=traceback.format_exc(limit=4),
        )
        frame = {
            "ok": False,
            "error": {"code": "SPIDER_CRASH", "message": f"result not serializable: {exc}"},
        }
        line = json.dumps(frame, ensure_ascii=False)
    # Write UTF-8 bytes directly: text mode would encode with the OS code page.
    sys.stdout.buffer.write((line + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()
    return 0 if frame.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
