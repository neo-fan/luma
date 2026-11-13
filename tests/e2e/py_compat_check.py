"""TVBox 第三方 py 脚本「通用兼容」离线断言（不依赖窗口 / 桩服务）。

守住 4 类真实配置踩过的坑，防止以后逐个打补丁式回归：

1. 站点脚本 `class Spider:` 未继承 base 且缺标准方法 → 宿主要返回空信封，
   而不是 AttributeError（TVBox Java 端对不可搜索源就是这么处理的）；
2. `searchContent` 返回 bound method 等非 JSON 值 → 进程边界必须能序列化并
   记录字段路径，不能让子进程「produced no frame」把原因吞掉；
3. 相对路径 `/v1/...` → 用类级 `host` 或 `ext` 里的站点地址补成绝对 URL；
4. 任何脚本异常都要带 traceback 落盘到 `LUMA_ADAPTER_LOG`，便于复盘；
5. `detailContent` 返回空 / 单条 dict / `data|result|vod` 别名 → 边界统一归一，
   空结果必须记 `empty_detail`（含脚本 URL 与 vodId），否则 UI 那句
   「未获取到影片详情」无从复盘；
6. `adapterlog` 是诊断设施，绝不能成为硬依赖：嵌入版 CPython 的 `._pth`
   不会把脚本目录加进 sys.path，导入顺序错了会让所有 py 源
   `ModuleNotFoundError` 且「produced no frame」。

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

import cms  # noqa: E402
import pyspider  # noqa: E402
from base.spider import Spider  # noqa: E402
from pyrun import to_args  # noqa: E402
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

    # 5) detailContent 形状兼容 + 空结果日志（"未获取到影片详情" 的复盘依据）
    single = {"vod_id": "7", "vod_name": "走马上任", "vod_play_url": "1$https://x/1.m3u8"}
    for label, value in (
        ("bare list", [single]),
        ("list is one object", {"list": single}),
        ("root is a vod", single),
        ("data alias", {"data": [single]}),
        ("result alias", {"result": single}),
        ("vod alias", {"vod": [single]}),
        ("standard envelope", {"list": [single]}),
    ):
        got = pyspider._normalize("detailContent", value, "https://cfg/shape.py", "7")
        check(isinstance(got, list) and len(got) == 1 and got[0].get("vod_id") == "7",
              "detail", f"py shape: {label}", repr(got)[:160])

    for label, payload in (
        ("standard", {"list": [single]}),
        ("root vod", single),
        ("list object", {"list": single}),
        ("data wrapper", {"data": [single]}),
    ):
        got = cms.parse_detail({"raw": json.dumps(payload, ensure_ascii=False)})
        check(isinstance(got, list) and len(got) == 1, "detail", f"cms shape: {label}", repr(got)[:160])

    empty = pyspider._normalize("detailContent", {"list": []}, "https://cfg/douban.py", "36882191")
    check(empty == [], "detail", "genuinely empty detail stays empty")

    check(to_args("detailContent", "204658") == [["204658"]], "args",
          "string payload is not sliced into characters", str(to_args("detailContent", "204658")))
    check(to_args("detailContent", ["204658"]) == [["204658"]], "args", "standard list payload")

    # 6) 嵌入式 Python 子进程必须能 import 本地模块（曾经的全局回归）
    embed = ROOT / "sidecars" / "python-embed" / "python.exe"
    pyrun = (PY / "pyrun.py").read_text(encoding="utf-8")
    check(pyrun.index("sys.path.insert(0, _HERE)") < pyrun.index("from adapterlog import"),
          "embed", "pyrun fixes sys.path before local imports")
    check("except ImportError:" in pyrun and "def log_crash(**_kwargs" in pyrun,
          "embed", "missing adapterlog degrades to no-op")
    check('env["PYTHONPATH"]' in (PY / "pyspider.py").read_text(encoding="utf-8"),
          "embed", "child inherits adapter dir via PYTHONPATH")
    if embed.is_file():
        child = subprocess.run(
            [str(embed), str(PY / "pyrun.py")],
            input=json.dumps({"source": missing, "method": "detailContent", "args": ["7"]}).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False,
        )
        lines = child.stdout.decode("utf-8", "replace").strip().splitlines()
        check(bool(lines) and json.loads(lines[-1]).get("ok") is True,
              "embed", "embedded CPython child emits a frame",
              child.stderr.decode("utf-8", "replace")[-200:])

    text = LOG.read_text(encoding="utf-8") if LOG.exists() else ""
    check(bool(text), "log", "spider error log written", f"{len(text)} bytes")
    check('"kind": "empty_detail"' in text, "log", "empty detail logged")
    check("https://cfg/douban.py" in text and "36882191" in text, "log",
          "empty detail carries script url and vod id")
    check("spider_crash" in text, "log", "log contains spider_crash")
    check("Traceback" in text, "log", "log contains traceback")
    check("https://cfg/crash.py" in text, "log", "log attributes crash to source api")
    check("missing_method" in text, "log", "capability gap logged")
    check("unsafe_result" in text and "$.list:method" in text, "log", "unsafe return logged with JSON path")

    # ---- EPG：频道匹配与按天裁剪（真实节目单是 9 天整表，不裁会把 2000+ 条
    # 节目推给前端；而 `CCTV1` 用朴素子串匹配会把 CCTV11/12… 的节目收进来）。----
    from datetime import date, timedelta

    from live import parse_epg

    today = date.today().isoformat()
    today_key = today.replace("-", "")
    yesterday_key = (date.today() - timedelta(days=1)).isoformat().replace("-", "")
    tomorrow_key = (date.today() + timedelta(days=1)).isoformat().replace("-", "")
    epg = f"""<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="CCTV1"><display-name>CCTV1</display-name></channel>
  <channel id="CCTV11"><display-name>CCTV11</display-name></channel>
  <channel id="东方卫视"><display-name>东方卫视</display-name></channel>
  <programme channel="CCTV1" start="{today_key}230000 +0800" stop="{tomorrow_key}001000 +0800"><title>晚间新闻</title></programme>
  <programme channel="CCTV1" start="{yesterday_key}120000 +0800" stop="{yesterday_key}130000 +0800"><title>昨天的节目</title></programme>
  <programme channel="CCTV11" start="{today_key}200000 +0800" stop="{today_key}210000 +0800"><title>戏曲</title></programme>
  <programme channel="东方卫视" start="{today_key}193000 +0800" stop="{today_key}203000 +0800"><title>东方剧场</title></programme>
</tv>"""

    cctv1 = parse_epg(epg, "CCTV1", today)
    titles = [item["title"] for item in cctv1["programs"]]
    check(titles == ["晚间新闻"], "epg", "keeps only the requested day", str(titles))
    check("戏曲" not in titles, "epg", "CCTV1 does not swallow CCTV11 programmes")
    check(
        [item["title"] for item in parse_epg(epg, "CCTV-1 综合", today)["programs"]] == ["晚间新闻"],
        "epg",
        "aliases like CCTV-1 综合 resolve to CCTV1",
    )
    check(
        [item["title"] for item in parse_epg(epg, "东方卫视4K", today)["programs"]] == ["东方剧场"],
        "epg",
        "quality suffix is ignored when matching (东方卫视4K → 东方卫视)",
    )
    check(parse_epg(epg, "不存在的台", today)["programs"] == [], "epg", "unknown channel yields no programmes")

    print(f"\npy_compat_check: {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
