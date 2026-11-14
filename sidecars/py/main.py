#!/usr/bin/env python3
"""Python adapter layer: stdio JSON-RPC (spec 7.2 / 7.2.1).

One JSON frame per line on stdin/stdout. stdout carries protocol frames only;
logs go to stderr. Requests run on a thread pool of 8. Python spiders
(`spider.py`) are dispatched to a short-lived child process by `pyspider.run`,
so a broken third-party script cannot take down this bridge.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from decrypt import DecryptError, decrypt  # noqa: E402
from normalize import merge_repos, normalize_config  # noqa: E402

VERSION = "1.0.1"
_write_lock = threading.Lock()
_cancel_lock = threading.Lock()
_cancelled: set[str] = set()
_executor = ThreadPoolExecutor(max_workers=8)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def write_frame(frame: dict) -> None:
    line = json.dumps(frame, ensure_ascii=False)
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def is_cancelled(request_id: object) -> bool:
    with _cancel_lock:
        return str(request_id) in _cancelled


def dispatch(method: str, params: dict) -> dict:
    if method == "ping":
        return {"ok": True, "version": VERSION}

    if method == "config.decrypt":
        plain, how = decrypt(str(params.get("raw") or ""))
        return {"plain": plain, "method": how}

    if method == "config.normalize":
        raw = params.get("raw")
        origin = str(params.get("origin") or "")
        if isinstance(raw, str):
            raw_obj = json.loads(raw)
        elif isinstance(raw, dict):
            raw_obj = raw
        else:
            raise ValueError("raw must be a JSON string or object")
        return normalize_config(raw_obj, origin)

    if method == "config.mergeRepos":
        snapshots = params.get("snapshots") or []
        if not isinstance(snapshots, list):
            raise ValueError("snapshots must be an array")
        return merge_repos([s for s in snapshots if isinstance(s, dict)])

    if method.startswith("site.parse"):
        from cms import parse_category, parse_detail, parse_home, parse_search

        handlers = {
            "site.parseHome": parse_home,
            "site.parseCategory": parse_category,
            "site.parseDetail": parse_detail,
            "site.parseSearch": parse_search,
        }
        handler = handlers.get(method)
        if handler is None:
            raise ValueError(f"unknown method: {method}")
        return handler(params)

    if method == "site.route":
        from normalize import route as route_site

        site = params.get("site")
        if not isinstance(site, dict):
            raise ValueError("site must be an object")
        runtime = route_site(site, params.get("globalSpider"))
        return {"runtime": runtime, "reason": "8.3 priority order"}

    if method == "live.parseM3u":
        from live import parse_m3u

        raw = params.get("raw")
        if not isinstance(raw, str):
            raise ValueError("raw must be a string")
        return parse_m3u(raw, str(params.get("url") or ""))

    if method == "live.parseEpg":
        from live import parse_epg

        raw = params.get("raw")
        if not isinstance(raw, str):
            raise ValueError("raw must be a string")
        channel = str(params.get("channel") or "")
        date = params.get("date")
        return parse_epg(raw, channel, str(date) if date else None)

    if method == "parse.resolve":
        from parse import resolve

        url = str(params.get("url") or "")
        if not url:
            raise ValueError("url is required")
        rule = params.get("rule") if isinstance(params.get("rule"), dict) else {}
        headers = params.get("headers") if isinstance(params.get("headers"), dict) else {}
        return resolve(url, rule, headers)

    if method == "spider.py":
        from pyspider import run as run_py_spider

        return run_py_spider(params)

    if method.startswith("debug."):
        if (os.environ.get("LUMA_ADAPTER_DEBUG") or os.environ.get("TVBOX_ADAPTER_DEBUG")) != "1":
            raise ValueError(f"unknown method: {method}")
        return debug_handler(method, params)

    raise ValueError(f"unknown method: {method}")


def debug_handler(method: str, params: dict) -> dict:
    """Fault injection used by tests/e2e/p1.py; gated behind an env flag."""
    if method == "debug.echo":
        delay = float(params.get("delayMs") or 0) / 1000.0
        if delay > 0:
            time.sleep(delay)
        return {"value": params.get("value"), "pid": os.getpid()}

    if method == "debug.junk":
        # Write a deliberately malformed frame before the real one; the Rust
        # reader must ignore it instead of breaking the connection.
        sys.stdout.write("this is not json\n")
        sys.stdout.flush()
        return {"junk": True}

    if method == "debug.crash":
        os._exit(int(params.get("code") or 3))

    raise ValueError(f"unknown method: {method}")


def error_code(exc: Exception) -> str:
    if isinstance(exc, DecryptError):
        return "CONFIG_DECRYPT_FAIL"
    if isinstance(exc, json.JSONDecodeError):
        return "DIALECT_UNKNOWN"
    return "INTERNAL"


def run_request(request_id: object, method: str, params: dict) -> None:
    if is_cancelled(request_id):
        log(f"skip cancelled request {request_id}")
        return
    try:
        result = dispatch(method, params)
    except Exception as exc:  # noqa: BLE001 - protocol boundary
        write_frame(
            {
                "id": request_id,
                "ok": False,
                "error": {"code": error_code(exc), "message": str(exc)},
            }
        )
        return
    if is_cancelled(request_id):
        log(f"drop late result for cancelled request {request_id}")
        return
    write_frame({"id": request_id, "ok": True, "result": result})


def serve() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            log(f"bad frame: {exc}")
            continue

        request_id = request.get("id")
        method = str(request.get("method") or "")
        params = request.get("params") or {}
        if not isinstance(params, dict):
            params = {}

        if method == "__cancel__":
            target = params.get("targetId")
            with _cancel_lock:
                _cancelled.add(str(target))
            write_frame({"id": request_id, "ok": True, "result": {"cancelled": target}})
            continue

        _executor.submit(run_request, request_id, method, params)

    _executor.shutdown(wait=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
