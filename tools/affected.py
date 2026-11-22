#!/usr/bin/env python
"""按改动半径挑测试：改了什么就跑什么，全量只在发版前跑一次。

用法：
    python tools/affected.py                # 只看工作区未提交改动，打印要跑的命令
    python tools/affected.py --since HEAD~1 # 看某个提交以来的改动
    python tools/affected.py --run          # 打印并真的执行
    python tools/affected.py --include-untracked   # 连未跟踪文件一起算（默认算）

为什么要有这个脚本：改一行日志级别就跑整套探针 + 全量单测，是拿几十分钟换一个
几乎没有信息量的结果。回归的粒度应该跟改动半径走：

    改一个 Rust 模块   ->  cargo test --lib <该模块>
    改一个前端文件     ->  只跑引用它的测试 + tsc
    改一支探针         ->  node --check + 只跑那一支
    改文档 / 注释      ->  什么都不用跑
    改动跨多个模块     ->  提示跑一次全量（此时全量才是合理的）

全量门禁（`python tools/check.py`）只需要在**发版前**跑一次；日常提交交给它推不动
的 CI 去跑，本地不重复。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def git(*args: str) -> list[str]:
    out = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8"
    )
    if out.returncode != 0:
        return []
    return [line.strip() for line in out.stdout.splitlines() if line.strip()]


def changed_files(since: str | None) -> list[str]:
    if since:
        files = git("diff", "--name-only", f"{since}...HEAD")
    else:
        files = git("diff", "--name-only", "HEAD")
        files += git("ls-files", "--others", "--exclude-standard")
    # 已删除的文件不参与测试选择（其影响已体现在别处）
    return [f for f in files if (ROOT / f).exists()]


def rust_filter(path: str) -> str | None:
    """`src-tauri/src/domain/live.rs` -> `live`；`.../spider/python.rs` -> `spider::python`。

    crate 根把 `domain` / `infra` 下的模块平铺导出，测试名里没有这层前缀
    （`cargo test --lib -- --list` 里是 `live::tests::…`），所以这里要剥掉。
    """
    rel = Path(path)
    parts = rel.with_suffix("").parts
    try:
        start = parts.index("src", parts.index("src-tauri") + 1)
    except ValueError:
        return None
    segs = [p for p in parts[start + 1 :] if p not in ("mod", "lib", "main")]
    if segs and segs[0] in ("domain", "infra"):
        segs = segs[1:]
    if not segs:
        return None
    return "::".join(segs)


def frontend_importers(source: str) -> list[str]:
    """找出 import 了这个模块的测试文件（相对路径或模块名都算）。"""
    stem = Path(source).with_suffix("").name
    hits = git("grep", "-l", "-e", f"/{stem}\"", "-e", f"/{stem}'", "--", "*.test.ts", "*.test.tsx")
    return hits


def diff_touches_more_than_version(path: str) -> bool:
    """`Cargo.toml` / `package.json` 的改动是「只动 version」还是「动了依赖」。"""
    out = subprocess.run(
        ["git", "diff", "HEAD", "--", path], cwd=ROOT, capture_output=True, text=True, encoding="utf-8"
    ).stdout
    interesting = [
        line
        for line in out.splitlines()
        if line.startswith(("+", "-"))
        and not line.startswith(("+++", "---"))
        and '"version"' not in line
        and "version =" not in line
        and line.strip() not in ("+", "-")
    ]
    return bool(interesting)


def plan(files: list[str]) -> tuple[list[list[str]], list[str]]:
    """返回 (要跑的命令列表, 说明列表)。"""
    commands: list[list[str]] = []
    notes: list[str] = []
    rust: set[str] = set()
    vitest: set[str] = set()
    probes: set[str] = set()
    offline: set[str] = set()
    need_tsc = False
    full_rust = False
    full_reasons: list[str] = []

    for path in files:
        if path == "package.json":
            commands.append([PY, "tools/version_check.py"])
            need_tsc = True
            if diff_touches_more_than_version(path):
                full_reasons.append(f"{path} 动了依赖，前端需要重装依赖后跑全量单测")
        elif path == "src-tauri/Cargo.toml":
            if diff_touches_more_than_version(path):
                full_rust = True
                full_reasons.append(f"{path} 动了依赖/特性，Rust 侧按全量跑")
        elif path.startswith("src-tauri/src/") and path.endswith(".rs"):
            filt = rust_filter(path)
            if filt:
                rust.add(filt)
            else:
                full_rust = True
                full_reasons.append(f"{path}（在 crate 根，影响面不可枚举）")
        elif path.startswith("src-tauri/"):
            # build.rs / tauri.conf.json 这类改的是整体构建
            if path.endswith((".json", ".rs")):
                full_rust = True
                full_reasons.append(f"{path}（构建配置，影响全部 Rust 单测）")
        elif path.startswith("sidecars/"):
            offline.add("tests/offline/adapter_isolation.py")
            if path.endswith(".py"):
                commands.append([PY, "-m", "py_compile", path])
        elif path.startswith("tests/offline/"):
            offline.add(path)
        elif path.startswith("tests/frontend/") and path.endswith(".ts"):
            vitest.add(path)
        elif path.startswith("tests/") and path.endswith(".py"):
            offline.add(path)
        elif path.startswith("src/") and path.endswith((".ts", ".tsx")):
            need_tsc = True
            sibling = Path(path).with_suffix("")
            for suffix in (".test.ts", ".test.tsx"):
                candidate = ROOT / f"{sibling}{suffix}"
                if candidate.exists():
                    vitest.add(str(candidate.relative_to(ROOT)).replace("\\", "/"))
            if path.endswith(".ts"):
                for hit in frontend_importers(path):
                    vitest.add(hit)
        elif path.startswith("tools/probes/") and path.endswith(".mjs"):
            probes.add(path)
        elif path.startswith("tools/") and path.endswith(".py"):
            commands.append([PY, "-m", "py_compile", path])
        elif path.endswith((".md", ".txt")) or path.startswith(".github/"):
            continue  # 文档与 CI 配置不需要本地回归
        elif path.startswith("contracts/"):
            offline.add("tests/offline/contract_check.py")
        else:
            notes.append(f"未识别的改动，按需人工判断：{path}")

    if full_rust:
        commands.append(["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib"])
    else:
        for filt in sorted(rust):
            commands.append(
                ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", filt]
            )
    if need_tsc:
        commands.append(["corepack", "pnpm", "exec", "tsc", "--noEmit"])
    if vitest:
        commands.append(
            ["corepack", "pnpm", "exec", "vitest", "run", *sorted(vitest), "--reporter=dot"]
        )
    for probe in sorted(probes):
        commands.append(["node", "--check", probe])
        commands.append(["node", probe])
    for check in sorted(offline):
        commands.append([PY, check])

    return commands, notes + full_reasons


def main() -> int:
    ap = argparse.ArgumentParser(description="按改动半径挑选回归测试")
    ap.add_argument("--since", help="比较基线（默认工作区 vs HEAD）")
    ap.add_argument("--run", action="store_true", help="真的执行，而不只是打印")
    ap.add_argument(
        "--full",
        action="store_true",
        help="直接跑完整门禁（等价于 python tools/check.py），用于发版前",
    )
    args = ap.parse_args()

    if args.full:
        command = [PY, "tools/check.py"]
        print("$ " + " ".join(command))
        return subprocess.run(command, cwd=ROOT).returncode

    files = changed_files(args.since)
    if not files:
        print("没有改动，不用跑任何回归。")
        return 0

    commands, notes = plan(files)
    print(f"改动 {len(files)} 个文件：")
    for path in files:
        print(f"  {path}")
    print()

    for note in notes:
        print(f"[注意] {note}")
    if notes:
        print()

    if not commands:
        print("这些改动不需要本地回归（文档 / CI 配置 / 注释）；上面标[注意]的请自行判断。")
        return 0

    print("计划执行：")
    for command in commands:
        print("  $ " + " ".join(command))
    if not args.run:
        print("\n（加上 --run 才会真的执行；发版前请改用 --full）")
        return 0

    failed = 0
    for command in commands:
        print(f"\n=== $ {' '.join(command)} ===")
        code = subprocess.run(command, cwd=ROOT).returncode
        if code != 0:
            failed += 1
            print(f"[FAIL] {code}")
    print(f"\n{'全部通过' if failed == 0 else f'{failed} 条命令失败'}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
