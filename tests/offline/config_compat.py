#!/usr/bin/env python3
"""Offline regression for the Python-source compatibility layer.

配置的方言归一化 / 相对地址解析已经搬进 Rust（`domain/config/normalize.rs`，
由 Rust 单测覆盖），适配层只剩「执行第三方脚本」这一条职责。所以这里只守
脚本执行侧的兼容性——社区 `.py` 源真实依赖的那几件事：

* 带 BOM 的源码（社区文件经常这么存）；
* `from base.spider import Spider` 与零参 `__init__`；
* `init(ext)` 钩子；
* `self.html(...).xpath(...)`。

No network access is needed. Usage:  python tests/offline/config_compat.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PY = ROOT / "sidecars" / "py"

PASS = 0
FAIL = 0

ORIGIN = "https://example.com/tvbox/deadbeef/box.json"
BASE = "https://example.com/tvbox/deadbeef/"
PASS = 0
FAIL = 0


def interpreter() -> str:
    """Child interpreter for `pyrun.py`.

    The spider needs `lxml` (for `self.html(...).xpath(...)`), which only the
    bundled embeddable ships. Prefer `LUMA_PYTHON` then the bundled binary so
    this script behaves the same when run with the host Python 3.14.
    """
    override = os.environ.get("LUMA_PYTHON")
    if override and Path(override).is_file():
        return override
    for name in ("python.exe", "python"):
        candidate = ROOT / "sidecars" / "python-embed" / name
        if candidate.is_file():
            return str(candidate)
    return sys.executable


PYTHON = interpreter()



def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}  {detail}")


def pyrun(source: str, method: str = "homeContent", args: list | None = None) -> dict:
    payload = {
        "source": source,
        "className": "Spider",
        "method": method,
        "args": args if args is not None else [True],
        "ext": "ext-token",
    }
    completed = subprocess.run(
        [PYTHON, str(PY / "pyrun.py")],
        input=json.dumps(payload).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
        check=False,
    )
    lines = completed.stdout.decode("utf-8", "replace").strip().splitlines()
    if not lines:
        raise RuntimeError(completed.stderr.decode("utf-8", "replace")[-300:])
    return json.loads(lines[-1])


def test_python_framework() -> None:
    # Deliberately prefixed with a BOM: community .py files are often saved that way.
    source = "\ufeff" + '''
from base.spider import Spider

class Spider(Spider):
    def init(self, ext):
        self.seen = ext

    def homeContent(self, filter):
        tree = self.html("<ul><li><a href='/v/1.html'>Demo</a></li></ul>")
        return {"list": [{"vod_id": "1", "vod_name": tree.xpath("//a/text()")[0], "ext": self.seen}]}
'''
    frame = pyrun(source)
    check("BOM source + base.spider import", frame.get("ok") is True, str(frame.get("error")))
    if frame.get("ok"):
        item = frame["result"]["list"][0]
        check("self.html().xpath() works", item["vod_name"] == "Demo", str(item))
        check("init(ext) hook receives ext", item["ext"] == "ext-token", str(item))

    no_arg = '''
class Spider:
    def __init__(self):
        self.ok = True

    def homeContent(self, filter):
        return {"list": [{"vod_id": "1", "vod_name": "ok" if self.ok else "bad"}]}
'''
    frame = pyrun(no_arg)
    check(
        "zero-arg __init__ spider",
        frame.get("ok") is True and frame["result"]["list"][0]["vod_name"] == "ok",
        str(frame.get("error")),
    )


def main() -> int:
    test_python_framework()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
