"""Durable, process-safe event log for the Python adapter.

TVBox spiders are third-party scripts. When one misbehaves we need a real
record of *what* happened — the spider class, the method, and the full
traceback — not just the short message the UI shows ("未响应源的原因"). Every
crash and every normalize failure is appended here as one JSON line. The Rust
host does not need to know about this file; it is purely a diagnostic aid the
user can open.

Resolution order for the log path (first writable wins):
  LUMA_ADAPTER_LOG  -> explicit override (Rust may set this)
  LUMA_DATA_DIR     -> <data>/logs/spider.log
  APPDATA           -> <APPDATA>/Luma/logs/spider.log   (Windows default)
  XDG_DATA_HOME     -> <xdg>/luma/logs/spider.log
  fallback          -> <sidecars/py>/logs/spider.log
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

_lock = threading.Lock()
_MAX_BYTES = 2_000_000  # rotate after ~2 MiB


def _resolve_log_path() -> Path:
    env = os.environ.get
    candidates: list[Path] = []
    if env("LUMA_ADAPTER_LOG"):
        candidates.append(Path(env("LUMA_ADAPTER_LOG")))
    if env("LUMA_DATA_DIR"):
        candidates.append(Path(env("LUMA_DATA_DIR")) / "logs" / "spider.log")
    if env("APPDATA"):
        candidates.append(Path(env("APPDATA")) / "Luma" / "logs" / "spider.log")
    if env("XDG_DATA_HOME"):
        candidates.append(Path(env("XDG_DATA_HOME")) / "luma" / "logs" / "spider.log")
    candidates.append(Path(__file__).resolve().parent / "logs" / "spider.log")
    for path in candidates:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            return path
        except Exception:  # noqa: BLE001 - try next candidate
            continue
    return candidates[-1]


def _rotate(path: Path) -> Path:
    try:
        if path.exists() and path.stat().st_size > _MAX_BYTES:
            backup = path.with_name(path.name + ".1")
            if backup.exists():
                backup.unlink()
            path.rename(backup)
    except Exception:  # noqa: BLE001 - rotation is best-effort
        pass
    return path


def log_event(event: dict) -> None:
    record = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "layer": "py-adapter", **event}
    line = json.dumps(record, ensure_ascii=False)
    with _lock:
        try:
            path = _rotate(_resolve_log_path())
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
            return
        except Exception:  # noqa: BLE001 - fall back to stderr
            pass
    try:
        print(line, file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001
        pass


def log_crash(
    *,
    stage: str,
    method: str,
    spider_class: str,
    fingerprint: str,
    source_api: str,
    message: str,
    trace: str,
) -> None:
    log_event(
        {
            "level": "ERROR",
            "kind": "spider_crash",
            "stage": stage,
            "method": method,
            "spiderClass": spider_class,
            "sourceFingerprint": fingerprint,
            "sourceApi": source_api,
            "message": message,
            "trace": trace,
        }
    )
