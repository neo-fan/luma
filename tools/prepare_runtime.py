#!/usr/bin/env python3
"""P3 打包期运行时产物准备（幂等）。

步骤：
  1. jlink 裁剪 JRE        -> sidecars/jre
  2. Python 3.11 embeddable -> sidecars/python-embed（含第三方依赖，见第 2.5 步）
  2.5 按 tools/python-requirements.txt 装回 py 采集源依赖（Crypto/requests/lxml…）
  3. Tauri externalBin staging -> src-tauri/binaries
  4. 随包 JS 依赖资源校验 -> sidecars/qjs-assets（只读、离线，不下载）

约定：
  * 脚本自身只用标准库，不 import 任何第三方包（装依赖通过 subprocess 调 pip）。
  * 所有路径相对项目根（本文件上一级），不硬编码盘符。
  * 已存在即跳过，可重复执行。
  * 第 4 步是入库源码资源的只读体检，离线可用，绝不联网下载资源。
  * JDK 只在重建 JRE 时需要：LUMA_JDK17_HOME -> JAVA_HOME -> PATH 上的 jlink；
    不硬编码任何本机盘符。运行期一律用随包 sidecars/jre，无需安装 JDK。

用法：
  python tools/prepare_runtime.py                    # 全量（缺失项补齐）
  python tools/prepare_runtime.py --force            # 强制重做 jre / python-embed
  python tools/prepare_runtime.py --check            # 只体检，不写文件
  python tools/prepare_runtime.py --skip-qjs-sha     # 跳过 JS 资源的 SHA256 校验
"""

from __future__ import annotations

import argparse
import hashlib
import json
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

JLINK_MODULES = "java.base,java.net.http,java.logging,jdk.unsupported"
JLINK_FLAGS = [
    "--strip-debug",
    "--no-man-pages",
    "--no-header-files",
]

PY_VERSION = "3.11.9"
PY_REQUIREMENTS = ROOT / "tools" / "python-requirements.txt"
# 重建后必须能 import 成功的模块（缺任一即视为依赖不全，需要安装）。
PY_REQUIRED_MODULES = ("Crypto", "requests", "lxml", "bs4", "pyquery")
PY_URLS = [
    f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip",
]
PY_FALLBACK_VERSIONS = ["3.11.8", "3.11.10"]
PY_MIRROR = (
    "https://mirrors.huaweicloud.com/python/{v}/python-{v}-embed-amd64.zip"
)

TARGET_SUFFIX = "-x86_64-pc-windows-msvc.exe"

# 随包 QuickJS ESM 依赖资源（入库源码资源，不由本脚本下载/重建）。
QJS_ASSETS_DIR = ROOT / "sidecars" / "qjs-assets"
QJS_ASSETS_LIB = QJS_ASSETS_DIR / "js" / "lib"
QJS_ASSETS_MANIFEST = QJS_ASSETS_DIR / "manifest.json"
# 与 sidecars/qjs-runner/src/main.rs::BUNDLED 保持一致的 8 个文件。
QJS_ASSET_FILES = (
    "cheerio.min.js",
    "crypto-js.js",
    "node-rsa.js",
    "pako.min.js",
    "gbk.js",
    "json5.js",
    "jinja.js",
    "template.js",
)


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
    which = shutil.which("jlink")
    if which:
        jdk = Path(which).parent.parent
        print(f"  [jdk] 使用 PATH 上的 jlink -> {jdk}")
        return jdk
    return None


# 运行时产物目录（sidecars/jre、python-embed、mpv）整目录在 .gitignore 里，
# 不跟踪任何占位文件：这里不再补 .gitkeep，产物目录保持干净。


# ---------------------------------------------------------------- step 1


def step_jre(force: bool = False) -> bool:
    print("[1/4] jlink 裁剪 JRE -> sidecars/jre")
    java_exe = JRE_DIR / "bin" / "java.exe"
    if java_exe.exists() and not force:
        print("  已存在，跳过 jlink")
        report_size("sidecars/jre", JRE_DIR)
        return True

    jdk = resolve_jdk17()
    if jdk is None:
        print("  [fail] 重建 JRE 需 JDK 17：设 LUMA_JDK17_HOME / JAVA_HOME，或让 jlink 在 PATH 上")
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


def ensure_site_packages_in_pth(py_dir: Path) -> None:
    """保证 embeddable 的 ._pth 启用 site-packages 与 site.main()（幂等）。

    官方 python-3.11-embed zip 里的 `python311._pth` 默认只有 python311.zip
    与 "."；第三方包虽被 pip 装进 Lib\\site-packages，却不在 sys.path 里，
    会表现成诡异的 `No module named 'Crypto'`。补两行让随包依赖能被找到：
      * `Lib\\site-packages`（路径本身）
      * `import site`（取消注释，执行 site 初始化，让 site-packages 下的
        .pth 文件也生效——pip 装的若干包依赖这个）
    """
    pth_files = list(py_dir.glob("python3*._pth"))
    if not pth_files:
        print("  [warn] 未找到 python3xx._pth，跳过 site-packages 配置")
        return
    pth = pth_files[0]
    text = pth.read_text(encoding="utf-8")
    lines = text.splitlines()
    changed = False

    if not any(line.strip().replace("/", "\\") == "Lib\\site-packages" for line in lines):
        lines.append("Lib\\site-packages")
        changed = True
    for idx, line in enumerate(lines):
        if line.strip() == "#import site":
            lines[idx] = "import site"
            changed = True
        elif line.strip() == "import site":
            break

    if changed:
        pth.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"  [ok] 已配置 {pth.name} 启用 site-packages / site")
    else:
        print(f"  [info] {pth.name} 已启用 site-packages / site")


