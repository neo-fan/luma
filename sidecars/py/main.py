#!/usr/bin/env python3
"""Python adapter layer: stdio JSON-RPC, one job only — run third-party scripts.

Protocol surface (see `docs/spec.md` §5):

* `ping` — health/version probe;
* `spider.py` — execute a Python source script in a child process;
* `debug.*` — fault injection for acceptance tests, gated behind
  `LUMA_ADAPTER_DEBUG=1`.

Everything else that used to live here (config decrypt/normalize/mergeRepos,
site routing, m3u/XMLTV parsing, parse resolution, CMS field mapping) is now
plain Rust in the host process. Keeping a second implementation in the sidecar
meant two places to fix for one contract — the 1.0.1 "import timeout" bug was a
symptom of the old design.

One JSON frame per line on stdin/stdout. stdout carries protocol frames only and
is written solely through `write_raw`; at startup `sys.stdout` is replaced by a
forwarder to stderr so a spider's stray `print` cannot interleave with (or split)
a frame. Logs go to stderr. Requests run on a thread pool of 8; `spider.py` dispatches
against a persistent, in-process Spider instance cached per source fingerprint
(`pyspider.run`), so stateful spiders (live_mode=proxy rolling windows) survive
across calls and there is no per-call interpreter/import cost. A hard crash or
un-killable hang inside a spider is bounded by the host's wall-clock timeout and
the bridge's dead-connection respawn.
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

# 协议通道：帧只走这里，且只有 `write_raw` 会碰它。
# 第三方 spider 里一句 `print(...)`（TVBox 生态里非常普遍）或某个库的 stdout
# 输出，会直接插进 JSON 帧中间：宿主侧表现为 `sidecar emitted a non-json frame`，
# 运气差时一帧被劈成两半，整次调用白等墙钟预算。与其逐站点要求「不要 print」，
# 不如在进程边界上不让它写出去 —— 启动后 `sys.stdout` 一律改投 stderr。
PROTOCOL_OUT = sys.stdout


class _StderrStdout:
    """`sys.stdout` 的替身：所有写操作落到 stderr。"""

    encoding = "utf-8"
    errors = "replace"

    def __init__(self, sink) -> None:
        self._sink = sink

    def write(self, text):
        return self._sink.write(text)

    def writelines(self, lines):
        return self._sink.writelines(lines)

    def flush(self):
        self._sink.flush()

    def isatty(self):
        return False

    def fileno(self):
        return self._sink.fileno()

    def close(self):
        # 不能真关掉 stderr：后面的诊断日志还要用。
        return None


sys.stdout = _StderrStdout(sys.stderr)


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
# 单个车道：一次调用能占住 worker 到子进程结束（最长 15s），但这里已经不再托管
# 配置导入之类的短调用 —— 那些在宿主进程内同步做完，不会和爬虫抢队列。
_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="spider")
# 超过这个耗时就记一条 adapter_latency，慢调用不必再靠猜。
SLOW_CALL_MS = 3000
# 帧解析失败时用来抢救 request id：有 id 才能回一帧，否则宿主只能干等。
_ID_HINT = re.compile(r'"id"\s*:\s*(\d{1,20})')


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def write_raw(text: str) -> None:
    """协议通道的唯一写入口（帧与故意的垃圾帧都走这里）。"""
    with _write_lock:
        PROTOCOL_OUT.write(text)
        PROTOCOL_OUT.flush()


def write_frame(frame: dict) -> None:
    write_raw(json.dumps(frame, ensure_ascii=False) + "\n")


def is_cancelled(request_id: object) -> bool:
    with _cancel_lock:
        return str(request_id) in _cancelled


def note_latency(method: str, started: float, params: dict, failed: bool) -> None:
    """慢调用记一条 `adapter_latency`（方法、耗时、入参字节数）。

    这条日志是 1.0.1 那次「导入超时」复盘时补的：宿主只能看到「我放弃了」，
    适配层自己不说话就没人知道它排了多久队。现在只剩脚本执行，慢调用同样值得记。
    """
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    if elapsed_ms < SLOW_CALL_MS:
        return
    raw = params.get("source") or params.get("raw")
    _log_event(
        {
            "level": "WARN",
            "kind": "adapter_latency",
            "method": method,
            "elapsedMs": elapsed_ms,
            "bytes": len(raw) if isinstance(raw, str) else 0,
            "failed": failed,
        }
    )


def reply_bad_frame(line: str, reason: str) -> None:
    """帧解析失败也要回一帧（能从残帧里捞出 id 时）。

    静默 `continue` 会让宿主等满自己的墙钟预算（15s）才报超时，把「帧坏了」
    伪装成「调用很慢」，现场无从复盘。
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

    if method == "spider.py":
        from pyspider import run as run_py_spider

        return run_py_spider(params)

    if method.startswith("debug."):
        if os.environ.get("LUMA_ADAPTER_DEBUG") != "1":
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
        write_raw("this is not json\n")
        return {"junk": True}

    if method == "debug.crash":
        os._exit(int(params.get("code") or 3))

    raise ValueError(f"unknown method: {method}")


def error_code(exc: Exception) -> str:
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

        _executor.submit(run_request, request_id, method, params)

    _executor.shutdown(wait=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(serve())
