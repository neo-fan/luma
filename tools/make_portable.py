#!/usr/bin/env python3
"""Assemble the portable (unzip-and-run) build.

The user does not want an installer: the deliverable is a folder/zip that runs
in place. Layout produced:

    Luma/
      Luma.exe                   release binary (frontend embedded)
      sidecars/py/               Python adapter sources
      sidecars/python-embed/     embedded CPython + third-party packages
      sidecars/jre/              jlink-trimmed JDK 17
      sidecars/java/runner.jar   JVM spider bridge
      sidecars/mpv/              optional, only with --with-mpv
      data/                      portable data dir (luma.db + legacy json backup)
      使用说明.txt

`store.rs::data_dir` already prefers `<exe>/data`, and the sidecar resolvers
prefer `<resource_dir>/sidecars` — for a non-installed build Tauri reports the
exe directory as the resource dir, so no extra wiring is needed.

Usage:
    python tools/make_portable.py
    python tools/make_portable.py --with-mpv
    python tools/make_portable.py --skip-build
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE_EXE = ROOT / "src-tauri" / "target" / "release" / "luma.exe"
# [package] name 现在就是 luma，cargo 直接产出 luma.exe，无需再改交付文件名。
APP_NAME = "Luma"
OUT_DIR = ROOT / "release" / "portable"
APP_DIR = OUT_DIR / APP_NAME
CONF = ROOT / "src-tauri" / "tauri.conf.json"


def conf_version() -> str:
    """交付文件名跟 tauri.conf.json 走；版本只有那一个来源。"""
    try:
        data = json.loads(CONF.read_text(encoding="utf-8"))
        return str(data.get("version") or "0.0.0")
    except (OSError, ValueError):
        return "0.0.0"


# 延迟到函数定义之后再拼 zip 名，避免版本号再写死一次。
ZIP_PATH = ROOT / "release" / f"{APP_NAME}-{conf_version()}-portable.zip"

# Build-time-only Python bits: safe to omit from the portable copy.
PY_SKIP_NAMES = {"scripts", "__pycache__", "pip", "setuptools", "wheel", "_distutils_hack"}
PY_SKIP_PREFIXES = ("pip-", "setuptools-", "wheel-")


def log(message: str) -> None:
    print(message, flush=True)


def human(num: int) -> str:
    return f"{num / 1024 / 1024:.2f} MB"


def tree_size(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def ignore_python(_dir: str, names: list[str]) -> set[str]:
    skipped: set[str] = set()
    for name in names:
        lowered = name.lower()
        if lowered in PY_SKIP_NAMES or lowered.startswith(PY_SKIP_PREFIXES):
            skipped.add(name)
    return skipped


def ignore_generic(_dir: str, names: list[str]) -> set[str]:
    return {name for name in names if name.lower() in {"__pycache__", ".pytest_cache"}}


def build_release() -> None:
    log("== cargo build --release ==")
    proc = subprocess.run(
        ["cargo", "build", "--release", "--manifest-path", str(ROOT / "src-tauri" / "Cargo.toml")],
        cwd=str(ROOT),
    )
    if proc.returncode != 0:
        raise SystemExit("cargo build failed; run it from the documented MSVC shell first")


def prepare_app_dir() -> None:
    if APP_DIR.exists():
        # 目录可能已被外部清空（robocopy /MIR 清场）：空目录直接 rmdir，
        # 避免批量删除保护把打包挂起；非空时才走递归删除。
        if next(APP_DIR.rglob("*"), None) is None:
            APP_DIR.rmdir()
        else:
            shutil.rmtree(APP_DIR)
    APP_DIR.mkdir(parents=True)

    log("== copying executable ==")
    shutil.copy2(RELEASE_EXE, APP_DIR / f"{APP_NAME}.exe")

    log("== copying sidecars ==")
    shutil.copytree(
        ROOT / "sidecars" / "py",
        APP_DIR / "sidecars" / "py",
        ignore=ignore_generic,
    )
    (APP_DIR / "sidecars" / "java").mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "sidecars" / "java" / "runner.jar", APP_DIR / "sidecars" / "java" / "runner.jar")
    shutil.copytree(ROOT / "sidecars" / "jre", APP_DIR / "sidecars" / "jre", ignore=ignore_generic)
    shutil.copytree(
        ROOT / "sidecars" / "python-embed",
        APP_DIR / "sidecars" / "python-embed",
        ignore=lambda d, n: ignore_generic(d, n) | ignore_python(d, n),
    )

    log("== portable data dir ==")
    (APP_DIR / "data").mkdir()
    (APP_DIR / "data" / ".keep").write_text("", encoding="utf-8")

    conf = json.loads(CONF.read_text(encoding="utf-8"))
    version = conf.get("version", "0.0.0")
    (APP_DIR / "使用说明.txt").write_text(
        f"""{APP_NAME} {version}（便携版）

