#!/usr/bin/env python3
"""Offline regression for real-world (box.json-style) config compatibility.

Stub fixtures use absolute URLs and self-contained spiders; community configs
do not. This script locks down the two gaps that make a real config look broken:

* relative `./py/*.py`, `./jar/*.jar`, `./lib/*.m3u` references;
* the vendored `base.spider` framework (BOM source, zero-arg `__init__`,
  `init(ext)` hook and `self.html(...).xpath(...)`).

No network access is needed. Usage:  python tests/offline/config_compat.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PY = ROOT / "sidecars" / "py"
sys.path.insert(0, str(PY))

from normalize import normalize_config  # noqa: E402

ORIGIN = "https://example.com/tvbox/deadbeef/box.json"
BASE = "https://example.com/tvbox/deadbeef/"
PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}  {detail}")


def test_relative_paths() -> None:
    raw = {
        "spider": "./jar/custom.jar",
        "sites": [
            {"key": "py_demo", "name": "PY", "api": "./py/demo.py", "ext": "./py/demo.json"},
            {"key": "cms_demo", "name": "CMS", "api": "https://cms.example/api.php/provide/vod"},
            {"key": "csp_XBPQ", "name": "XBPQ", "api": "csp_XBPQ", "ext": '{"token":"x"}'},
        ],
        "lives": [{"name": "live", "url": "./lib/iptv.m3u"}],
        "parses": [{"name": "p", "url": "./js/parse.js"}],
    }
    snap = normalize_config(raw, ORIGIN)
    sites = {site["key"]: site for site in snap["sites"]}

    check("global spider resolved", snap["spider"] == BASE + "jar/custom.jar", str(snap["spider"]))
    check(
        "py site api resolved and routed",
        sites["py_demo"]["api"] == BASE + "py/demo.py" and sites["py_demo"]["runtime"] == "python",
        json.dumps(sites["py_demo"], ensure_ascii=False)[:160],
    )
    check(
        "absolute api untouched",
        sites["cms_demo"]["api"] == "https://cms.example/api.php/provide/vod",
        str(sites["cms_demo"]["api"]),
    )
    check(
        "bare csp class name and inline ext untouched",
        sites["csp_XBPQ"]["api"] == "csp_XBPQ" and sites["csp_XBPQ"]["ext"] == '{"token":"x"}',
        json.dumps(sites["csp_XBPQ"], ensure_ascii=False)[:160],
    )
    check("live playlist resolved", snap["lives"][0]["url"] == BASE + "lib/iptv.m3u")
    check("parse script resolved", snap["parses"][0]["url"] == BASE + "js/parse.js")
    check("inline configs have no base to resolve against",
          normalize_config({"sites": [{"key": "x", "api": "./py/x.py"}]}, "inline")["sites"][0]["api"] == "./py/x.py")


def pyrun(source: str, method: str = "homeContent", args: list | None = None) -> dict:
    payload = {
        "source": source,
        "className": "Spider",
        "method": method,
        "args": args if args is not None else [True],
        "ext": "ext-token",
    }
    completed = subprocess.run(
        [sys.executable, str(PY / "pyrun.py")],
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
    test_relative_paths()
    test_python_framework()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
