#!/usr/bin/env python3
"""文档事实校验：把易漂移的数字钉在代码事实源上。

只校验「有唯一事实源、却靠人手抄进文档」的数量：

- command 闭集      = `src-tauri/src/lib.rs` 里 `generate_handler![…]` 的条目数
- 探针脚本数        = `tools/{probes,verify,diag,audit}/*.mjs`
- 探针注册数        = `tools/run_probes.mjs` 的 `PROBES` 条目（含 optIn）
- 前端测试文件数    = `src/**/*.test.ts(x)` + `tests/frontend/*.test.ts`
- 门禁项数          = `tools/check.py` 的 `checks()` 长度（默认 / `--ci`）

锚点找不到也算失败：文档改了措辞就必须同步本脚本，否则校验会静默失效。

Usage:
    python tests/offline/docs_check.py
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROBLEMS: list[str] = []
ASSERTIONS = 0


def read(rel: str) -> str:
    return (ROOT / rel).read_text(encoding="utf-8")


def check(label: str, condition: bool, detail: str = "") -> None:
    global ASSERTIONS
    ASSERTIONS += 1
    if not condition:
        PROBLEMS.append(f"{label}: {detail}" if detail else label)


def count_mjs(directory: str) -> int:
    return len(list((ROOT / "tools" / directory).glob("*.mjs")))


def command_count() -> int:
    source = read("src-tauri/src/lib.rs")
    match = re.search(r"generate_handler!\[(.*?)\]", source, re.S)
    if match is None:
        raise SystemExit("lib.rs 里找不到 generate_handler![…]，文档校验锚点失效")
    body = match.group(1)
    entries = [line.strip().rstrip(",") for line in body.splitlines()]
    return len([line for line in entries if line and not line.startswith("//")])


def probe_registry() -> tuple[int, int]:
    """返回 (注册总数, optIn 数)。"""
    text = read("tools/run_probes.mjs")
    if "const PROBES = [" not in text:
        raise SystemExit("run_probes.mjs 里找不到 PROBES 数组，文档校验锚点失效")
    body = text.split("const PROBES = [", 1)[1].split("\n];", 1)[0]
    total = len(re.findall(r'\{\s*key:\s*"', body))
    opt_in = len(re.findall(r"optIn:\s*true", body))
    return total, opt_in


def check_count(doc: str, pattern: str, expected: int, label: str) -> None:
    """文档里所有命中 pattern 的数字都必须等于 expected；零命中视为锚点丢失。"""
    matches = re.findall(pattern, read(doc))
    if not matches:
        PROBLEMS.append(f"{doc}: 锚点丢失（{pattern}），文档措辞变了要同步 docs_check.py")
        return
    for raw in matches:
        value = raw if isinstance(raw, str) else raw[0]
        check(f"{doc} · {label}", int(value) == expected, f"写 {value}，实际 {expected}")


def check_ratio(doc: str, pattern: str, expected: int, label: str) -> None:
    """`N/N` 形式的自检计数：两侧都必须等于 expected。"""
    matches = re.findall(pattern, read(doc))
    if not matches:
        PROBLEMS.append(f"{doc}: 锚点丢失（{pattern}），文档措辞变了要同步 docs_check.py")
        return
    for left, right in matches:
        check(f"{doc} · {label}", left == right == str(expected), f"写 {left}/{right}，实际 {expected}/{expected}")


COMMANDS = command_count()
PROBES = count_mjs("probes")
VERIFY = count_mjs("verify")
DIAG = count_mjs("diag")
AUDIT = count_mjs("audit")
REGISTERED, OPT_IN = probe_registry()

SRC_TESTS = len(list((ROOT / "src").rglob("*.test.ts"))) + len(list((ROOT / "src").rglob("*.test.tsx")))
FRONTEND_TESTS = len(list((ROOT / "tests" / "frontend").glob("*.test.ts")))

SPEC = importlib.util.spec_from_file_location("luma_check", ROOT / "tools" / "check.py")
if SPEC is None or SPEC.loader is None:
    raise SystemExit("无法加载 tools/check.py")
check_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_module)
GATE = len(check_module.checks(full=False, quick=False))
CI_GATE = len(check_module.checks(full=False, quick=False, ci=True))

# --------------------------------------------------------------------------- #
# command 闭集
# --------------------------------------------------------------------------- #

for doc in ("AGENTS.md", "docs/spec.md", "docs/ARCHITECTURE.md", "docs/project-layout.md"):
    check_count(doc, r"(\d+)\s*个\s*command", COMMANDS, "command 数")
check_count("docs/MAINTENANCE.md", r"generate_handler!` 注册（当前 (\d+) 个）", COMMANDS, "command 数")

# --------------------------------------------------------------------------- #
# 探针：脚本数、注册数、各目录分工
# --------------------------------------------------------------------------- #

check_count("docs/DEVELOPMENT.md", r"`probes/`\s*(\d+)\s*个", PROBES, "probes 数")
check_count("docs/DEVELOPMENT.md", r"`verify/`\s*(\d+)\s*个", VERIFY, "verify 数")
check_count("docs/DEVELOPMENT.md", r"`diag/`\s*(\d+)\s*个", DIAG, "diag 数")
check_count("docs/DEVELOPMENT.md", r"`audit/`\s*(\d+)\s*个", AUDIT, "audit 数")
check_count("docs/TESTING.md", r"窗口回归探针（(\d+) 个", PROBES, "probes 数")
check_count("docs/project-layout.md", r"probe_\*\.mjs（(\d+) 个", PROBES, "probes 数")
check_count("docs/project-layout.md", r"verify_\*\.mjs（(\d+) 个", VERIFY, "verify 数")

check_count("docs/DEVELOPMENT.md", r"注册 (\d+) 支", REGISTERED, "注册探针数")
check_count("docs/project-layout.md", r"注册 (\d+) 支", REGISTERED, "注册探针数")
for doc in ("docs/DEVELOPMENT.md", "docs/project-layout.md"):
    text = read(doc)
    if f"`ui` 为 optIn" not in text:
        PROBLEMS.append(f"{doc}: 缺少「`ui` 为 optIn」说明；若 optIn 机制改名，请同步 docs_check.py")
check("run_probes 注册表 optIn 只有 ui", OPT_IN == 1, f"optIn 条目 {OPT_IN} 个")

# --------------------------------------------------------------------------- #
# 前端测试文件
# --------------------------------------------------------------------------- #

check_count("docs/DEVELOPMENT.md", r"同目录 (\d+) 个", SRC_TESTS, "src 测试文件数")
check_count("docs/DEVELOPMENT.md", r"tests/frontend (\d+) 个", FRONTEND_TESTS, "tests/frontend 文件数")

# --------------------------------------------------------------------------- #
# 门禁项数
# --------------------------------------------------------------------------- #

check_ratio("AGENTS.md", r"`python tools/check\.py`\s*(\d+)/(\d+)", GATE, "门禁项数")
check_ratio("docs/RELEASING.md", r"`python tools/check\.py`\s*\*\*(\d+)/(\d+) 全绿\*\*", GATE, "门禁项数")
check_ratio("docs/TESTING.md", r"`python tools/check\.py`\s*(\d+)/(\d+)", GATE, "门禁项数")

def check_ci_count(doc: str, expected: int) -> None:
    """`--ci` 项数有两种常见措辞，任一命中即可，但命中处必须写对。"""
    text = read(doc)
    found = (
        re.findall(r"便携子集\**（(\d+) 项", text)
        + re.findall(r"(\d+) 项便携子集", text)
        + re.findall(r"`?--ci`?\s*(\d+) 项", text)
    )
    if not found:
        PROBLEMS.append(f"{doc}: 锚点丢失（--ci 项数），文档措辞变了要同步 docs_check.py")
        return
    for value in found:
        check(f"{doc} · `--ci` 项数", int(value) == expected, f"写 {value}，实际 {expected}")


for doc in (
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/MAINTENANCE.md",
    "docs/RELEASING.md",
    "docs/project-layout.md",
    "docs/spec.md",
):
    check_ci_count(doc, CI_GATE)

# --------------------------------------------------------------------------- #

if PROBLEMS:
    print("DOCS MISMATCH")
    for item in PROBLEMS:
        print("  -", item)
    raise SystemExit(1)

print(
    f"DOCS OK: {ASSERTIONS} assertions "
    f"(commands={COMMANDS}, probes={PROBES}/{REGISTERED} registered, "
    f"verify={VERIFY}, diag={DIAG}, audit={AUDIT}, "
    f"tests={SRC_TESTS}+{FRONTEND_TESTS}, gate={GATE}/{CI_GATE})"
)
