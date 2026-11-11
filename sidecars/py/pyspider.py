"""Run one py spider call in a killable child process (spec 7.2 `spider.py`).

The adapter owns the spider source (fetched by Rust) and forwards it to
`pyrun.py` together with the method and args. Results come back in TVBox shape
and are normalized here so the contract stays identical to the CMS path.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

import cms

try:
    from adapterlog import log_crash, log_event
except ImportError:  # diagnostics must never break a spider call
    def log_event(_event: dict) -> None:
        return None

    def log_crash(**_kwargs: object) -> None:
        return None

PYRUN = Path(__file__).resolve().parent / "pyrun.py"
DEFAULT_TIMEOUT_S = 15.0


def _fingerprint(source: str) -> str:
    return hashlib.sha1(source.encode("utf-8", "replace")).hexdigest()[:12]


def _normalize(
    method: str, result: Any, source_api: str = "", detail_id: str = ""
) -> Any:
    """Normalize a spider result into the contract shape.

    A malformed spider return (e.g. a bound method where a list was expected)
    degrades to a safe empty envelope instead of taking down the whole
    aggregated search. The failure is logged with the offending payload.
    An empty `detailContent` is *not* an error — the source simply has no such
    video — but it used to be completely invisible, so record it as INFO with
    the script URL. Without this, "未获取到影片详情" cannot be traced back to
    which site / id produced the empty result.
    """
    try:
        normalized = _normalize_inner(method, result)
    except Exception as exc:  # noqa: BLE001 - never let a bad shape crash the call
        log_crash(
            stage="normalize",
            method=method,
            spider_class="",
            fingerprint="",
            source_api=source_api,
            message=f"{exc}: {type(result).__name__}={_short(repr(result))}",
            trace=traceback.format_exc(limit=4),
        )
        if method == "detailContent":
            return []
        if method in ("playerContent", "liveContent", "proxy"):
            return {}
        return {"list": [], "page": 1, "pagecount": 1, "limit": 20, "total": 0, "classes": []}

    if method == "detailContent" and not normalized:
        log_event(
            {
                "level": "INFO",
                "kind": "empty_detail",
                "method": method,
                "sourceApi": source_api or "",
                "vodId": detail_id,
                "shape": type(result).__name__,
                "message": "detailContent returned no video",
            }
        )
    return normalized


def _short(text: str, n: int = 200) -> str:
    text = text.replace("\n", " ")
    return text if len(text) <= n else text[: n - 1] + "…"


_VOD_KEYS = ("vod_id", "vod_name", "vod_play_url", "vod_play_from", "vod_pic")


def _looks_like_vod(value: Any) -> bool:
    return isinstance(value, dict) and any(key in value for key in _VOD_KEYS)


def _detail_items(result: Any) -> list[dict]:
    """Accept every common TVBox py `detailContent` return shape.

    The standard is `{"list": [vod, ...]}` (or a bare list), but community
    spiders also return a single vod dict, `{"list": vod}`, or wrap the list in
    `data` / `result` / `vod`. Normalizing at this boundary is a general
    guarantee — it must not be a per-source patch.
    """
    if isinstance(result, (list, tuple)):
        return [item for item in result if isinstance(item, dict)]
    if not isinstance(result, dict):
        return []
    for key in ("list", "data", "result", "vod"):
        value = result.get(key)
        if isinstance(value, (list, tuple)):
            return [item for item in value if isinstance(item, dict)]
        if _looks_like_vod(value):
            return [value]
    if _looks_like_vod(result):
        return [result]
    return []


def _normalize_inner(method: str, result: Any) -> Any:
    if method == "detailContent":
        return [cms._vod(item) for item in _detail_items(result)]
    if method == "playerContent":
        return result if isinstance(result, dict) else {}
    if method == "liveContent":
        return result if isinstance(result, dict) else {}
    # Local proxy payload: {contentType, headers, body(base64)} — already safe.
    if method == "proxy":
        return result if isinstance(result, dict) else {}
    if isinstance(result, dict):
        return cms._page_from_json(result)
    return {"list": [], "page": 1, "pagecount": 1, "limit": 20, "total": 0, "classes": []}


def run(params: dict[str, Any]) -> Any:
    source = str(params.get("source") or "")
    if not source.strip():
        raise ValueError("spider.py requires a source text")

    method = str(params.get("method") or "")
    # Which config source this spider came from. Used only for diagnostics:
    # tracebacks show the real script URL and every log line can be traced back
    # to a site without guessing from a hash.
    api = str(params.get("api") or "")
    class_name = str(params.get("className") or "Spider")
    timeout_ms = params.get("timeoutMs")
    timeout = (
        float(timeout_ms) / 1000.0
        if isinstance(timeout_ms, (int, float)) and timeout_ms > 0
        else DEFAULT_TIMEOUT_S
    )

    payload = {
        "source": source,
        "className": class_name,
        "method": method,
        "args": params.get("args") or [],
        "ext": params.get("ext") or "",
        "api": api,
        "filename": api or "<spider>",
    }

    # The embeddable CPython uses a `._pth` file that ignores the script dir;
    # passing our adapter dir via PYTHONPATH makes pyrun's local imports
    # (`adapterlog`, `base.spider`, `cms`) resolvable regardless of cwd, dev vs
    # portable layout, or how the bridge spawned the parent process.
    env = os.environ.copy()
    here = str(Path(__file__).resolve().parent)
    existing = env.get("PYTHONPATH")
    env["PYTHONPATH"] = f"{here}{os.pathsep}{existing}" if existing else here

    try:
        completed = subprocess.run(
            [sys.executable, str(PYRUN)],
            input=json.dumps(payload).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
            env=env,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"py spider {method} exceeded {timeout:.1f}s") from exc

    stdout = completed.stdout.decode("utf-8", "replace").strip()
    if not stdout:
        stderr = completed.stderr.decode("utf-8", "replace").strip()
        tail = stderr.splitlines()[-1] if stderr else f"exit {completed.returncode}"
        log_crash(
            stage="spawn",
            method=method,
            spider_class=class_name,
            fingerprint=_fingerprint(source),
            source_api=api,
            message=f"py spider produced no frame: {tail}",
            trace=stderr[-2000:] or f"exit code {completed.returncode}",
        )
        raise RuntimeError(f"py spider produced no frame: {tail}")

    frame = json.loads(stdout.splitlines()[-1])
    if not frame.get("ok"):
        error = frame.get("error") or {}
        message = str(error.get("message") or "py spider failed")
        trace = str(frame.get("trace") or "")
        # pyrun already logged this crash inside the child; log again on the
        # adapter side so a child that vanished before writing still leaves a
        # record here (and so `api` / timeout context is captured).
        log_crash(
            stage="bridge",
            method=method,
            spider_class=class_name,
            fingerprint=_fingerprint(source),
            source_api=api,
            message=message,
            trace=trace,
        )
        raise RuntimeError(message)
    raw_args = params.get("args") or []
    detail_id = (
        str(raw_args[0])
        if method == "detailContent" and isinstance(raw_args, list) and raw_args
        else ""
    )
    return _normalize(method, frame.get("result"), api, detail_id)
