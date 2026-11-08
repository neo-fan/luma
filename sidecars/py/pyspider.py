"""Run one py spider call in a killable child process (spec 7.2 `spider.py`).

The adapter owns the spider source (fetched by Rust) and forwards it to
`pyrun.py` together with the method and args. Results come back in TVBox shape
and are normalized here so the contract stays identical to the CMS path.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import cms

PYRUN = Path(__file__).resolve().parent / "pyrun.py"
DEFAULT_TIMEOUT_S = 15.0


def _normalize(method: str, result: Any) -> Any:
    if method == "detailContent":
        if isinstance(result, dict) and isinstance(result.get("list"), list):
            return [cms._vod(item) for item in result["list"] if isinstance(item, dict)]
        if isinstance(result, list):
            return [cms._vod(item) for item in result if isinstance(item, dict)]
        return []
    if method == "playerContent":
        return result if isinstance(result, dict) else {}
    if method == "liveContent":
        return result if isinstance(result, dict) else {}
    if isinstance(result, dict):
        return cms._page_from_json(result)
    return {"list": [], "page": 1, "pagecount": 1, "limit": 20, "total": 0, "classes": []}


def run(params: dict[str, Any]) -> Any:
    source = str(params.get("source") or "")
    if not source.strip():
        raise ValueError("spider.py requires a source text")

    method = str(params.get("method") or "")
    timeout_ms = params.get("timeoutMs")
    timeout = (
        float(timeout_ms) / 1000.0
        if isinstance(timeout_ms, (int, float)) and timeout_ms > 0
        else DEFAULT_TIMEOUT_S
    )

    payload = {
        "source": source,
        "className": params.get("className") or "Spider",
        "method": method,
        "args": params.get("args") or [],
        "ext": params.get("ext") or "",
    }

    try:
        completed = subprocess.run(
            [sys.executable, str(PYRUN)],
            input=json.dumps(payload).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError(f"py spider {method} exceeded {timeout:.1f}s") from exc

    stdout = completed.stdout.decode("utf-8", "replace").strip()
    if not stdout:
        stderr = completed.stderr.decode("utf-8", "replace").strip().splitlines()
        tail = stderr[-1] if stderr else f"exit {completed.returncode}"
        raise RuntimeError(f"py spider produced no frame: {tail}")

    frame = json.loads(stdout.splitlines()[-1])
    if not frame.get("ok"):
        error = frame.get("error") or {}
        raise RuntimeError(str(error.get("message") or "py spider failed"))
    return _normalize(method, frame.get("result"))
