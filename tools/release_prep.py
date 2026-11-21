#!/usr/bin/env python3
"""发布收口：一条命令完成版本提升、CHANGELOG 校验、原子 commit 与 tag。

为什么需要它：`package.json` 的 `version` 是唯一数值来源，但 `Cargo.toml` 只能写
字面量、`Cargo.lock` 要跟着改、`CHANGELOG` 得有人写、tag 必须与版本号相等。手工做
这四步的任何一步漏掉，都只会在打包或发布时才暴露（`build.rs` 的编译期断言、CI 的
tag 校验、`latest.json` 的 notes 截取各守一段）。本脚本把四步收成一次原子操作：
预检全部通过才落盘，落盘后立刻 commit 与 tag，中间不留人工窗口。

用法：
    python tools/release_prep.py 2.1.0 --dry-run    # 只预览，不写任何文件
    python tools/release_prep.py 2.1.0              # 落盘 + commit + tag
    python tools/release_prep.py 2.1.0 --no-tag     # 只提交，不打 tag
    python tools/release_prep.py 2.1.0 --no-commit  # 只改文件，不提交

前置条件（不满足直接退出，不写任何文件）：
- 工作区干净（`git status --porcelain` 为空）
- 目标版本是合法 semver，且大于当前版本
- 当前 `package.json` / `Cargo.toml` / `Cargo.lock` 三处版本已经一致（基线无漂移）
- `v<version>` tag 本地不存在，远端能查到时也一并拒绝
- `CHANGELOG.md` 已有该版本段且正文非空；否则从 `## [Unreleased]` 原地提升，
  提升后保留一个空的 Unreleased 段（Keep a Changelog 的要求）

刻意不做的事：
- 不 push。tag 推送会直接触发 release 工作流出包，必须人工确认。
- 不跑 cargo。`Cargo.lock` 里 `luma` 包的版本按文本精确改写，与
  `tools/version_check.py` 的读取口径对称；跑 cargo 会引入 target 锁与等待。
- 不判断 CHANGELOG 条目的版本归属。哪个条目属于哪个版本是人写的语义，脚本只搬运
  Unreleased 的正文，不做内容归并。
"""

from __future__ import annotations

import argparse
import datetime
import difflib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = ROOT / "package.json"
CARGO_TOML = ROOT / "src-tauri" / "Cargo.toml"
CARGO_LOCK = ROOT / "src-tauri" / "Cargo.lock"
CHANGELOG = ROOT / "CHANGELOG.md"
CRATE = "luma"

# 本脚本唯一有写权限的四个文件；发布提交只包含它们。
TARGETS = (PACKAGE_JSON, CARGO_TOML, CARGO_LOCK, CHANGELOG)
# 版本载体：只能由本脚本改写，因此发版前必须是干净的。
VERSION_TARGETS = (PACKAGE_JSON, CARGO_TOML, CARGO_LOCK)


def changelog_name() -> str:
    return CHANGELOG.relative_to(ROOT).as_posix()

# 只接受不带前导零的数字段，prerelease 字符集按 semver 放宽到 [0-9A-Za-z.-]。
SEMVER_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z.-]+))?"
    r"(?:\+[0-9A-Za-z.-]+)?$"
)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class ReleaseError(Exception):
    """预检或执行失败：调用方负责打印并以非零码退出。"""


# --------------------------------------------------------------------------- #
# semver
# --------------------------------------------------------------------------- #


def parse_semver(text: str) -> tuple[int, int, int, str] | None:
    """拆成 (major, minor, patch, prerelease)；prerelease 为空串表示正式版。"""
    match = SEMVER_RE.match(text.strip())
    if match is None:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3)), match.group(4) or ""


def compare_semver(left: str, right: str) -> int:
    """-1 / 0 / 1。有 prerelease 的版本小于同号正式版（semver 11.3）。"""
    a = parse_semver(left)
    b = parse_semver(right)
    if a is None or b is None:
        raise ReleaseError(f"无法比较版本：{left!r} / {right!r}")
    for index in range(3):
        if a[index] != b[index]:
            return -1 if a[index] < b[index] else 1
    pre_a, pre_b = a[3], b[3]
    if not pre_a and not pre_b:
        return 0
    if not pre_a:
        return 1
    if not pre_b:
        return -1
    return _compare_prerelease(pre_a, pre_b)


def _compare_prerelease(left: str, right: str) -> int:
    parts_a = left.split(".")
    parts_b = right.split(".")
    for index in range(max(len(parts_a), len(parts_b))):
        if index >= len(parts_a):
            return -1
        if index >= len(parts_b):
            return 1
        x = parts_a[index]
        y = parts_b[index]
        if x == y:
            continue
        x_numeric = x.isdigit()
        y_numeric = y.isdigit()
        if x_numeric and y_numeric:
            if int(x) != int(y):
                return -1 if int(x) < int(y) else 1
            continue
        if x_numeric:
            return -1
        if y_numeric:
            return 1
        return -1 if x < y else 1
    return 0


