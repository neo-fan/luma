"""TVBox 第三方 py 脚本「通用兼容」离线断言（不依赖窗口 / 桩服务）。

守住 4 类真实配置踩过的坑，防止以后逐个打补丁式回归：

1. 站点脚本 `class Spider:` 未继承 base 且缺标准方法 → 宿主要返回空信封，
   而不是 AttributeError（TVBox Java 端对不可搜索源就是这么处理的）；
2. `searchContent` 返回 bound method 等非 JSON 值 → 进程边界必须能序列化并
   记录字段路径，不能让子进程「produced no frame」把原因吞掉；
3. 相对路径 `/v1/...` → 用类级 `host` 或 `ext` 里的站点地址补成绝对 URL；
4. 任何脚本异常都要带 traceback 落盘到 `LUMA_ADAPTER_LOG`，便于复盘。

运行： `python tests/e2e/py_compat_check.py`
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PY = ROOT / "sidecars" / "py"
sys.path.insert(0, str(PY))

LOG = Path(tempfile.gettempdir()) / f"luma-py-compat-{os.getpid()}.log"
LOG.unlink(missing_ok=True)
os.environ["LUMA_ADAPTER_LOG"] = str(LOG)

from base.spider import Spider  # noqa: E402
from pyspider import run as run_py_spider  # noqa: E402

PASS = 0
FAIL = 0


def check(ok: bool, group: str, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  [{group}] {name}")
    else:
        FAIL += 1
        print(f"FAIL  [{group}] {name}  {detail}")


def frame(payload: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, str(PY / "pyrun.py")],
        input=json.dumps(payload).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=20,
        check=False,
    )
    lines = proc.stdout.decode("utf-8").strip().splitlines()
    if not lines:
        raise RuntimeError(f"no frame: {proc.stderr.decode('utf-8', 'replace')[-300:]}")
    return json.loads(lines[-1])


def main() -> int:
    # 1) 缺标准方法 → 空信封（原先报 'Spider' object has no attribute 'searchContent'）
    missing = "class Spider:\n    def homeContent(self, filter):\n        return {'class': [], 'list': []}\n"
    f = frame({"source": missing, "method": "searchContent", "args": ["x", False, "1"]})
    check(f.get("ok") and f.get("result") == {"list": []}, "method", "missing searchContent -> empty envelope", str(f))

    # 2) 非 JSON 返回值 → 边界净化 + 安全空页（原先 "'method' object is not iterable"）
    unsafe = (
        "class Spider:\n"
        "    def searchContent(self, key, quick, pg):\n"
        "        return {'list': self.helper}\n"
        "    def helper(self):\n"
        "        return 1\n"
    )
    try:
        out = run_py_spider(
            {"source": unsafe, "method": "searchContent", "args": ["x", False, "1"], "api": "https://cfg/unsafe.py"}
        )
        check(isinstance(out, dict) and out.get("list") == [], "shape", "bound method -> safe empty page", str(out))
    except Exception as exc:  # noqa: BLE001
        check(False, "shape", "bound method -> safe empty page", repr(exc))

    # 3) 无 scheme URL → 用 host / ext 兜底（原先 Invalid URL '/v1/...': No scheme supplied）
    class HostSpider(Spider):
        host = "https://example.com/base/"

    s = HostSpider("")
    check(
        s._absolutize("/v1/search?q=1") == "https://example.com/v1/search?q=1",
        "url",
        "relative URL resolved against class host",
        s._absolutize("/v1/search?q=1"),
    )
    ext_spider = Spider('{"site":"https://from-ext.example/api"}')
    check(
        ext_spider._absolutize("/v1/x") == "https://from-ext.example/v1/x",
        "url",
        "relative URL resolved against ext",
        ext_spider._absolutize("/v1/x"),
    )
    check(
        s._absolutize("https://other.example/a") == "https://other.example/a",
        "url",
        "absolute URL untouched",
    )

    # 4) 崩溃 → frame 带 trace，日志落盘带 api / traceback
    crash = "class Spider:\n    def searchContent(self, key, quick, pg):\n        raise RuntimeError('boom-from-source')\n"
    f = frame({"source": crash, "method": "searchContent", "args": ["x"], "api": "https://cfg/crash.py"})
    check(
        not f.get("ok") and "boom-from-source" in str(f.get("trace")),
        "log",
        "crash frame carries traceback",
        str(f.get("trace"))[:120],
    )
    try:
        run_py_spider({"source": crash, "method": "searchContent", "args": ["x"], "api": "https://cfg/crash.py"})
    except RuntimeError:
        pass

    text = LOG.read_text(encoding="utf-8") if LOG.exists() else ""
    check(bool(text), "log", "spider error log written", f"{len(text)} bytes")
    check("spider_crash" in text, "log", "log contains spider_crash")
    check("Traceback" in text, "log", "log contains traceback")
    check("https://cfg/crash.py" in text, "log", "log attributes crash to source api")
    check("missing_method" in text, "log", "capability gap logged")
    check("unsafe_result" in text and "$.list:method" in text, "log", "unsafe return logged with JSON path")

    print(f"\npy_compat_check: {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
