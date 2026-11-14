#!/usr/bin/env python3
"""One-shot offline regression gate (no window, no network).

Usage:
    python tools/check.py            # default gate
    python tools/check.py --full     # also run `pnpm build`
    python tools/check.py --quick    # skip cargo test (useful while iterating on TS)
    python tools/check.py --list     # show the checks and exit

Exit code is non-zero if any check fails. Every check is a subprocess so this
script itself only needs the standard library; it never imports third-party
packages and never writes into the source tree.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable


def pnpm() -> list[str]:
    """Prefer corepack so the pinned pnpm version is used on Windows too."""
    corepack = shutil.which("corepack.cmd") or shutil.which("corepack")
    if corepack:
        return [corepack, "pnpm"]
    return [shutil.which("pnpm") or "pnpm"]


CARGO = shutil.which("cargo") or "cargo"

# Compile in memory: `compileall` would recreate the __pycache__ directories
# that the cleanup step just removed. No bytecode is written to the tree.
SYNTAX_SNIPPET = (
    "import pathlib,sys\n"
    "bad=[]\n"
    "for base in ('tools','sidecars/py','tests/e2e'):\n"
    "    for p in pathlib.Path(base).rglob('*.py'):\n"
    "        if '__pycache__' in p.parts: continue\n"
    "        try: compile(p.read_text(encoding='utf-8'),str(p),'exec')\n"
    "        except (SyntaxError,UnicodeDecodeError) as e: bad.append(str(p)+': '+str(e))\n"
    "print('syntax OK' if not bad else '\\n'.join(bad))\n"
    "sys.exit(1 if bad else 0)\n"
)


def checks(full: bool, quick: bool) -> list[tuple[str, list[str]]]:
    items: list[tuple[str, list[str]]] = [
        ("contract (schema <-> TS)", [PY, "tests/e2e/contract_check.py"]),
        ("py compatibility", [PY, "tests/e2e/py_compat_check.py"]),
        ("py base spider", [PY, "tests/e2e/py_base_spider_check.py"]),
        ("runtime artifacts", [PY, "tools/prepare_runtime.py", "--check"]),
        ("python syntax", [PY, "-c", SYNTAX_SNIPPET]),
        ("frontend unit tests", pnpm() + ["test"]),
    ]
    if not quick:
        items.append(("rust unit tests", [CARGO, "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib"]))
    if full:
        items.append(("frontend build", pnpm() + ["build"]))
    return items


def main() -> int:
    ap = argparse.ArgumentParser(description="Luma offline regression gate")
    ap.add_argument("--full", action="store_true", help="also run pnpm build")
    ap.add_argument("--quick", action="store_true", help="skip cargo test")
    ap.add_argument("--list", action="store_true", help="list checks and exit")
    args = ap.parse_args()

    todo = checks(args.full, args.quick)
    if args.list:
        for name, cmd in todo:
            print(f"{name:26s} {' '.join(cmd)}")
        return 0

    print(f"Luma offline check  ({len(todo)} checks, cwd={ROOT})")
    print("=" * 68)
    failures: list[str] = []
    for name, cmd in todo:
        started = time.monotonic()
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
        elapsed = time.monotonic() - started
        ok = proc.returncode == 0
        print(f"[{'PASS' if ok else 'FAIL'}] {name:26s} {elapsed:6.1f}s")
        if not ok:
            failures.append(name)
            tail = (proc.stdout or "") + (proc.stderr or "")
            for line in tail.strip().splitlines()[-12:]:
                print("        " + line)
    print("=" * 68)
    if failures:
        print(f"FAILED: {len(failures)} check(s): " + ", ".join(failures))
        return 1
    print(f"ALL GREEN: {len(todo)} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
