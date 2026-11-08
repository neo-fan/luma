#!/usr/bin/env python3
"""Assert the main window capability set is minimal (T-03, spec 11.1).

Static half of T-03: parses `src-tauri/capabilities/default.json` and fails if
the main window is granted anything beyond the v1.1 whitelist, or if dangerous
shell/process permissions are present.

Runtime half (calling an unauthorised plugin command and expecting a denial) is
covered by `tools/probe_capabilities.mjs` against WebView2's CDP endpoint.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CAP = ROOT / "src-tauri" / "capabilities" / "default.json"

REQUIRED = {"core:default", "core:window:allow-set-title", "shell:allow-open"}
FORBIDDEN_EXACT = {
    "shell:allow-spawn",
    "shell:allow-execute",
    "shell:allow-kill",
    "shell:allow-stdin-write",
    "core:process:allow-exit",
}


def main() -> int:
    data = json.loads(CAP.read_text(encoding="utf-8"))
    problems: list[str] = []

    if data.get("windows") != ["main"]:
        problems.append(f"windows must be ['main'], got {data.get('windows')!r}")

    perms = data.get("permissions") or []
    if not isinstance(perms, list) or not all(isinstance(p, str) for p in perms):
        problems.append("permissions must be a flat string array (no objects)")
        perms = []

    perm_set = set(perms)
    for missing in sorted(REQUIRED - perm_set):
        problems.append(f"missing required permission: {missing}")
    for extra in sorted(perm_set - REQUIRED):
        problems.append(f"unexpected permission (whitelist is closed): {extra}")
    for forbidden in sorted(FORBIDDEN_EXACT & perm_set):
        problems.append(f"forbidden permission present: {forbidden}")
    if any("*" in p for p in perms):
        problems.append("wildcard permission is not allowed")

    if problems:
        print("CAPABILITIES FAIL")
        for item in problems:
            print("  -", item)
        return 1

    print(f"CAPABILITIES OK: {len(perm_set)} permissions, main window only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