def step_python(force: bool = False) -> bool:
    print("[2/4] Python embeddable -> sidecars/python-embed")
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

    # 官方 embeddable zip 的 ._pth 只有 python311.zip 与 "."，不含
    # Lib\site-packages，也没启用 import site。若不补，后面即使把依赖装进
    # site-packages，embed python 也 import 不到（sys.path 里没有这一项）。
    ensure_site_packages_in_pth(PY_DIR)

    ver = run([str(PY_DIR / "python.exe"), "--version"])
    print("  [ok] " + (ver.stdout or ver.stderr).strip())
    report_size("sidecars/python-embed", PY_DIR)
    return True


def python_missing_modules() -> list[str]:
    """embed python 当前 import 不到的必需模块（空列表＝依赖齐全）。"""
    py_exe = PY_DIR / "python.exe"
    if not py_exe.is_file():
        return list(PY_REQUIRED_MODULES)
    probe = (
        "import importlib.util,sys;"
        "print(' '.join(m for m in sys.argv[1:] if importlib.util.find_spec(m) is None))"
    )
    proc = run([str(py_exe), "-c", probe, *PY_REQUIRED_MODULES])
    if proc.returncode != 0:
        return list(PY_REQUIRED_MODULES)
    return (proc.stdout or "").strip().split()


def step_python_deps(force: bool = False) -> bool:
    """把 py 采集源的第三方依赖装进随包 embed 的 site-packages（幂等）。

    官方 embeddable zip 不含任何第三方库，且 `step_python --force` 会清空
    整个 PY_DIR 重新解压；若不在这里装回，瓜子/苹果/枫叶等源就会报
    `No module named 'Crypto'`。依赖清单固定在 tools/python-requirements.txt，
    保证 dev 与安装交付版跑同一份解释器、同一批库。
    """
    py_exe = PY_DIR / "python.exe"
    if not py_exe.is_file():
        print("  [skip] python-embed 不存在，跳过依赖安装")
        return False
    if not PY_REQUIREMENTS.is_file():
        print(f"  [fail] 依赖清单缺失：{PY_REQUIREMENTS.name}")
        return False

    missing = python_missing_modules()
    if missing and not force:
        print("  [info] 随包 Python 缺依赖：" + ", ".join(missing))

    # 幂等：依赖齐全且非强制时直接跳过，不重复联网/写盘。
    if not missing and not force:
        print("  已存在，跳过（随包 Python 依赖齐全）")
        return True

    site_packages = PY_DIR / "Lib" / "site-packages"
    site_packages.mkdir(parents=True, exist_ok=True)

    # 优先用 embed 自带的 pip（若已引导）；否则退回开发机 pip --target 直接
    # 装进 embed 的 site-packages。后者不依赖 embeddable 是否带 pip/ensurepip。
    embed_pip = run([str(py_exe), "-m", "pip", "--version"])
    if embed_pip.returncode == 0:
        cmd = [str(py_exe), "-m", "pip", "install", "--disable-pip-version-check",
               "-r", str(PY_REQUIREMENTS)]
        print("  [deps] 用随包 pip 安装")
    else:
        cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
               "--target", str(site_packages), "-r", str(PY_REQUIREMENTS)]
        print("  [deps] 随包无 pip，用开发机 pip --target 安装 ->", site_packages.name)

    proc = run(cmd)
    if proc.returncode != 0:
        print("  [fail] 依赖安装失败：" + (proc.stderr or proc.stdout).strip()[-600:])
        return False
    if (proc.stderr or "").strip():
        print("  [warn] " + proc.stderr.strip()[-300:])

    still = python_missing_modules()
    if still:
        print("  [fail] 安装后仍缺模块：" + ", ".join(still))
        return False
    print("  [ok] 随包 Python 依赖齐全：" + ", ".join(PY_REQUIRED_MODULES))
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
    print("[3/4] Tauri externalBin staging -> src-tauri/binaries")
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


# ---------------------------------------------------------------- step 4


def qjs_assets_hint() -> None:
    """缺文件/校验不一致时给出可操作的补齐提示（不联网、不自动下载）。"""
    print("  [hint] 请重新运行资源下载脚本，按固定 commit 把 8 个文件抓回")
    print("         sidecars/qjs-assets/js/lib/，并核对 sidecars/qjs-assets/manifest.json；")
    print("         可下载 URL 前缀与整仓 zip 见 docs/js-support.md。本脚本只校验、不下载。")


