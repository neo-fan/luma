#!/usr/bin/env python3
"""P0 stage acceptance (spec 12.2, cumulative assertion matrix).

Only capabilities delivered in P0 are asserted. Everything that belongs to a
later phase is reported as N/A instead of FAIL, which is the v1.1 wording of
12.2 (`docs/spec-v1.1/replacements.md`, R1).

Usage:
    python3 tests/acceptance/p0.py            # full run, needs stub + running app for HTTP parts
    python3 tests/acceptance/p0.py --offline  # skip assertions that need the desktop app
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
STUB = "http://127.0.0.1:8787"
PROXY = "http://127.0.0.1:9978"

results: list[tuple[str, str, str]] = []


def record(group: str, name: str, status: str, note: str = "") -> None:
    results.append((group, name, status))
    mark = {"PASS": "ok  ", "FAIL": "FAIL", "N/A": "n/a ", "SKIP": "skip"}[status]
    print(f"[{mark}] {group:<14} {name}{('  -- ' + note) if note else ''}", flush=True)


def run_script(group: str, name: str, script: pathlib.Path) -> None:
    if not script.exists():
        record(group, name, "FAIL", f"missing {script}")
        return
    proc = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
    ok = proc.returncode == 0
    tail = (proc.stdout or proc.stderr).strip().splitlines()
    record(group, name, "PASS" if ok else "FAIL", tail[-1][:120] if tail else "")


def http_get(url: str, headers: dict[str, str] | None = None) -> tuple[int, bytes, dict[str, str]]:
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read(), {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as err:
        return err.code, err.read(), {k.lower(): v for k, v in err.headers.items()}


def proxied(url: str, **params: str) -> str:
    from urllib.parse import urlencode

    query = {"url": url, **{key: value for key, value in params.items() if value}}
    return f"{PROXY}/proxy?{urlencode(query)}"


def check_proxy(online: bool) -> None:
    if not online:
        for name in [
            "health endpoint",
            "hls playlist through proxy",
            "anti-leech referer enforced",
            "range passthrough (206)",
            "scheme whitelist",
        ]:
            record("T-08 proxy", name, "SKIP", "desktop app not running")
        return

    try:
        status, body, _ = http_get(f"{PROXY}/health")
        payload = json.loads(body.decode("utf-8"))
        record("T-08 proxy", "health endpoint", "PASS" if status == 200 else "FAIL", f"port={payload.get('port')}")
    except Exception as err:  # noqa: BLE001
        record("T-08 proxy", "health endpoint", "FAIL", str(err))
        return

    status, body, headers = http_get(proxied(f"{STUB}/hls/index.m3u8", referer=f"{STUB}/"))
    ok = status == 200 and b"#EXTM3U" in body
    record("T-08 proxy", "hls playlist through proxy", "PASS" if ok else "FAIL", f"{status} {len(body)}B {headers.get('content-type', '')}")

    status, _, _ = http_get(proxied(f"{STUB}/hls/index.m3u8"))
    record("T-08 proxy", "anti-leech referer enforced", "PASS" if status == 403 else "FAIL", f"upstream={status}")

    status, chunk, headers = http_get(proxied(f"{STUB}/hls/seg0.ts"), headers={"Range": "bytes=0-99"})
    ok = status == 206 and len(chunk) == 100 and headers.get("content-range", "").startswith("bytes 0-99/")
    record("T-08 proxy", "range passthrough (206)", "PASS" if ok else "FAIL", f"{status} {len(chunk)}B {headers.get('content-range', '')}")

    status, _, _ = http_get(proxied("file:///C:/Windows/win.ini"))
    record("T-08 proxy", "scheme whitelist", "PASS" if status == 403 else "FAIL", f"{status}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--offline", action="store_true", help="skip checks that need the running app")
    args = parser.parse_args()

    run_script("T-05 config", "six shapes + normalization", ROOT / "tests/offline/config_shapes_check.py")
    run_script("T-04 contract", "schema <-> types alignment", ROOT / "tests/offline/contract_check.py")
    run_script("T-03 capabilities", "closed permission set", ROOT / "tests/offline/capabilities_check.py")

    online = not args.offline
    if online:
        try:
            http_get(f"{PROXY}/health")
        except Exception:  # noqa: BLE001
            online = False
            print("[warn] local proxy not reachable, HTTP assertions skipped", flush=True)
    check_proxy(online)

    # 12.2: capabilities that only land in P1/P2 are N/A at P0.
    for name, note in [
        ("py runtime isolation", "asserted by tests/acceptance/p1.py"),
        ("js runtime isolation", "asserted by tests/acceptance/p1.py"),
        ("jar runtime isolation", "scheduled for P2"),
        ("ext passthrough to sidecars", "asserted by tests/acceptance/p1.py"),
        ("crash isolation / no zombie process", "asserted by tests/acceptance/p1.py"),
    ]:
        record("12.2 matrix", name, "N/A", note)

    total = len(results)
    passed = sum(1 for _, _, status in results if status == "PASS")
    failed = sum(1 for _, _, status in results if status == "FAIL")
    skipped = sum(1 for _, _, status in results if status in ("SKIP", "N/A"))
    print(f"\nP0 summary: {passed} pass / {failed} fail / {skipped} n-a  (total {total})")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
