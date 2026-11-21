#!/usr/bin/env python3
"""纯逻辑回归：`tools/release_prep.py` 的 semver、三个版本载体改写与 CHANGELOG 提升。

不触碰仓库文件、不调用 git：全部用例在内存字符串上跑，可在任何机器上离线执行。

Usage:
    python tests/offline/release_prep_check.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "release_prep.py"

SPEC = importlib.util.spec_from_file_location("release_prep", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise SystemExit(f"无法加载 {SCRIPT}")
rp = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rp)

PROBLEMS: list[str] = []
ASSERTIONS = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global ASSERTIONS
    ASSERTIONS += 1
    if not condition:
        PROBLEMS.append(f"{label}: {detail}" if detail else label)


def check_error(label: str, fn) -> None:
    global ASSERTIONS
    ASSERTIONS += 1
    try:
        fn()
    except rp.ReleaseError:
        return
    except Exception as err:  # noqa: BLE001 - 测试要区分异常种类
        PROBLEMS.append(f"{label}: 抛出 {type(err).__name__} 而不是 ReleaseError")
        return
    PROBLEMS.append(f"{label}: 应当抛 ReleaseError，却成功返回")


# --------------------------------------------------------------------------- #
# semver
# --------------------------------------------------------------------------- #

for valid in ("2.0.3", "0.1.0", "10.20.30", "2.0.0-beta.1", "2.0.0+build.5", "2.0.0-rc.1+sha.abc"):
    check(f"合法 semver {valid}", rp.parse_semver(valid) is not None)

for invalid in ("2.0", "v2.0.3", "02.0.3", "2.0.3.1", "abc", "", "2.0.3-"):
    check(f"非法 semver {invalid!r}", rp.parse_semver(invalid) is None, "应被拒绝")

check("2.0.3 < 2.1.0", rp.compare_semver("2.0.3", "2.1.0") == -1)
check("2.10.0 > 2.9.0", rp.compare_semver("2.10.0", "2.9.0") == 1)
check("2.0.3 == 2.0.3", rp.compare_semver("2.0.3", "2.0.3") == 0)
check("prerelease 小于正式版", rp.compare_semver("2.0.0-beta.1", "2.0.0") == -1)
check("正式版大于 prerelease", rp.compare_semver("2.0.0", "2.0.0-beta.1") == 1)
check("alpha < beta", rp.compare_semver("2.0.0-alpha", "2.0.0-beta.2") == -1)
check("beta.2 < beta.11 按数字比较", rp.compare_semver("2.0.0-beta.2", "2.0.0-beta.11") == -1)
check("beta.1 < beta.alpha 数字段优先", rp.compare_semver("2.0.0-beta.1", "2.0.0-beta.alpha") == -1)

# --------------------------------------------------------------------------- #
# package.json
# --------------------------------------------------------------------------- #

PKG = """{
  "name": "demo",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "demo-dep": {
      "version": "9.9.9"
    }
  }
}
"""

bumped = rp.bump_package_json(PKG, "1.1.0")
parsed = json.loads(bumped)
check("package.json 顶层版本已改", parsed["version"] == "1.1.0", parsed["version"])
check(
    "package.json 嵌套 version 不动",
    parsed["dependencies"]["demo-dep"]["version"] == "9.9.9",
    parsed["dependencies"]["demo-dep"]["version"],
)
check("package.json 仍可解析且字段完整", parsed["name"] == "demo" and parsed["private"] is True)

# --------------------------------------------------------------------------- #
# Cargo.toml
# --------------------------------------------------------------------------- #

CARGO = """[package]
name = "luma"
version = "1.0.0"
edition = "2021"

[dependencies]
anyhow = "1.0"
serde = { version = "1.0.0", features = ["derive"] }
"""

cargo_bumped = rp.bump_cargo_toml(CARGO, "1.1.0")
check("Cargo.toml [package] 版本已改", rp.cargo_package_version(cargo_bumped) == "1.1.0")
check(
    "Cargo.toml 依赖里的 version 不动",
    'serde = { version = "1.0.0"' in cargo_bumped,
    "serde 的行被改写",
)
check_error("Cargo.toml 缺 [package] 时报错", lambda: rp.bump_cargo_toml("[dependencies]\nanyhow = \"1\"\n", "1.1.0"))

# --------------------------------------------------------------------------- #
# Cargo.lock
# --------------------------------------------------------------------------- #

LOCK = """version = 3

[[package]]
name = "luma"
version = "1.0.0"
dependencies = [
 "anyhow",
]

