#!/usr/bin/env python3
"""P3 打包期运行时产物准备（幂等）。

步骤：
  1. jlink 裁剪 JRE        -> sidecars/jre
  2. Python 3.11 embeddable -> sidecars/python-embed
  3. Tauri externalBin staging -> src-tauri/binaries

约定：
  * 只用标准库，不引入依赖。
  * 所有路径相对项目根（本文件上一级），不硬编码盘符。
  * 已存在即跳过，可重复执行。
  * JDK 解析顺序：LUMA_JDK17_HOME -> JAVA_HOME -> 默认开发机路径。

用法：
  python tools/prepare_runtime.py            # 全量（缺失项补齐）
  python tools/prepare_runtime.py --force    # 强制重做 jre / python-embed
  python tools/prepare_runtime.py --check    # 只体检，不写文件
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

JRE_DIR = ROOT / "sidecars" / "jre"
PY_DIR = ROOT / "sidecars" / "python-embed"
BIN_DIR = ROOT / "src-tauri" / "binaries"

# JDK 17 的默认位置只是开发机约定（本机安装路径），部署/CI 请用
# LUMA_JDK17_HOME 或 JAVA_HOME 覆盖。
DEFAULT_JDK17_HOME = Path("D:/software/java/oracle-jdk-17")

JLINK_MODULES = "java.base,java.net.http,java.logging,jdk.unsupported"
JLINK_FLAGS = [
    "--strip-debug",
    "--no-man-pages",
    "--no-header-files",
]

PY_VERSION = "3.11.9"
PY_URLS = [
    f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip",
]
PY_FALLBACK_VERSIONS = ["3.11.8", "3.11.10"]
PY_MIRROR = (
    "https://mirrors.huaweicloud.com/python/{v}/python-{v}-embed-amd64.zip"
)

TARGET_SUFFIX = "-x86_64-pc-windows-msvc.exe"


# ---------------------------------------------------------------- helpers


def fmt(nbytes: int) -> str:
    return f"{nbytes:,} B / {nbytes / (1024 * 1024):.2f} MB"


def du(path: Path) -> int:
    if not path.exists():
        return 0
    if path.is_file():
        return path.stat().st_size
    total = 0
    for entry in path.rglob("*"):
        if entry.is_file():
            try:
                total += entry.stat().st_size
            except OSError:
                pass
    return total


def report_size(label: str, path: Path) -> None:
    if path.exists():
        print(f"  [size] {label}: {fmt(du(path))}")
    else:
        print(f"  [size] {label}: 不存在")


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("  $ " + " ".join(cmd))
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def resolve_jdk17() -> Path | None:
    for env in ("LUMA_JDK17_HOME", "TVBOX_JDK17_HOME", "JAVA_HOME"):
        value = os.environ.get(env)
        if value and (Path(value) / "bin" / "jlink.exe").exists():
            print(f"  [jdk] 使用 {env}={value}")
            return Path(value)
    if (DEFAULT_JDK17_HOME / "bin" / "jlink.exe").exists():
        print(f"  [jdk] 使用默认开发机路径 {DEFAULT_JDK17_HOME}")
        return DEFAULT_JDK17_HOME
    return None


# 运行时产物目录（sidecars/jre、python-embed、mpv）整目录在 .gitignore 里，
# 不跟踪任何占位文件：这里不再补 .gitkeep，产物目录保持干净。


# ---------------------------------------------------------------- step 1


def step_jre(force: bool = False) -> bool:
    print("[1/3] jlink 裁剪 JRE -> sidecars/jre")
    java_exe = JRE_DIR / "bin" / "java.exe"
    if java_exe.exists() and not force:
        print("  已存在，跳过 jlink")
        report_size("sidecars/jre", JRE_DIR)
        return True

    jdk = resolve_jdk17()
    if jdk is None:
        print("  [fail] 找不到 JDK 17（LUMA_JDK17_HOME / JAVA_HOME / 默认路径均无效）")
        return False

    jlink = jdk / "bin" / "jlink.exe"
    tmp_root = Path(tempfile.mkdtemp(prefix="tvbox-jre-"))
    attempts = [["--compress=2"], ["--compress=zip-6"]]
    ok = False
    for extra in attempts:
        out = tmp_root / "jre"
        if out.exists():
            shutil.rmtree(out, ignore_errors=True)
        cmd = [str(jlink), "--add-modules", JLINK_MODULES, *JLINK_FLAGS, *extra,
               "--output", str(out)]
        proc = run(cmd)
        if proc.returncode == 0 and (out / "bin" / "java.exe").exists():
            ok = True
            break
        print(f"  [warn] jlink 失败（{' '.join(extra)}）：{(proc.stderr or proc.stdout).strip()[:400]}")
    if not ok:
        shutil.rmtree(tmp_root, ignore_errors=True)
        print("  [fail] jlink 未能产出可用 JRE")
        return False

    if JRE_DIR.exists():
        shutil.rmtree(JRE_DIR)
    shutil.move(str(tmp_root / "jre"), str(JRE_DIR))
    shutil.rmtree(tmp_root, ignore_errors=True)

    ver = run([str(JRE_DIR / "bin" / "java.exe"), "-version"])
    print("  [ok] " + (ver.stderr or ver.stdout).strip().splitlines()[0])
    report_size("sidecars/jre", JRE_DIR)
    return True


# ---------------------------------------------------------------- step 2


def _download(url: str, dest: Path) -> bool:
    print(f"  $ GET {url}")
    try:
        with urllib.request.urlopen(url, timeout=60) as resp, dest.open("wb") as fh:
            shutil.copyfileobj(resp, fh)
        return dest.stat().st_size > 1_000_000
    except Exception as exc:  # noqa: BLE001 - 网络错误统一降级到下一个源
        print(f"  [warn] 下载失败：{exc}")
        return False


def step_python(force: bool = False) -> bool:
    print("[2/3] Python embeddable -> sidecars/python-embed")
    py_exe = PY_DIR / "python.exe"
    if py_exe.exists() and not force:
        print("  已存在，跳过下载")
        ver = run([str(py_exe), "--version"])
        print("  [ok] " + (ver.stdout or ver.stderr).strip())
        report_size("sidecars/python-embed", PY_DIR)
        return True

    urls = list(PY_URLS)
    for v in PY_FALLBACK_VERSIONS:
        urls.append(f"https://www.python.org/ftp/python/{v}/python-{v}-embed-amd64.zip")
    urls.append(PY_MIRROR.format(v=PY_VERSION))

    tmp_root = Path(tempfile.mkdtemp(prefix="tvbox-py-"))
    archive = tmp_root / "python-embed.zip"
    if not any(_download(u, archive) for u in urls if not archive.exists() or archive.stat().st_size < 1_000_000):
        shutil.rmtree(tmp_root, ignore_errors=True)
        print("  [fail] 所有下载源均失败")
        return False

    try:
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(tmp_root / "unpacked")
    except zipfile.BadZipFile:
        shutil.rmtree(tmp_root, ignore_errors=True)
        print("  [fail] 下载内容不是合法 zip（可能被代理拦截）")
        return False

    if PY_DIR.exists():
        for entry in PY_DIR.iterdir():
            # 整目录重建：连同历史遗留的 .gitkeep 一起清掉，产物目录不跟踪占位。
            if entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink(missing_ok=True)
    PY_DIR.mkdir(parents=True, exist_ok=True)
    for entry in (tmp_root / "unpacked").iterdir():
        shutil.move(str(entry), str(PY_DIR / entry.name))
    shutil.rmtree(tmp_root, ignore_errors=True)

    ver = run([str(PY_DIR / "python.exe"), "--version"])
    print("  [ok] " + (ver.stdout or ver.stderr).strip())
    report_size("sidecars/python-embed", PY_DIR)
    return True


# ---------------------------------------------------------------- step 3


def stage(src: Path, name: str) -> bool:
    dest = BIN_DIR / (name + TARGET_SUFFIX)
    if dest.exists() and dest.stat().st_size == src.stat().st_size:
        print(f"  已存在，跳过 {dest.relative_to(ROOT)}")
        return True
    if not src.exists():
        print(f"  [skip] 源文件缺失：{src.relative_to(ROOT)}")
        return False
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    print(f"  [ok] {dest.relative_to(ROOT)}  {fmt(dest.stat().st_size)}")
    return True


def step_binaries() -> bool:
    print("[3/3] Tauri externalBin staging -> src-tauri/binaries")
    BIN_DIR.mkdir(parents=True, exist_ok=True)

    # jvm：不生成 externalBin 副本。实测（2026-11）把 sidecars/jre/bin/java.exe
    # 复制改名后单独运行，launcher 找不到 <exe目录>/../bin/server/jvm.dll，会
    # 回落到注册表里宿主安装的 JDK（实测输出 23.0.1，java.home=oracle-jdk-23），
    # 设置 JAVA_HOME 也无法改变优先级 —— 属于"能启动但用错运行时"，故意不做。
    # 正确做法：把 sidecars/jre 作为 resource 目录整体打包，Rust 直接 spawn
    # `<resource>/jre/bin/java.exe -cp <runner.jar> ...`（实测 java.home 指向
    # 自身、版本 17.0.12），JVM 参数与 runner.jar 路径由 Rust 传入。
    print("  [skip] jvm 不放进 externalBin：java.exe 单文件副本无法自包含 JRE，")
    print("         请改由 Rust spawn resource 目录下的 sidecars/jre/bin/java.exe")

    # python-embed：externbin 里只放 python.exe 壳；实测必须让进程的
    # 工作目录或 PATH 指向 sidecars/python-embed，否则 0xC0000135（缺
    # python311.dll）。发布时该目录需整体作为 resource 分发。
    stage(PY_DIR / "python.exe", "python-embed")

    # qjs-runner：真正的单文件 sidecar，release 优先。
    qjs_release = ROOT / "sidecars" / "qjs-runner" / "target" / "release" / "qjs-runner.exe"
    qjs_debug = ROOT / "sidecars" / "qjs-runner" / "target" / "debug" / "qjs-runner.exe"
    qjs_src = qjs_release if qjs_release.exists() else qjs_debug
    if not stage(qjs_src, "qjs-runner"):
        print("  [info] 未找到 qjs-runner 产物，请先在 sidecars/qjs-runner 下 cargo build --release")

    # mpv：规格中为可选项，缺失不阻塞。
    mpv = ROOT / "sidecars" / "mpv" / "mpv.exe"
    if mpv.exists():
        stage(mpv, "mpv")
    else:
        print("  [skip] sidecars/mpv/mpv.exe 不存在（可选组件）")

    print("  当前 staging 目录：")
    for f in sorted(BIN_DIR.glob("*.exe")):
        print(f"    {f.name}  {fmt(f.stat().st_size)}")
    return True


# ---------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="准备 P3 打包期运行时产物（幂等）")
    parser.add_argument("--force", action="store_true", help="强制重做 jre 与 python-embed")
    parser.add_argument("--check", action="store_true", help="只体检，不写文件")
    args = parser.parse_args()

    print(f"项目根：{ROOT}")
    if args.check:
        report_size("sidecars/jre", JRE_DIR)
        report_size("sidecars/python-embed", PY_DIR)
        report_size("src-tauri/binaries", BIN_DIR)
        report_size("dist", ROOT / "dist")
        return 0

    ok_jre = step_jre(force=args.force)
    ok_py = step_python(force=args.force)
    ok_bin = step_binaries()

    print("\n汇总")
    report_size("sidecars/jre", JRE_DIR)
    report_size("sidecars/python-embed", PY_DIR)
    report_size("src-tauri/binaries", BIN_DIR)
    report_size("dist", ROOT / "dist")

    return 0 if (ok_jre and ok_py and ok_bin) else 1


if __name__ == "__main__":
    sys.exit(main())
