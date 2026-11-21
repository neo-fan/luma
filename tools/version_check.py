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
BETA_CONF = "src-tauri/tauri.beta.conf.json"
DEV_CONF = "src-tauri/tauri.dev.conf.json"
MAIN_PY = "sidecars/py/main.py"
AGENTS = "AGENTS.md"

# 通道 overlay 是入库的可审计副本；identifier 由 package.json 的 appId 派生。
CHANNEL_SUFFIXES = {"stable": "", "beta": ".beta", "dev": ".dev"}
CHANNEL_CONFS = {TAURI_CONF: "stable", BETA_CONF: "beta", DEV_CONF: "dev"}


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def package_app_id() -> str:
    """`package.json` 的 `appId` 是 identifier 前缀；缺失时按包名派生（同 build.rs）。"""
    pkg = json.loads(read("package.json"))
    return str(pkg.get("appId") or f"app.{pkg.get('name', 'luma')}")


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


def cargo_bin_names() -> list[str]:
    """Cargo.toml 里所有 `[[bin]]` 的 name。

    dev 与安装版各用一个 bin（`Luma_dev` / `luma`），overlay 的 mainBinaryName
    必须落在这个集合里；只校验"第一个 bin"会把双 bin 布局误判成漂移。
    """
    names: list[str] = []
    in_bin = False
    for line in read("src-tauri/Cargo.toml").splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_bin = stripped == "[[bin]]"
            continue
        if in_bin:
            match = re.match(r'^name\s*=\s*"([^"]+)"', stripped)
            if match:
                names.append(match.group(1))
    return names


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

    # 通道身份：identifier 统一由 package.json 的 appId + 通道后缀派生；
    # 三份 overlay 是提交入库的副本，必须与派生值一致，否则会覆盖另一个通道的安装。
    try:
        base_id = package_app_id()
    except (OSError, KeyError, ValueError) as err:
        problems.append(f"package.json: 无法读取 appId（{err}）")
        base_id = None
    if base_id:
        if not re.fullmatch(r"[A-Za-z0-9.-]+", base_id):
            problems.append(f"package.json: appId {base_id!r} 含非法字符")
        for rel, name in CHANNEL_CONFS.items():
            try:
                channel_conf = json.loads(read(rel))
            except (OSError, ValueError) as err:
                problems.append(f"{rel}: 无法解析（{err}）")
                continue
            expected_id = base_id + CHANNEL_SUFFIXES[name]
            actual_id = channel_conf.get("identifier")
            if actual_id != expected_id:
                problems.append(
                    f"{rel}: identifier = {actual_id!r}，应为 {expected_id!r}"
                    f"（appId + {CHANNEL_SUFFIXES[name]!r}）"
                )
            if channel_conf.get("version") not in (None, "../package.json"):
                problems.append(f"{rel}: version 应省略或指向 '../package.json'，避免第二份版本号")
        try:
            beta_name = json.loads(read(BETA_CONF)).get("productName")
            stable_name = conf.get("productName", "Luma")
            if not beta_name or beta_name == stable_name:
                problems.append(
                    f"{BETA_CONF}: productName 应区别于 stable（{stable_name!r}），"
                    "否则开始菜单与安装目录同名"
                )
        except (OSError, ValueError) as err:
            problems.append(f"{BETA_CONF}: 无法解析（{err}）")
        try:
            dev_conf = json.loads(read(DEV_CONF))
            stable_product = str(conf.get("productName", "Luma"))
            dev_product = dev_conf.get("productName")
            if not dev_product or dev_product == stable_product:
                problems.append(
                    f"{DEV_CONF}: productName 应区别于 stable（{stable_product!r}），"
                    "否则任务管理器里的描述与正式版相同"
                )
            dev_bin = dev_conf.get("mainBinaryName")
            bins = cargo_bin_names()
            # 大小写不敏感：crate 名只能小写（luma），安装版显示名按 productName 写成 Luma。
            bins_lower = [name.lower() for name in bins]
            if not dev_bin or dev_bin.lower() not in bins_lower:
                problems.append(
                    f"{DEV_CONF}: mainBinaryName = {dev_bin!r}，"
                    f"应等于 Cargo.toml 的某个 [[bin]] name（现有 {bins!r}，大小写不敏感）"
                )
            elif dev_bin.lower() == stable_product.lower():
                problems.append(
                    f"{DEV_CONF}: mainBinaryName {dev_bin!r} 与安装版 exe 同名，"
                    "无法按进程名区分 dev 与正式版"
                )
            # stable 打包用的主 bin 也必须存在，否则 bundler 会把 dev 名装进包。
            stable_bin = conf.get("mainBinaryName") or (bins[0] if bins else None)
            if bins and (not stable_bin or stable_bin.lower() not in bins_lower):
                problems.append(
                    f"tauri.conf.json: mainBinaryName = {stable_bin!r}，"
                    f"不在 Cargo.toml 的 [[bin]]（{bins!r}）里"
                )
        except (OSError, ValueError) as err:
            problems.append(f"{DEV_CONF}: 无法解析（{err}）")

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
    if base_id:
        derived = " / ".join(
            f"{name} {base_id}{suffix}" for name, suffix in CHANNEL_SUFFIXES.items()
        )
        print(f"  通道 overlay        {derived}")
    print(f"  sidecars/py ping    {fallback}（注入覆盖生效）")
    print(f"  {AGENTS}            {expected}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