1. 双击「{APP_NAME}.exe」启动，无需安装。
2. 配置、收藏、历史都保存在本目录的 data\\ 下；整个文件夹可随意移动或删除。
3. 软件不内置任何源，请在「设置」中导入你自己的 TVBox 配置。
4. 需要 mpv 兜底时，把 mpv.exe 放到 sidecars\\mpv\\ 下即可。
5. 从旧版 TVBox Desktop 升级：把旧目录 data/ 里的 tvbox.db 复制到本目录 data/，首次启动会自动迁移成 luma.db，旧文件不会被删除。
6. 未签名程序首次运行可能触发 SmartScreen：更多信息 → 仍要运行。

免责声明：本程序仅为播放框架，不提供、不托管任何音视频内容或源站地址。
第三方配置与源的合法性、安全性由使用者自行判断并承担全部责任。
""",
        encoding="utf-8",
    )


def add_mpv() -> None:
    source = ROOT / "sidecars" / "mpv" / "mpv.exe"
    if not source.is_file():
        log("!! --with-mpv requested but sidecars/mpv/mpv.exe is missing; skipped")
        return
    target = APP_DIR / "sidecars" / "mpv"
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target / "mpv.exe")
    log(f"== mpv included: {human(source.stat().st_size)} ==")


def make_zip() -> None:
    log("== zipping ==")
    ZIP_PATH.parent.mkdir(parents=True, exist_ok=True)
    if ZIP_PATH.exists():
        ZIP_PATH.unlink()
    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for item in sorted(APP_DIR.rglob("*")):
            if item.is_file():
                archive.write(item, item.relative_to(OUT_DIR))


def report() -> None:
    log("\n=== PORTABLE SUMMARY ===")
    for name in ("data", "sidecars/py", "sidecars/python-embed", "sidecars/jre", "sidecars/java", "sidecars/mpv"):
        path = APP_DIR / name
        if path.exists():
            log(f"  {name:28} {human(tree_size(path)):>10}")
    exe_name = f"{APP_NAME}.exe"
    exe = APP_DIR / exe_name
    log(f"  {exe_name:28} {human(tree_size(exe)):>10}")
    log(f"  {'folder total':28} {human(tree_size(APP_DIR)):>10}")
    log(f"  {'zip':28} {human(tree_size(ZIP_PATH)):>10}  {ZIP_PATH.relative_to(ROOT)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--with-mpv", action="store_true", help="bundle sidecars/mpv/mpv.exe")
    parser.add_argument("--skip-build", action="store_true", help="reuse the existing release exe")
    args = parser.parse_args()

    if not args.skip_build:
        build_release()
    if not RELEASE_EXE.is_file():
        raise SystemExit(f"missing release binary: {RELEASE_EXE}")

    prepare_app_dir()
    if args.with_mpv:
        add_mpv()
    make_zip()
    report()
    return 0


if __name__ == "__main__":
    sys.exit(main())