def step_qjs_assets(verify_sha: bool = True) -> bool:
    """[4/4] 校验随包 QuickJS ESM 依赖资源（只读、离线、幂等）。

    sidecars/qjs-assets/ 是入库源码资源，不由本脚本下载/重建。这里只做交付前
    体检：8 个文件是否齐全，并可选按 manifest.json 校验字节数与 SHA256。
    缺文件或与清单不一致时给出可操作的补齐提示，不联网、不中断打包。
    """
    print("[4/4] 随包 JS 依赖资源校验 -> sidecars/qjs-assets")

    missing = [name for name in QJS_ASSET_FILES if not (QJS_ASSETS_LIB / name).is_file()]
    print(f"  {len(QJS_ASSET_FILES) - len(missing)}/{len(QJS_ASSET_FILES)} 个文件齐全，"
          f"js/lib 合计 {fmt(du(QJS_ASSETS_LIB))}")

    bad: list[str] = []
    sha_checked = False
    sha_count = 0
    if verify_sha and QJS_ASSETS_MANIFEST.is_file():
        try:
            entries = json.loads(QJS_ASSETS_MANIFEST.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"  [warn] manifest.json 解析失败，跳过 SHA256 校验：{exc}")
            entries = []
        by_local: dict[str, dict] = {}
        if isinstance(entries, list):
            by_local = {
                str(item["local"]): item
                for item in entries
                if isinstance(item, dict) and item.get("local")
            }
        # Verify every file the manifest knows about, not just the 8 required
        # ESM deps: `drpy2.min.js` is an extra bundled engine and used to slip
        # past this check, so a corrupted copy went unnoticed until the app ran.
        for name in sorted(set(QJS_ASSET_FILES) | set(by_local)):
            item = by_local.get(name)
            path = QJS_ASSETS_LIB / name
            if not item or not path.is_file():
                continue
            expected_bytes = item.get("bytes")
            if isinstance(expected_bytes, int) and path.stat().st_size != expected_bytes:
                bad.append(f"{name} 字节数 {path.stat().st_size} != {expected_bytes}")
            expected_sha = item.get("sha256")
            if isinstance(expected_sha, str) and expected_sha:
                actual = hashlib.sha256(path.read_bytes()).hexdigest()
                sha_checked = True
                sha_count += 1
                if actual != expected_sha.lower():
                    bad.append(f"{name} SHA256 不一致")
    elif verify_sha:
        print(f"  [warn] {QJS_ASSETS_MANIFEST.relative_to(ROOT)} 缺失，跳过 SHA256 校验")
    else:
        print("  [info] 已按 --skip-qjs-sha 跳过 SHA256 校验")

    report_size("sidecars/qjs-assets", QJS_ASSETS_DIR)

    if missing:
        print("  [fail] 缺失文件：" + ", ".join(missing))
        qjs_assets_hint()
        return False
    if bad:
        print("  [fail] 与 manifest.json 不一致：" + "; ".join(bad))
        qjs_assets_hint()
        return False
    print(
        f"  [ok] {len(QJS_ASSET_FILES)} 个 JS 依赖齐全"
        + (f"，{sha_count} 个资源字节数/SHA256 校验通过" if sha_checked else "")
    )
    return True


# ---------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description="准备 P3 打包期运行时产物（幂等）")
    parser.add_argument("--force", action="store_true", help="强制重做 jre 与 python-embed")
    parser.add_argument("--check", action="store_true", help="只体检，不写文件")
    parser.add_argument("--skip-qjs-sha", action="store_true",
                        help="跳过 qjs-assets 的 SHA256/字节数校验，只查文件齐全")
    args = parser.parse_args()

    print(f"项目根：{ROOT}")
    verify_sha = not args.skip_qjs_sha
    if args.check:
        report_size("sidecars/jre", JRE_DIR)
        report_size("sidecars/python-embed", PY_DIR)
        report_size("src-tauri/binaries", BIN_DIR)
        report_size("sidecars/qjs-assets", QJS_ASSETS_DIR)
        report_size("dist", ROOT / "dist")
        missing = python_missing_modules()
        print("  [deps] 随包 Python 第三方依赖：" + ("齐全" if not missing else "缺 " + ", ".join(missing)))
        ok_qjs = step_qjs_assets(verify_sha=verify_sha)
        return 0 if (not missing and ok_qjs) else 1

    ok_jre = step_jre(force=args.force)
    ok_py = step_python(force=args.force)
    ok_deps = step_python_deps(force=args.force)
    ok_bin = step_binaries()
    ok_qjs = step_qjs_assets(verify_sha=verify_sha)

    print("\n汇总")
    report_size("sidecars/jre", JRE_DIR)
    report_size("sidecars/python-embed", PY_DIR)
    report_size("src-tauri/binaries", BIN_DIR)
    report_size("sidecars/qjs-assets", QJS_ASSETS_DIR)
    report_size("dist", ROOT / "dist")

    return 0 if (ok_jre and ok_py and ok_deps and ok_bin and ok_qjs) else 1


if __name__ == "__main__":
    sys.exit(main())