# --------------------------------------------------------------------------- #
# 文本读写与三个版本载体
# --------------------------------------------------------------------------- #


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    """UTF-8 无 BOM + LF（AGENTS.md「编码与 Git 约定」）。"""
    path.write_text(text, encoding="utf-8", newline="\n")


def package_version(text: str) -> str:
    value = json.loads(text).get("version")
    if not isinstance(value, str) or not value:
        raise ReleaseError("package.json 缺少字符串 version")
    return value


def cargo_package_version(text: str) -> str | None:
    """`[package]` 段里第一个 `version = "..."`，不碰 `[dependencies]` 的同名字段。"""
    in_package = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_package = stripped == "[package]"
            continue
        if not in_package:
            continue
        match = re.match(r'^\s*version\s*=\s*"([^"]*)"', line)
        if match:
            return match.group(1)
    return None


def lock_package_version(text: str, crate: str = CRATE) -> str | None:
    for block in text.split("[[package]]"):
        if not re.search(rf'(?m)^name = "{re.escape(crate)}"\s*$', block):
            continue
        match = re.search(r'(?m)^version = "([^"]*)"$', block)
        return match.group(1) if match else None
    return None


def bump_package_json(text: str, version: str) -> str:
    """只改顶层第一个 `"version"` 行，保留缩进、字段顺序与其余内容。"""
    pattern = re.compile(r'(?m)^(\s*"version"\s*:\s*")([^"]*)(")')
    new_text, count = pattern.subn(
        lambda match: match.group(1) + version + match.group(3), text, count=1
    )
    if count != 1:
        raise ReleaseError("package.json 里找不到唯一的顶层 version 行")
    if package_version(new_text) != version:
        raise ReleaseError("package.json 改写后版本号未生效")
    return new_text


def bump_cargo_toml(text: str, version: str) -> str:
    lines = text.splitlines(keepends=True)
    in_package = False
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("["):
            in_package = stripped == "[package]"
            continue
        if not in_package:
            continue
        match = re.match(r'^(\s*version\s*=\s*")([^"]*)(")', line)
        if match:
            lines[index] = match.group(1) + version + match.group(3) + line[match.end() :]
            return "".join(lines)
    raise ReleaseError("src-tauri/Cargo.toml 的 [package] 段里找不到 version")


def bump_cargo_lock(text: str, version: str, crate: str = CRATE) -> str:
    blocks = text.split("[[package]]")
    for index, block in enumerate(blocks):
        if not re.search(rf'(?m)^name = "{re.escape(crate)}"\s*$', block):
            continue
        new_block, count = re.subn(
            r'(?m)^(version = ")([^"]*)(")$',
            lambda match: match.group(1) + version + match.group(3),
            block,
            count=1,
        )
        if count != 1:
            raise ReleaseError(f"Cargo.lock 的 {crate} 块里找不到 version")
        blocks[index] = new_block
        return "[[package]]".join(blocks)
    raise ReleaseError(f'Cargo.lock 里找不到 name = "{crate}" 的包')


# --------------------------------------------------------------------------- #
# CHANGELOG
# --------------------------------------------------------------------------- #


def changelog_sections(lines: list[str]) -> list[dict]:
    """把 `## ` 标题切成段；`---` 分隔线也算段尾。

    返回 [{"title", "start", "end"}]，`end` 为排他下标。
    """
    starts = [index for index, line in enumerate(lines) if line.startswith("## ")]
    sections: list[dict] = []
    for order, start in enumerate(starts):
        end = starts[order + 1] if order + 1 < len(starts) else len(lines)
        for probe in range(start + 1, end):
            if lines[probe].strip() == "---":
                end = probe
                break
        sections.append({"title": lines[start][3:].strip(), "start": start, "end": end})
    return sections


def title_version(title: str) -> str | None:
    """`## [2.0.3] - 2026-11-21` / `## 2.0.3` 都能取出 2.0.3。"""
    match = re.match(r"^\[?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*\]?", title)
    return match.group(1) if match else None


def section_body(lines: list[str], section: dict) -> list[str]:
    body = lines[section["start"] + 1 : section["end"]]
    while body and not body[0].strip():
        body = body[1:]
    while body and not body[-1].strip():
        body = body[:-1]
    return body


