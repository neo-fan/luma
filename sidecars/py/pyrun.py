#!/usr/bin/env python3
"""Child process that executes one py spider call (spec 7.2 `spider.py`).

Reads a single JSON payload on stdin, `exec`s the spider source, instantiates
`Spider(ext)` and calls one method. Only the final JSON result goes to stdout;
anything the spider prints is redirected to stderr so the protocol stays clean.
Exiting here is cheap — the caller can kill this process at any time.
"""

from __future__ import annotations

import base64
import json
import sys
import types
import traceback
from pathlib import Path

# `base.spider` ships inside this directory (vendored framework), and spiders
# also do `sys.path.append('..')`; keeping our own dir first wins either way.
_HERE = str(Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

SIGNATURES = {
    "homeContent": 1,
    # TVBox standard: home recommendation list, no args (`def homeVideoContent(self)`).
    # Sources that keep homeContent strictly class-only (e.g. Douban) put all
    # their cards here; py/jvm/js runtimes call the same-named script method.
    "homeVideoContent": 0,
    "categoryContent": 4,
    "detailContent": 1,
    "searchContent": 3,
    "playerContent": 3,
    "liveContent": 1,
    # TVBox local proxy: `Spider.proxy(Map) -> [contentType, headers, bytes]`.
    "proxy": 1,
}


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
    """Map our internal arg order to the TVBox spider signature."""
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
        if isinstance(ids, str):
            ids = [ids]
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
    payload = json.load(sys.stdin)
    real_stdout = sys.stdout
    sys.stdout = sys.stderr  # protect the protocol stream

    try:
        # Community sources are frequently saved with a UTF-8 BOM, which makes
        # `compile` fail with "invalid non-printable character".
        source = str(payload.get("source") or "").lstrip("\ufeff")
        if not source.strip():
            raise ValueError("empty spider source")

        module = types.ModuleType("tvbox_py_spider")
        module.__dict__["__name__"] = "tvbox_py_spider"
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
        result = getattr(instance, method)(*args)
        if result is None:
            result = {}
        if method == "proxy":
            result = proxy_result(result)
        frame = {"ok": True, "result": result}
    except Exception as exc:  # noqa: BLE001 - process boundary
        frame = {
            "ok": False,
            "error": {"code": "SPIDER_CRASH", "message": f"{exc}"},
            "trace": traceback.format_exc(limit=3),
        }
    finally:
        sys.stdout = real_stdout

    sys.stdout.write(json.dumps(frame, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    return 0 if frame.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
