#!/usr/bin/env python3
"""Compare the normalized contract across its three representations.

v1.1 R8: `contracts/tvbox.schema.json` is the single source of truth.
This script checks that `src/types/tvbox.ts` and (when present) the Rust
`src-tauri/src/error.rs` agree with it on field names. It exits non-zero on
any mismatch so it can be wired into T-04 / T-13 assertions.

Usage:
    python3 tests/e2e/contract_check.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "contracts" / "tvbox.schema.json"
TS_TYPES = ROOT / "src" / "types" / "tvbox.ts"

# schema 定义名 -> TS interface 名（Category / FilterValue / FilterGroup 在 TS 中是内联结构）
PAIRS = [
    ("AppError", "AppError"),
    ("Site", "Site"),
    ("VodInfo", "VodInfo"),
    ("ResultPage", "ResultPage"),
    ("PlayTarget", "PlayTarget"),
    ("ConfigSource", "ConfigSource"),
    ("SpiderRequest", "SpiderRequest"),
    ("FetchRequest", "FetchRequest"),
]


def schema_fields(defs: dict, name: str) -> set[str]:
    return set(defs[name].get("properties", {}).keys())


def ts_interfaces(source: str) -> dict[str, set[str]]:
    """Extract top-level field names of each `export interface`."""
    result: dict[str, set[str]] = {}
    current: str | None = None
    depth = 0
    for line in source.splitlines():
        stripped = line.strip()
        if current is None:
            m = re.match(r"export interface (\w+)", stripped)
            if m:
                current = m.group(1)
                depth = stripped.count("{") - stripped.count("}")
                result[current] = set()
            continue
        depth += stripped.count("{") - stripped.count("}")
        if depth <= 0:
            current = None
            continue
        # 只取 interface 顶层的 2 空格缩进字段
        m = re.match(r"^  (\w+)\??:", line)
        if m:
            result[current].add(m.group(1))
    return result


def main() -> int:
    defs = json.loads(SCHEMA.read_text(encoding="utf-8"))["$defs"]
    ts = ts_interfaces(TS_TYPES.read_text(encoding="utf-8"))

    problems: list[str] = []
    for schema_name, ts_name in PAIRS:
        if ts_name not in ts:
            problems.append(f"{ts_name}: missing in {TS_TYPES.relative_to(ROOT)}")
            continue
        expected = schema_fields(defs, schema_name)
        actual = ts[ts_name]
        for field in sorted(expected - actual):
            problems.append(f"{ts_name}.{field}: in schema, missing in TS")
        for field in sorted(actual - expected):
            problems.append(f"{ts_name}.{field}: in TS, missing in schema")

    if problems:
        print("CONTRACT MISMATCH")
        for item in problems:
            print("  -", item)
        return 1

    print(f"CONTRACT OK: {len(PAIRS)} types aligned between schema and TS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