def prepare_changelog(text: str, version: str, date: str) -> tuple[str, str]:
    """返回 (新文本, 说明)。已有该版本段则原样返回并校验正文非空。"""
    lines = text.splitlines()
    sections = changelog_sections(lines)

    for section in sections:
        if title_version(section["title"]) != version:
            continue
        if not section_body(lines, section):
            raise ReleaseError(
                f"CHANGELOG 已有 [{version}] 段但正文为空：latest.json 的 notes 会取不到内容"
            )
        return text, f"沿用已有的 [{version}] 段"

    unreleased = next(
        (section for section in sections if re.fullmatch(r"\[?unreleased\]?", section["title"], re.I)),
        None,
    )
    if unreleased is None:
        raise ReleaseError("CHANGELOG 既无目标版本段，也没有 ## [Unreleased] 段")
    body = section_body(lines, unreleased)
    if not body:
        raise ReleaseError("CHANGELOG 的 Unreleased 段为空：没有可提升的内容")

    promoted = ["## [Unreleased]", "", f"## [{version}] - {date}", ""] + body + [""]
    new_lines = lines[: unreleased["start"]] + promoted + lines[unreleased["end"] :]
    return "\n".join(new_lines) + "\n", f"把 Unreleased 的 {len(body)} 行提升为 [{version}]"


def changelog_warnings(text: str) -> list[str]:
    """结构提醒，不阻断发布：内容归属是人写的语义，脚本只提示位置与顺序。"""
    lines = text.splitlines()
    sections = changelog_sections(lines)
    warnings: list[str] = []

    positions: list[tuple[int, str, str | None]] = [
        (index, section["title"], title_version(section["title"]))
        for index, section in enumerate(sections)
    ]
    released = [(index, version) for index, _, version in positions if version]
    unreleased = [index for index, _, version in positions if version is None]

    if released and unreleased and min(unreleased) > min(index for index, _ in released):
        warnings.append("## [Unreleased] 不在文件最前（Keep a Changelog 要求置顶）")

    for order in range(1, len(released)):
        previous = released[order - 1][1]
        current = released[order][1]
        if compare_semver(current, previous) >= 0:
            warnings.append(f"版本段顺序不是递减：{previous} 出现在 {current} 之前")
    return warnings


# --------------------------------------------------------------------------- #
# git
# --------------------------------------------------------------------------- #


def git(*args: str, check: bool = True, timeout: float | None = 60.0) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as err:
        raise ReleaseError(f"git {' '.join(args)} 超时：{err}") from err
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise ReleaseError(f"git {' '.join(args)} 失败：{detail}")
    return result


def classify_status(lines: list[str]) -> tuple[list[str], list[str]]:
    """把 `git status --porcelain` 的行分成 (版本载体的脏改动, 其它文件)。

    `CHANGELOG.md` 两边都不算：`Unreleased` 里待发布的条目本来就写好在工作区、
    由这一次发布提交带走，要求它先单独提交会把一条发版拆成两笔。
    """
    carriers = {path.relative_to(ROOT).as_posix() for path in VERSION_TARGETS}
    log_name = changelog_name()
    blocked: list[str] = []
    others: list[str] = []
    for line in lines:
        if not line.strip():
            continue
        path = line[3:].strip().strip('"')
        if " -> " in path:
            path = path.split(" -> ")[-1]
        if path in carriers:
            blocked.append(line)
        elif path == log_name:
            continue
        else:
            others.append(line)
    return blocked, others


def require_clean_tree(allow_dirty: bool) -> list[str]:
    """版本载体必须干净；其它文件的脏改动默认也拦截，`--allow-dirty` 时只告警。

    `CHANGELOG.md` 不参与判定：它的未提交内容就是这次要发布的条目。
    返回未提交的无关文件列表（供调用方打印），不阻断。
    """
    result = git("status", "--porcelain", check=False)
    if result.returncode != 0:
        raise ReleaseError("不在 git 工作树内")

    blocked, others = classify_status(result.stdout.splitlines())
    if blocked:
        raise ReleaseError(
            "版本文件里有未提交的改动，先把它们提交或还原：\n" + "\n".join(blocked)
        )
    if others and not allow_dirty:
        raise ReleaseError(
            "工作区不干净（--allow-dirty 可放行无关文件）：\n" + "\n".join(others)
        )
    return others


def tag_exists(tag: str) -> bool:
    return git("rev-parse", "--verify", "--quiet", f"refs/tags/{tag}", check=False).returncode == 0


def remote_tag_exists(tag: str) -> bool | None:
    """None 表示查不到（无网 / 无 origin / 超时），不据此阻断发布。"""
    result = git("ls-remote", "--tags", "origin", f"refs/tags/{tag}", check=False, timeout=15.0)
    if result.returncode != 0:
        return None
    return bool(result.stdout.strip())


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #


def render_diff(path: Path, before: str, after: str) -> str:
    relative = path.relative_to(ROOT).as_posix()
    return "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile=f"a/{relative}",
            tofile=f"b/{relative}",
            n=2,
        )
    )