[[package]]
name = "anyhow"
version = "1.0.0"
"""

lock_bumped = rp.bump_cargo_lock(LOCK, "1.1.0")
check("Cargo.lock luma 版本已改", rp.lock_package_version(lock_bumped) == "1.1.0")
check(
    "Cargo.lock 其它包版本不动",
    'name = "anyhow"\nversion = "1.0.0"' in lock_bumped,
    "anyhow 块被改写",
)
check_error("Cargo.lock 缺目标包时报错", lambda: rp.bump_cargo_lock('[[package]]\nname = "other"\nversion = "1.0.0"\n', "1.1.0"))

# --------------------------------------------------------------------------- #
# CHANGELOG
# --------------------------------------------------------------------------- #

BASE_LOG = """# 变更日志

---

## [Unreleased]

### 新增
- 一条待发布内容

## [1.0.0] - 2026-01-01

### 修复
- 旧内容
"""

promoted, note = rp.prepare_changelog(BASE_LOG, "1.1.0", "2026-02-02")
check("提升后生成新版本段", "## [1.1.0] - 2026-02-02" in promoted, note)
check("提升后保留空 Unreleased", promoted.count("## [Unreleased]") == 1)
check(
    "提升后顺序为 Unreleased < 1.1.0 < 1.0.0",
    promoted.index("## [Unreleased]") < promoted.index("## [1.1.0]") < promoted.index("## [1.0.0]"),
)
check("正文只出现一次", promoted.count("- 一条待发布内容") == 1, "内容被复制而不是搬运")
check("旧版本内容保留", "- 旧内容" in promoted)

LOG_WITH_SECTION = """## [Unreleased]

## [1.1.0] - 2026-02-02

### 新增
- 已经写好的内容
"""

kept, note = rp.prepare_changelog(LOG_WITH_SECTION, "1.1.0", "2026-02-03")
check("已有版本段原样沿用", kept == LOG_WITH_SECTION)
check("沿用时的说明正确", "沿用" in note, note)
check("沿用时不改日期", "2026-02-03" not in kept)

LOG_EMPTY_SECTION = """## [Unreleased]

- 待发布内容

## [1.1.0] - 2026-02-02
"""
check_error(
    "已有版本段但正文为空时拒绝",
    lambda: rp.prepare_changelog(LOG_EMPTY_SECTION, "1.1.0", "2026-02-03"),
)

LOG_EMPTY_UNRELEASED = """## [Unreleased]

## [1.0.0] - 2026-01-01

- 旧内容
"""
check_error(
    "Unreleased 为空且无目标段时拒绝",
    lambda: rp.prepare_changelog(LOG_EMPTY_UNRELEASED, "1.1.0", "2026-02-03"),
)

check(
    "标准结构无告警",
    rp.changelog_warnings(BASE_LOG.replace("## [1.0.0]", "## [1.0.0]")) == [],
    str(rp.changelog_warnings(BASE_LOG)),
)

OUT_OF_ORDER = """## [1.0.0] - 2026-01-01

- a

## [Unreleased]

- b
"""
warnings = rp.changelog_warnings(OUT_OF_ORDER)
check(
    "Unreleased 不在最前时告警",
    any("Unreleased" in item for item in warnings),
    str(warnings),
)

DESCENDING_BROKEN = """## [Unreleased]

## [1.0.0] - 2026-01-01

## [2.0.0] - 2026-02-02
"""
warnings = rp.changelog_warnings(DESCENDING_BROKEN)
check(
    "版本段顺序错乱时告警",
    any("递减" in item for item in warnings),
    str(warnings),
)

# --------------------------------------------------------------------------- #
# 工作区状态判定
# --------------------------------------------------------------------------- #

blocked, others = rp.classify_status(
    [
        " M src-tauri/Cargo.toml",
        " M CHANGELOG.md",
        "?? tools/scratch.py",
    ]
)
check("版本载体脏改动被拦截", any("Cargo.toml" in line for line in blocked), str(blocked))
check("CHANGELOG 未提交不拦截", not any("CHANGELOG" in line for line in blocked + others), str(blocked + others))
check("无关文件仍算脏", any("scratch.py" in line for line in others), str(others))

blocked, others = rp.classify_status([" M package.json", " M CHANGELOG.md"])
check("仅 CHANGELOG 与版本载体混合时只拦载体", blocked == [" M package.json"], str(blocked))
check("仅 CHANGELOG 时其它文件为空", others == [], str(others))

# --------------------------------------------------------------------------- #
# 结果
# --------------------------------------------------------------------------- #

if PROBLEMS:
    print("RELEASE PREP MISMATCH")
    for item in PROBLEMS:
        print("  -", item)
    raise SystemExit(1)

print(f"RELEASE PREP OK: {ASSERTIONS} assertions")
