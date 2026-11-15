#!/usr/bin/env python3
"""版本一致性检查：单一来源 = `package.json`。

覆盖 `docs/RELEASING.md` §1 的同步清单，并真的拉起一次 Python 适配层，确认
`ping` 报的版本与 `package.json` 相同（无宿主注入时走「回退读 package.json」，
有 `LUMA_VERSION` 时应以注入值为准）。一次列出全部漂移点，失败即非零退出。

用法：`python tools/version_check.py`（`tools/check.py` 已包含）
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAURI_CONF = "src-tauri/tauri.conf.json"
MAIN_PY = "sidecars/py/main.py"
AGENTS = "AGENTS.md"


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def package_version() -> str:
    return str(json.loads(read("package.json"))["version"])


def cargo_toml_version() -> str | None:
    """`[package]` 段里第一个 `version = "..."`。"""
    for line in read("src-tauri/Cargo.toml").splitlines():
        match = re.match(r'^\s*version\s*=\s*"([^"]+)"', line)
        if match:
            return match.group(1)
    return None


def cargo_lock_version() -> str | None:
    """`Cargo.lock` 里 `name = "luma"` 那个 package 块的 version。"""
    text = read("src-tauri/Cargo.lock")
    for chunk in text.split("[[package]]"):
        if re.search(r'(?m)^name = "luma"\s*$', chunk):
            match = re.search(r'(?m)^version = "([^"]+)"\s*$', chunk)
            return match.group(1) if match else None
    return None


def adapter_version(override: str | None) -> tuple[str | None, str]:
    """拉起适配层打一帧 ping。返回 (版本, 失败说明)。"""
    env = os.environ.copy()
    env.pop("LUMA_VERSION", None)
    if override is not None:
        env["LUMA_VERSION"] = override
    frame = json.dumps({"id": 1, "method": "ping", "params": {}}) + "\n"
    try:
        proc = subprocess.run(
            [sys.executable, "sidecars/py/main.py"],
            input=frame,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
            cwd=str(ROOT),
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        return None, f"spawn failed: {err}"
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            reply = json.loads(line)
        except ValueError:
            continue
        result = reply.get("result")
        if isinstance(result, dict) and isinstance(result.get("version"), str):
            return result["version"], ""
    tail = (proc.stderr or "").strip().splitlines()[-1:] or ["<no stderr>"]
    return None, f"no ping frame (exit {proc.returncode}): {tail[0][:160]}"


def agents_version() -> str | None:
    match = re.search(r"(?m)^\|\s*版本\s*\|\s*`([^`]+)`", read(AGENTS))
    return match.group(1) if match else None


def main() -> int:
    expected = package_version()
    problems: list[str] = []

    def expect(label: str, actual: str | None) -> None:
        if actual != expected:
            problems.append(f"{label}: {actual!r}，应为 {expected!r}")

    expect("src-tauri/Cargo.toml", cargo_toml_version())
    expect("src-tauri/Cargo.lock [package luma]", cargo_lock_version())
    expect(f"{AGENTS} 的「版本」行", agents_version())

    # tauri.conf.json 不再写版本号，而是指回唯一来源；写死就是又回到多副本。
    conf = json.loads(read(TAURI_CONF))
    if conf.get("version") != "../package.json":
        problems.append(f"{TAURI_CONF}: version = {conf.get('version')!r}，应指向 '../package.json'")

    # 适配层：宿主注入优先，回退 package.json；不允许再出现字面量版本号。
    main_py = read(MAIN_PY)
    if not re.search(r"(?m)^VERSION\s*=\s*_read_version\(\)\s*$", main_py):
        problems.append(f"{MAIN_PY}: VERSION 应等于 _read_version()")
    if "LUMA_VERSION" not in main_py:
        problems.append(f"{MAIN_PY}: 未读取宿主注入的 LUMA_VERSION")
    literal = re.search(r'(?m)^VERSION\s*=\s*"\d', main_py)
    if literal:
        problems.append(f"{MAIN_PY}: VERSION 仍是字面量 {literal.group(0)!r}")

    fallback, fallback_err = adapter_version(None)
    expect("适配层 ping（无宿主注入）", fallback or fallback_err)
    injected, injected_err = adapter_version("0.0.1-version-check")
    if injected != "0.0.1-version-check":
        problems.append(f"适配层 ping（LUMA_VERSION 注入）: {injected or injected_err}，注入值未生效")

    if problems:
        print("VERSION DRIFT:")
        for item in problems:
            print(f"  - {item}")
        return 1

    print(f"VERSION OK: {expected}")
    print(f"  package.json        {expected}")
    print(f"  src-tauri/Cargo.toml {expected}")
    print(f"  src-tauri/Cargo.lock {expected}")
    print(f"  {TAURI_CONF}  ../package.json")
    print(f"  sidecars/py ping    {fallback}（注入覆盖生效）")
    print(f"  {AGENTS}            {expected}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
