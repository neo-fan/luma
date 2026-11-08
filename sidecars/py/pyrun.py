#!/usr/bin/env python3
"""Child process that executes one py spider call (spec 7.2 `spider.py`).

Reads a single JSON payload on stdin, `exec`s the spider source, instantiates
`Spider(ext)` and calls one method. Only the final JSON result goes to stdout;
anything the spider prints is redirected to stderr so the protocol stays clean.
Exiting here is cheap — the caller can kill this process at any time.
"""

from __future__ import annotations

import json
import sys
import types
import traceback

SIGNATURES = {
    "homeContent": 1,
    "categoryContent": 4,
    "detailContent": 1,
    "searchContent": 3,
    "playerContent": 3,
    "liveContent": 1,
}


def to_args(method: str, raw: list) -> list:
    """Map our internal arg order to the TVBox spider signature."""
    if method == "homeContent":
        return [bool(raw[0]) if raw else False]
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
    raise ValueError(f"unsupported method: {method}")


def main() -> int:
    payload = json.load(sys.stdin)
    real_stdout = sys.stdout
    sys.stdout = sys.stderr  # protect the protocol stream

    try:
        source = str(payload.get("source") or "")
        if not source.strip():
            raise ValueError("empty spider source")

        module = types.ModuleType("tvbox_py_spider")
        module.__dict__["__name__"] = "tvbox_py_spider"
        exec(compile(source, "<spider>", "exec"), module.__dict__)  # noqa: S102

        class_name = str(payload.get("className") or "Spider")
        spider_cls = getattr(module, class_name, None)
        if spider_cls is None:
            raise ValueError(f"class {class_name} not found in source")

        instance = spider_cls(str(payload.get("ext") or ""))
        method = str(payload.get("method") or "")
        if method not in SIGNATURES:
            raise ValueError(f"unsupported method: {method}")

        args = to_args(method, payload.get("args") or [])
        result = getattr(instance, method)(*args)
        if result is None:
            result = {}
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
