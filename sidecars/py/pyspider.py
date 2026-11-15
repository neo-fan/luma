"""Run one py spider call in a killable child process (spec 7.2 `spider.py`).

The adapter owns the spider source (fetched by Rust) and forwards it to
`pyrun.py` together with the method and args. The result is returned exactly as
`pyrun.py` produced it (already JSON-safe): normalizing it into the contract
shape is framework work and lives in Rust (`domain/spider/cms_parse.rs`), so the
adapter stays a pure script executor.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    from adapterlog import log_crash
except ImportError:  # diagnostics must never break a spider call
    def log_crash(**_kwargs: object) -> None:
        return None

PYRUN = Path(__file__).resolve().parent / "pyrun.py"
DEFAULT_TIMEOUT_S = 15.0


def _fingerprint(source: str) -> str:
    return hashlib.sha1(source.encode("utf-8", "replace")).hexdigest()[:12]


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
    # (`adapterlog`, `base.spider`) resolvable regardless of cwd, dev vs
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
    return frame.get("result")
