#!/usr/bin/env python3
"""Python adapter layer: stdio JSON-RPC (spec 7.2 / 7.2.1).

One JSON frame per line on stdin/stdout. stdout carries protocol frames only;
logs go to stderr. Spider requests run on a thread pool of 8; Python spiders
(`spider.py`) are dispatched to a short-lived child process by `pyspider.run`,
so a broken third-party script cannot take down this bridge.

`config.*` (and `ping`) get a **separate** lane. A spider call can hold a worker
for its whole child timeout, and the host's per-call wall clock is the same
15 s, so keeping imports in the same FIFO queue made "the worker was busy"
indistinguishable from "decrypting took 15 s" — see the 1.0.1 import timeout.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from decrypt import DecryptError, decrypt  # noqa: E402
from normalize import merge_repos, normalize_config  # noqa: E402

try:
    from adapterlog import log_event as _log_event
except ImportError:  # diagnostics must never break the bridge
    def _log_event(_event: dict) -> None:
        return None

def force_utf8_stdio() -> None:
    """stdin/stdout 固定 UTF-8：Windows 默认按 ANSI 代码页解码。

    中文 Windows（cp936）上，宿主送来的 UTF-8 帧被按 GBK 解码，中文站名处
    字节错位，`json.loads` 在 ~8 KiB 处报 `Expecting property name`。1.0.1 表现为
    15 s 超时（坏帧被静默丢弃），1.0.2 表现为 `malformed frame`。宿主也会注入
    `PYTHONUTF8` / `PYTHONIOENCODING`；这里兜底，兼容用户自带的解释器，并让
    `pyspider` 派生的子进程继承同样的编码。
    """
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:  # 被替换成 StringIO 之类，无需处理
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass
    # 子进程（`pyspider` → `pyrun.py`）继承同样的编码，否则中文站名会在子进程里
    # 用系统代码页解码而乱码。
    os.environ["PYTHONUTF8"] = "1"
    os.environ["PYTHONIOENCODING"] = "utf-8"


force_utf8_stdio()

def _read_version() -> str:
    """版本号只有一处：仓库根 `package.json`。

    宿主拉起适配层时注入 `LUMA_VERSION`（`infra/bridge.rs`，值取 cargo 包版本，
    构建期由 `build.rs` 断言与 `package.json` 一致）；离线直接跑适配层（离线测试、
    审计工具）没有宿主注入，回退读 `package.json`，最后才用 `0.0.0`。不要再抄一份
    字面量版本号，`tools/version_check.py` 会盯着这里。
    """
    injected = os.environ.get("LUMA_VERSION", "").strip()
    if injected:
        return injected
    here = Path(__file__).resolve()
    for base in (here.parents[2], here.parent):
        try:
            payload = json.loads((base / "package.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        version = payload.get("version")
        if isinstance(version, str) and version.strip():
            return version.strip()
    return "0.0.0"


VERSION = _read_version()
_write_lock = threading.Lock()
_cancel_lock = threading.Lock()
_cancelled: set[str] = set()
# 爬虫车道：一次调用能占住 worker 到子进程结束（最长 15s）。
_spider_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="spider")
# 导入车道：永不排在爬虫后面，导入/体检的耗时才是真实耗时。
_config_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="config")
# 超过这个耗时就记一条 adapter_latency，慢调用不必再靠猜。
SLOW_CALL_MS = 3000
# 帧解析失败时用来抢救 request id：有 id 才能回一帧，否则宿主只能干等。
_ID_HINT = re.compile(r'"id"\s*:\s*(\d{1,20})')


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


def lane_for(method: str) -> ThreadPoolExecutor:
    """`config.*` / `ping` 走导入车道，其余（`spider.py` / `site.route` / `live.*` / `parse.resolve`）走爬虫车道。"""
    if method == "ping" or method.startswith("config."):
        return _config_executor
    return _spider_executor


def note_latency(method: str, started: float, params: dict, failed: bool) -> None:
    """`config.*` 每次记耗时/字节数；其它方法只在慢到可疑时记一条。

    1.0.1 那次「导入失败：config.decrypt exceeded 15000ms」查不动，就是因为适
    配层对耗时零记录：宿主只能看到「我放弃了」，看不到「它排了多久队」。
    """
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    if not method.startswith("config.") and elapsed_ms < SLOW_CALL_MS:
        return
    raw = params.get("raw")
    _log_event(
        {
            "level": "WARN" if elapsed_ms >= SLOW_CALL_MS else "INFO",
            "kind": "adapter_latency",
            "method": method,
            "elapsedMs": elapsed_ms,
            "bytes": len(raw) if isinstance(raw, str) else 0,
            "failed": failed,
        }
    )


def reply_bad_frame(line: str, reason: str) -> None:
    """帧解析失败也要回一帧（能从残帧里捞出 id 时）。

    静默 `continue` 会让宿主等满自己的墙钟预算（15s）才报「config.decrypt
    exceeded 15000ms」，把「帧坏了」伪装成「调用很慢」，现场无从复盘。
    """
    hint = _ID_HINT.search(line[:4096])
    if hint is None:
        log(f"bad frame without id, dropped: {reason}")
        return
    _log_event(
        {"level": "WARN", "kind": "bad_frame", "message": reason, "bytes": len(line)}
    )
    write_frame(
        {
            "id": int(hint.group(1)),
            "ok": False,
            "error": {"code": "INTERNAL", "message": f"malformed frame: {reason}"},
        }
    )


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
    """Fault injection used by tests/acceptance/p1.py; gated behind an env flag."""
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
    started = time.perf_counter()
    try:
        result = dispatch(method, params)
    except Exception as exc:  # noqa: BLE001 - protocol boundary
        note_latency(method, started, params, failed=True)
        write_frame(
            {
                "id": request_id,
                "ok": False,
                "error": {"code": error_code(exc), "message": str(exc)},
            }
        )
        return
    note_latency(method, started, params, failed=False)
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
            reply_bad_frame(line, str(exc))
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

        lane_for(method).submit(run_request, request_id, method, params)

    _spider_executor.shutdown(wait=False)
    _config_executor.shutdown(wait=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