def run(args: argparse.Namespace) -> int:
    version = args.version.strip()
    if version.startswith("v"):
        version = version[1:]
    if parse_semver(version) is None:
        raise ReleaseError(f"{version!r} 不是合法 semver（要求 X.Y.Z，可带 -pre / +build）")

    date = args.date or datetime.date.today().isoformat()
    if not DATE_RE.match(date):
        raise ReleaseError("--date 需要 YYYY-MM-DD")

    pkg_text = read_text(PACKAGE_JSON)
    cargo_text = read_text(CARGO_TOML)
    lock_text = read_text(CARGO_LOCK)
    log_text = read_text(CHANGELOG)

    current = package_version(pkg_text)
    if compare_semver(version, current) <= 0:
        raise ReleaseError(f"目标 {version} 必须大于当前 {current}")

    drift = []
    cargo_current = cargo_package_version(cargo_text)
    lock_current = lock_package_version(lock_text)
    if cargo_current != current:
        drift.append(f"Cargo.toml = {cargo_current!r}")
    if lock_current != current:
        drift.append(f"Cargo.lock = {lock_current!r}")
    if drift:
        raise ReleaseError(
            f"当前基线已漂移（先跑 python tools/version_check.py）：{current!r} vs "
            + "；".join(drift)
        )

    tag = f"v{version}"
    if tag_exists(tag):
        raise ReleaseError(f"本地已有 tag {tag}：同一版本号不要重复发布")
    if remote_tag_exists(tag):
        raise ReleaseError(f"origin 已有 tag {tag}：同一版本号不要重复发布")

    require_clean_tree(args.allow_dirty)

    new_pkg = bump_package_json(pkg_text, version)
    new_cargo = bump_cargo_toml(cargo_text, version)
    new_lock = bump_cargo_lock(lock_text, version)
    new_log, log_note = prepare_changelog(log_text, version, date)
    warnings = changelog_warnings(new_log)

    changed: list[tuple[Path, str]] = []
    for path, before, after in (
        (PACKAGE_JSON, pkg_text, new_pkg),
        (CARGO_TOML, cargo_text, new_cargo),
        (CARGO_LOCK, lock_text, new_lock),
        (CHANGELOG, log_text, new_log),
    ):
        if before != after:
            changed.append((path, after))

    print(f"版本 {current} -> {version}")
    print(f"  package.json          {version}")
    print(f"  src-tauri/Cargo.toml  {version}")
    print(f"  src-tauri/Cargo.lock  {version}")
    print(f"  CHANGELOG.md          {log_note}")
    for warning in warnings:
        print(f"  提醒：{warning}")
    print()

    if args.dry_run:
        for path, after in changed:
            before = read_text(path)
            diff = render_diff(path, before, after)
            if diff:
                print(diff, end="" if diff.endswith("\n") else "\n")
        print()
        print("（--dry-run：未写入任何文件，未 commit，未打 tag）")
        return 0

    for path, after in changed:
        write_text(path, after)

    if args.no_commit:
        print("已改写文件，未提交（--no-commit）。回滚：git checkout -- " + " ".join(
            path.relative_to(ROOT).as_posix() for path, _ in changed
        ))
        return 0

    staged = [path.relative_to(ROOT).as_posix() for path, _ in changed]
    # CHANGELOG 始终入提交：Unreleased 的条目可能已经写在工作区但还没提交，
    # 提升后即便只有日期行变化，也要和版本号一起进这一笔发布提交。
    if changelog_name() not in staged:
        staged.append(changelog_name())
    message = f"chore(release): 版本升至 {version}"
    try:
        git("add", "--", *staged)
        git("commit", "-m", message)
    except ReleaseError:
        print(
            "文件已写入但提交失败。回滚：git checkout -- " + " ".join(staged),
            file=sys.stderr,
        )
        raise

    commit_sha = git("rev-parse", "--short", "HEAD").stdout.strip()
    print(f"commit  {commit_sha}  {message}")

    if args.no_tag:
        print("未打 tag（--no-tag）")
        return 0

    git("tag", "-a", tag, "-m", f"release {version}")
    print(f"tag     {tag}（annotated）")
    print()
    print("下一步（确认无误后手动推送，tag 会触发 release 工作流出包）：")
    print(f"  git push && git push origin {tag}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="版本提升与发布收口：bump + CHANGELOG 校验 + 原子 commit + tag",
    )
    parser.add_argument("version", help="目标版本，如 2.1.0 或 2.0.0-beta.1")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要发生的改动")
    parser.add_argument("--no-commit", action="store_true", help="改文件但不提交")
    parser.add_argument("--no-tag", action="store_true", help="提交但不打 tag")
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="放行与版本无关的未提交文件（目标四个文件仍必须干净）",
    )
    parser.add_argument("--date", help="CHANGELOG 日期，默认今天（YYYY-MM-DD）")
    args = parser.parse_args(argv)

    try:
        return run(args)
    except ReleaseError as error:
        print(f"RELEASE ABORTED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
