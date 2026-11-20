#!/usr/bin/env python3
"""One-shot offline regression gate (no window, no network).

Usage:
    python tools/check.py            # default gate
    python tools/check.py --full     # also run `pnpm build`
    python tools/check.py --quick    # skip cargo test (useful while iterating on TS)
    python tools/check.py --ci       # portable subset (CI job "checks")
    python tools/check.py --list     # show the checks and exit

Exit code is non-zero if any check fails. Every check is a subprocess so this
script itself only needs the standard library; it never imports third-party
packages and never writes into the source tree.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def interp() -> str:
    """Interpreter for the Python-side checks.

    Prefer the bundled `sidecars/python-embed` because that is what the adapter
    actually runs on: it ships requests / lxml / pyquery / pycryptodome. Falling
    back to the host interpreter silently changes behaviour — without `requests`
    the adapter uses its urllib fallback and `py_base_spider_check` starts doing
    real DNS lookups, which would crash the gate outright instead of just
    failing one check. Override with `LUMA_PYTHON` (same env var the Rust side uses).
    """
    override = os.environ.get("LUMA_PYTHON")
    if override and Path(override).is_file():
        return override
    for candidate in (
        ROOT / "sidecars" / "python-embed" / "python.exe",
        ROOT / "sidecars" / "python-embed" / "bin" / "python3",
    ):
        if candidate.is_file():
            return str(candidate)
    return sys.executable


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
    "for base in ('tools','sidecars/py','tests'):\n"
    "    for p in pathlib.Path(base).rglob('*.py'):\n"
    "        if '__pycache__' in p.parts: continue\n"
    "        try: compile(p.read_text(encoding='utf-8'),str(p),'exec')\n"
    "        except (SyntaxError,UnicodeDecodeError) as e: bad.append(str(p)+': '+str(e))\n"
    "print('syntax OK' if not bad else '\\n'.join(bad))\n"
    "sys.exit(1 if bad else 0)\n"
)


def checks(full: bool, quick: bool, ci: bool = False) -> list[tuple[str, list[str]]]:
    py = interp()
    items: list[tuple[str, list[str]]] = [
        ("contract (schema <-> TS)", [py, "tests/offline/contract_check.py"]),
        ("version consistency", [py, "tools/version_check.py"]),
    ]
    if not ci:
        items += [
            ("py compatibility", [py, "tests/offline/py_compat_check.py"]),
            ("py base spider", [py, "tests/offline/py_base_spider_check.py"]),
            ("adapter robustness", [py, "tests/offline/adapter_isolation.py"]),
            ("runtime artifacts", [py, "tools/prepare_runtime.py", "--check"]),
            ("qjs-runner unit tests", [CARGO, "test", "--manifest-path", "sidecars/qjs-runner/Cargo.toml"]),
            ("qjs engine", [py, "tests/offline/qjs_engine_check.py"]),
        ]
    items += [
        ("python syntax", [py, "-c", SYNTAX_SNIPPET]),
        ("frontend unit tests", pnpm() + ["test"]),
    ]
    if not quick and not ci:
        items.append(("rust unit tests", [CARGO, "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib"]))
    if full:
        items.append(("frontend build", pnpm() + ["build"]))
    return items


def main() -> int:
    ap = argparse.ArgumentParser(description="Luma offline regression gate")
    ap.add_argument("--full", action="store_true", help="also run pnpm build")
    ap.add_argument("--quick", action="store_true", help="skip cargo test")
    ap.add_argument(
        "--ci",
        action="store_true",
        help="portable subset for CI: contract + python syntax + frontend tests "
        "(skips py adapter checks that need pip deps, rust tests that need "
        "bundle.resources, and the local runtime artifacts probe)",
    )
    ap.add_argument("--list", action="store_true", help="list checks and exit")
    args = ap.parse_args()

    todo = checks(args.full, args.quick, args.ci)
    if args.list:
        for name, cmd in todo:
            print(f"{name:26s} {' '.join(cmd)}")
        return 0

    skipped = []
    if args.ci:
        skipped = [
            "py compatibility / py base spider (need pip deps, run in the py-adapter job)",
            "runtime artifacts (needs locally prepared python-embed)",
            "rust unit tests (tauri-build copies bundle.resources, needs stubs)",
        ]

    print(f"Luma offline check  ({len(todo)} checks, cwd={ROOT})")
    print(f"python interpreter   {interp()}")
    print("=" * 68)
    for line in skipped:
        print(f"[SKIP] {line}")
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
