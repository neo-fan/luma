"""Run py spider calls against persistent, in-process Spider instances.

Historically each `spider.py` frame spawned a short-lived `pyrun.py` child so a
broken script could not take down the bridge. That model has two costs:

* every call paid Python interpreter startup + third-party imports + recompile
  of the spider source + `new Spider(ext)` — the dominant latency for py sources;
* it cannot host **stateful** spiders. TVBox `live_mode=proxy` sources (e.g.
  yangshipin / 央视频) keep a rolling `seq → real-URL` window in the instance
  (their `getCache/setCache` are fail-stubs, nothing on disk), so the playlist
  call and the later segment calls MUST hit the same live object. A fresh child
  per call made every segment answer "切片已过期" — structurally unplayable.

So the bridge now keeps one live instance per `(source fingerprint, className,
ext)` and dispatches every method against it, matching FongMi's persistent
singleton. Trade-offs, all deliberate:

* **thread-safety** — a shared instance is serialized by a per-entry lock (calls
  to the same source queue; different sources still run on the pool's 8 threads).
* **crash/hang isolation** — an in-process hard crash or an un-killable hang can
  wedge a thread; the host's wall-clock timeout bounds the caller, and module
  *loading* is done outside the global pool lock so a bad spider's top-level
  hang cannot freeze other sources. Note: an un-killable hang *inside a handler*
  still occupies one pool worker until the host times out (Python cannot kill a
  thread); `__cancel__` is checked at request boundaries, not mid-handler. A
  truly wedged worker needs a sidecar restart, which is a host-level concern.
* **memory** — entries are evicted after `IDLE_TTL_S` and capped at `MAX_ENTRIES`.

`run(params)` keeps the exact old contract (returns the JSON-safe result, raises
on failure) so `main.py` is unchanged.
"""

from __future__ import annotations

import threading
import time
import traceback
from typing import Any

try:
    from adapterlog import log_crash, log_event
except ImportError:  # diagnostics must never break a spider call
    def log_crash(**_kwargs: object) -> None:
        return None

    def log_event(_event: dict) -> None:
        return None

# Reuse the exact per-method contract pyrun established (arg shapes, JSON
# sanitizing, proxy envelope, missing-method empty envelopes) so the in-process
# path and the old child path agree frame-for-frame.
from pyrun import (  # noqa: E402
    DEFAULT_ENVELOPES,
    SIGNATURES,
    _fingerprint,
    json_safe,
    proxy_result,
    to_args,
)

IDLE_TTL_S = 600.0  # drop a warm instance untouched for 10 minutes
MAX_ENTRIES = 32  # hard cap on simultaneously warm spiders (LRU-evicted)


class _Entry:
    __slots__ = ("instance", "lock", "last_used")

    def __init__(self, instance: Any) -> None:
        self.instance = instance
        self.lock = threading.Lock()
        self.last_used = time.monotonic()


_pool: dict[tuple[str, str, str], _Entry] = {}
_pool_lock = threading.Lock()


def _build_instance(source: str, class_name: str, ext: str, api: str) -> Any:
    """Compile+exec the spider source once and instantiate it.

    Mirrors `pyrun.main()`'s load path so a source behaves identically here."""
    import types

    module = types.ModuleType("luma_py_spider")
    module.__dict__["__name__"] = "luma_py_spider"
    exec(compile(source, api or "<spider>", "exec"), module.__dict__)  # noqa: S102
    spider_cls = getattr(module, class_name, None)
    if spider_cls is None:
        raise ValueError(f"class {class_name} not found in source")
    try:
        return spider_cls(ext)
    except TypeError:
        # Some configs override `__init__(self)` without accepting ext.
        return spider_cls()


def _get_entry(key: tuple[str, str, str], source: str, class_name: str, ext: str, api: str) -> _Entry:
    # Double-checked locking: exec(compile(source)) runs the spider module top
    # level, which may do slow/blocking work. Building it while holding the
    # global pool lock froze EVERY source (incl. ping) on one bad module. Build
    # outside the lock; re-check under the lock so concurrent misses don't all
    # insert (a rare duplicate build is harmless — each instance has its own lock).
    entry = _pool.get(key)
    if entry is not None:
        entry.last_used = time.monotonic()
        return entry
    fresh = _Entry(_build_instance(source, class_name, ext, api))
    with _pool_lock:
        entry = _pool.get(key)
        if entry is None:
            _evict_locked()
            _pool[key] = fresh
            entry = fresh
        entry.last_used = time.monotonic()
        return entry


def _evict_locked() -> None:
    """Drop idle entries; if still over cap, drop the least-recently-used."""
    now = time.monotonic()
    stale = [k for k, e in _pool.items() if now - e.last_used > IDLE_TTL_S]
    for k in stale:
        _pool.pop(k, None)
    if len(_pool) < MAX_ENTRIES:
        return
    # LRU: evict oldest until under cap (leave room for the one being inserted).
    ordered = sorted(_pool.items(), key=lambda kv: kv[1].last_used)
    for k, _ in ordered[: len(_pool) - MAX_ENTRIES + 1]:
        _pool.pop(k, None)


def run(params: dict[str, Any]) -> Any:
    source = str(params.get("source") or "")
    if not source.strip():
        raise ValueError("spider.py requires a source text")

    method = str(params.get("method") or "")
    api = str(params.get("api") or "")
    class_name = str(params.get("className") or "Spider")
    ext = str(params.get("ext") or "")

    if method not in SIGNATURES:
        raise ValueError(f"unsupported method: {method}")

    key = (_fingerprint(source), class_name, ext)
    started = time.perf_counter()
    try:
        entry = _get_entry(key, source, class_name, ext, api)
    except Exception as exc:  # noqa: BLE001 - load/compile failure is a call failure
        log_crash(
            stage="load",
            method=method,
            spider_class=class_name,
            fingerprint=key[0],
            source_api=api,
            message=f"py spider load failed: {exc}",
            trace=traceback.format_exc(limit=6),
        )
        raise

    # Serialize calls to this one instance (shared mutable state), but keep the
    # GIL-free network wait inside the handler off the pool lock.
    with entry.lock:
        entry.last_used = time.monotonic()
        args = to_args(method, params.get("args") or [])
        handler = getattr(entry.instance, method, None)
        if handler is None:
            # TVBox host parity: a missing method is an empty envelope, not a crash.
            result = dict(DEFAULT_ENVELOPES.get(method, {"list": []}))
        else:
            result = handler(*args)
        if result is None:
            result = {}
        if method == "proxy":
            result = proxy_result(result)
        # Boundary guarantee: never let a malformed third-party return break the
        # frame. Replaced fields are logged with their JSON paths (same contract
        # the old child process kept).
        dropped: list[str] = []
        result = json_safe(result, dropped=dropped)
        if dropped:
            log_event(
                {
                    "level": "WARN",
                    "kind": "unsafe_result",
                    "method": method,
                    "spiderClass": class_name,
                    "sourceFingerprint": key[0],
                    "sourceApi": api,
                    "paths": dropped[:20],
                    "droppedCount": len(dropped),
                    "message": "spider returned non-JSON values; sanitized",
                }
            )

    if (time.perf_counter() - started) > 15.0:
        # Slow, not crashed: the call returned. Recorded as a warn so it never
        # lands in the crash ledger, and logged without touching the result.
        log_event(
            {
                "level": "WARN",
                "kind": "slow_call",
                "method": method,
                "spiderClass": class_name,
                "sourceFingerprint": key[0],
                "sourceApi": api,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
                "message": "py spider call exceeded 15s (thread kept; host may cancel)",
            }
        )
    return result
