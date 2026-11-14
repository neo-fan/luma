#!/usr/bin/env python3
"""T-05 verification: six configuration shapes parse end to end.

Starts tests/stub_server.py, pulls each endpoint, runs the decrypt chain and
normalization, and checks the merged multi-repo path. Also exercises the stdio
JSON-RPC adapter (ping + config.decrypt).

Usage:
    python3 tests/offline/config_shapes_check.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecars" / "py"))

from decrypt import decrypt  # noqa: E402
from normalize import merge_repos, normalize_config  # noqa: E402

BASE = "http://127.0.0.1:8787"
PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}  {detail}")


def fetch(path: str) -> str:
    with urllib.request.urlopen(BASE + path, timeout=5) as resp:
        return resp.read().decode("utf-8")


def wait_ready() -> None:
    for _ in range(50):
        try:
            fetch("/config.json")
            return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("stub server did not become ready")


def load(path: str) -> dict:
    plain, _method = decrypt(fetch(path))
    return normalize_config(json.loads(plain), BASE + path)


def run_shapes() -> None:
    standard = load("/config.json")
    check("standard sites == 6", len(standard["sites"]) == 6, str(len(standard["sites"])))
    runtimes = {s["runtime"] for s in standard["sites"]}
    check(
        "standard runtimes cover cms/python/quickjs/jvm",
        {"cms", "python", "quickjs", "jvm"} <= runtimes,
        str(runtimes),
    )
    probe = next(s for s in standard["sites"] if s["key"] == "stub_probe")
    check("unknown fields kept in _raw", probe["_raw"].get("customFlag") == "kept-in-raw")

    dialect = load("/config-dialect.json")
    check("dialect list alias -> sites", len(dialect["sites"]) == 6, str(len(dialect["sites"])))
    check("dialect parse alias -> parses", len(dialect["parses"]) == 1, str(len(dialect["parses"])))
    title_site = next(s for s in dialect["sites"] if s["key"] == "stub_probe")
    check("dialect title alias -> name", title_site["name"] == "Stub Probe", title_site["name"])

    b64 = load("/config-b64.txt")
    check("base64 config sites == 6", len(b64["sites"]) == 6, str(len(b64["sites"])))

    gz = load("/config-gzip.txt")
    check("gzip+base64 config sites == 6", len(gz["sites"]) == 6, str(len(gz["sites"])))

    enc = load("/config-encrypted.txt")
    check("encrypted shell config sites == 6", len(enc["sites"]) == 6, str(len(enc["sites"])))


def run_repos() -> None:
    repo = json.loads(fetch("/config-repos.json"))
    snapshots = []
    for entry in repo.get("urls", []):
        url = entry.get("url", "")
        path = url[len(BASE):] if url.startswith(BASE) else ""
        try:
            snapshots.append(load(path))
        except Exception:  # noqa: BLE001 - broken repo must not abort the merge
            continue
    merged = merge_repos(snapshots)
    check("multi-repo merge keeps 6 unique sites", len(merged["sites"]) == 6, str(len(merged["sites"])))
    check("broken repo ignored", len(snapshots) == 2, str(len(snapshots)))


def run_stdio() -> None:
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "sidecars" / "py" / "main.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert proc.stdin and proc.stdout
    raw = fetch("/config-b64.txt").strip()
    proc.stdin.write(json.dumps({"id": "u1", "method": "ping", "params": {}}) + "\n")
    proc.stdin.write(
        json.dumps({"id": "u2", "method": "config.decrypt", "params": {"raw": raw}}) + "\n"
    )
    proc.stdin.flush()
    first = json.loads(proc.stdout.readline())
    second = json.loads(proc.stdout.readline())
    proc.terminate()
    check("stdio ping ok", first.get("id") == "u1" and first.get("ok") is True)
    check(
        "stdio config.decrypt ok",
        second.get("id") == "u2" and second.get("ok") is True and "plain" in second.get("result", {}),
    )


def main() -> int:
    server = subprocess.Popen(
        [sys.executable, str(ROOT / "tests" / "stub_server.py")],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_ready()
        run_shapes()
        run_repos()
        run_stdio()
    finally:
        server.terminate()
        server.wait(timeout=5)

    print(f"\n{PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
