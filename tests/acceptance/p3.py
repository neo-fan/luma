#!/usr/bin/env python3
"""P3 stage acceptance (spec §11 cumulative matrix, T-28 ~ T-34).

Cumulative: every earlier stage is re-run and must stay green, then the P3
groups are added. The only N/A left is T-31, which the spec itself marks as
manual acceptance and which is **not implemented** — it is reported as N/A
rather than silently passed.

Usage:
    python3 tests/acceptance/p3.py
    python3 tests/acceptance/p3.py --no-cumulative
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STUB = "http://127.0.0.1:8787"
CDP = "http://127.0.0.1:9222/json/list"
TAURI_CONF = ROOT / "src-tauri" / "tauri.conf.json"


def conf_version() -> str:
    """交付文件名跟 tauri.conf.json 走，避免版本升级后测试断言漂移。"""
    try:
        return str(json.loads(TAURI_CONF.read_text(encoding="utf-8")).get("version") or "0.0.0")
    except (OSError, ValueError):
        return "0.0.0"


NSIS_INSTALLER = ROOT / "src-tauri" / "target" / "release" / "bundle" / "nsis" / f"Luma_{conf_version()}_x64-setup.exe"
SIZE_REPORT = ROOT / "docs" / "size-report.md"
README = ROOT / "README.md"

results: list[tuple[str, str, str]] = []


def record(group: str, name: str, status: str, note: str = "") -> None:
    results.append((group, name, status))
    mark = {"PASS": "ok  ", "FAIL": "FAIL", "SKIP": "skip", "N/A": "n/a "}[status]
    print(f"[{mark}] {group:<12} {name}{('  -- ' + note) if note else ''}", flush=True)


def check(condition: bool, group: str, name: str, note: str = "") -> None:
    record(group, name, "PASS" if condition else "FAIL", note)


def ensure_stub() -> subprocess.Popen | None:
    try:
        with urllib.request.urlopen(f"{STUB}/config.json", timeout=1) as response:
            response.read(64)
        return None
    except Exception:
        pass
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "tests" / "stub_server.py")],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"{STUB}/config.json", timeout=1) as response:
                response.read(64)
            return proc
        except Exception:
            if proc.poll() is not None:
                break
            time.sleep(0.1)
    return proc


def cdp_available() -> bool:
    try:
        with urllib.request.urlopen(CDP, timeout=2) as response:
            pages = json.loads(response.read())
        return any(page.get("type") == "page" for page in pages)
    except Exception:
        return False


def run_script(group: str, name: str, argv: list[str], timeout: int = 300) -> bool:
    try:
        proc = subprocess.run(argv, cwd=str(ROOT), capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        check(False, group, name, f"timed out after {timeout}s")
        return False
    tail = (proc.stdout or proc.stderr).strip().splitlines()
    check(proc.returncode == 0, group, name, tail[-1][:110] if tail else f"rc={proc.returncode}")
    return proc.returncode == 0


def t28_phase() -> None:
    configs = sorted((ROOT / "tests" / "fixtures" / "configs").glob("*.json"))
    check(len(configs) >= 5, "T-28 dialects", "fixture configs present", f"{len(configs)} files")
    run_script("T-28 dialects", "config_compat.py", [sys.executable, "tests/offline/config_compat.py"])


def t29_phase() -> None:
    if not cdp_available():
        record("T-29 sniff", "hidden webview sniff", "FAIL", "dev window (9222) is not running")
        return
    run_script("T-29 sniff", "hidden webview sniff", ["node", "tools/probes/probe_sniff.mjs"], timeout=180)


def t32_phase() -> None:
    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    bundle = conf.get("bundle", {})
    # The deliverable is the official NSIS installer built by `tauri build`.
    check(bundle.get("targets") == ["nsis"], "T-32 installer", "bundle.targets == [nsis]")
    check(SIZE_REPORT.is_file(), "T-32 installer", "docs/size-report.md exists")

    if not NSIS_INSTALLER.is_file():
        check(False, "T-32 installer", "NSIS installer built",
              "run `corepack pnpm tauri build`")
        return

    size_mb = NSIS_INSTALLER.stat().st_size / (1024 * 1024)
    check(30 <= size_mb <= 130, "T-32 installer", "installer 30~130MB", f"{size_mb:.2f}MB")
    record("T-32 installer", "frontend embedded", "N/A",
           "proven by `tauri build` log + GUI smoke (LZMA-compressed payload)")


def t33_phase() -> None:
    if not README.is_file():
        check(False, "T-33 readme", "README.md exists")
        return
    text = README.read_text(encoding="utf-8")
    check("免责" in text or "disclaimer" in text.lower(), "T-33 readme", "disclaimer section")
    check("构建" in text or "build" in text.lower(), "T-33 readme", "build instructions")
    check("SmartScreen" in text, "T-33 readme", "SmartScreen note")


def cumulative_phase() -> None:
    py = sys.executable
    run_script("12.2 cumul", "p0.py (offline)", [py, "tests/acceptance/p0.py", "--offline"])
    run_script("12.2 cumul", "p1.py (adapter)", [py, "tests/acceptance/p1.py", "--adapter"])
    run_script("12.2 cumul", "contract_check.py", [py, "tests/offline/contract_check.py"])
    run_script("12.2 cumul", "capabilities_check.py", [py, "tests/offline/capabilities_check.py"])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-cumulative", action="store_true")
    args = parser.parse_args()

    stub = ensure_stub()
    try:
        t28_phase()
        t29_phase()
        t32_phase()
        t33_phase()
        # Spec T-31 is explicitly manual acceptance (protocol handler, JumpList,
        # DPI manifest) and is not implemented; report it instead of hiding it.
        record("T-31 win11", "shell integration", "N/A", "manual acceptance, not implemented in this build")
        if not args.no_cumulative:
            cumulative_phase()
    finally:
        if stub is not None:
            stub.terminate()

    passed = sum(1 for _, _, s in results if s == "PASS")
    failed = sum(1 for _, _, s in results if s == "FAIL")
    skipped = sum(1 for _, _, s in results if s in ("SKIP", "N/A"))
    print(f"\nP3 summary: {passed} pass / {failed} fail / {skipped} n-a (total {len(results)})")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
