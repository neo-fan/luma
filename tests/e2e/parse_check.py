"""解析池与站点字段透传的离线断言（不依赖桌面窗口）。

覆盖三块：
1. `parses[]` 的归一化：相对路径按配置 origin 解析；
2. 站点字段透传：`playerType`/`changeable`/`order_num` 不再被归一化层吞掉；
3. 分组分隔条（`--- 1 ---`）不再被当成 jvm 站点。

真实配置（`.workbuddy/upstream/box.json`）存在时会额外做一次分运行时统计；
该文件不入库，缺失时记 N/A。
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecars" / "py"))

from normalize import normalize_config  # noqa: E402

PASS = 0
FAIL = 0
NA = 0


def check(ok: bool, group: str, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  [{group}] {name}")
    else:
        FAIL += 1
        print(f"FAIL  [{group}] {name}  {detail}")


def skip(group: str, name: str, why: str) -> None:
    global NA
    NA += 1
    print(f"N/A   [{group}] {name}  ({why})")


def record(group: str, name: str, detail: str) -> None:
    global PASS
    PASS += 1
    print(f"PASS  [{group}] {name}  {detail}")


def test_parse_normalization() -> None:
    cfg = {
        "name": "parse-fixture",
        "parses": [
            {"name": "jx-json", "type": 1, "url": "./jx/?url=", "ext": {"flag": ["qq"]}},
            {"name": "jx-web", "type": 0, "url": "./web/?url="},
            {"name": "super", "type": 4, "url": "https://super.example/?url="},
        ],
        "sites": [],
        "lives": [],
    }
    snap = normalize_config(cfg, "https://example.com/cfg/box.json")
    parses = snap["parses"]
    check(len(parses) == 3, "parse", "all parsers kept", str(len(parses)))
    check(
        parses[0]["url"] == "https://example.com/cfg/jx/?url=",
        "parse",
        "relative parser url resolved",
        parses[0]["url"],
    )
    check(parses[0]["type"] == 1, "parse", "type preserved", str(parses[0].get("type")))
    check(
        parses[0].get("ext", {}).get("flag") == ["qq"],
        "parse",
        "ext.flag preserved",
        json.dumps(parses[0].get("ext"), ensure_ascii=False),
    )
    check(
        parses[1]["url"].startswith("https://"),
        "parse",
        "web parser absolute",
        parses[1]["url"],
    )


def test_site_passthrough() -> None:
    cfg = {
        "parses": [],
        "sites": [
            {
                "key": "py_a",
                "name": "A",
                "api": "./py/a.py",
                "playerType": 2,
                "changeable": 0,
                "order_num": 3,
                "searchable": 1,
            },
            {
                "key": "py_b",
                "name": "B",
                "api": "./py/b.py",
                "changeable": 1,
            },
            {"key": "sep", "name": "--- 1 ---"},
        ],
        "lives": [],
    }
    snap = normalize_config(cfg, "https://example.com/box.json")
    sites = {site["key"]: site for site in snap["sites"]}

    a = sites["py_a"]
    check(a.get("playerType") == 2, "site", "playerType passes through", str(a.get("playerType")))
    check(a.get("changeable") is False, "site", "changeable 0 -> False", str(a.get("changeable")))
    check(a.get("orderNum") == 3, "site", "order_num -> orderNum", str(a.get("orderNum")))
    check(a.get("enabled") is True, "site", "real site stays enabled")

    b = sites["py_b"]
    check(b.get("changeable") is True, "site", "changeable 1 -> True", str(b.get("changeable")))

    sep = sites["sep"]
    check(sep.get("runtime") == "none", "site", "divider runtime is none", str(sep.get("runtime")))
    check(sep.get("enabled") is False, "site", "divider disabled", str(sep.get("enabled")))
    check("playerType" not in sep, "site", "divider has no phantom fields")


def test_real_config() -> None:
    raw = ROOT / ".workbuddy" / "upstream" / "box.json"
    if not raw.is_file():
        skip("real", "box.json runtime census", "local sample not checked in")
        return
    cfg = json.loads(raw.read_text(encoding="utf-8"))
    snap = normalize_config(
        cfg, "https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8/box.json"
    )
    sites = snap["sites"]
    counts: dict[str, int] = {}
    for site in sites:
        counts[site.get("runtime", "?")] = counts.get(site.get("runtime", "?"), 0) + 1
    enabled = sum(1 for site in sites if site.get("enabled"))

    check(len(snap["parses"]) == 21, "real", "21 parsers imported", str(len(snap["parses"])))
    check(counts.get("none") == 8, "real", "8 dividers detected", json.dumps(counts))
    check(counts.get("jvm") == 20, "real", "jvm count excludes dividers", str(counts.get("jvm")))
    check(enabled == 93, "real", "93 enabled sites", str(enabled))
    # `changeable: 0` 的站点禁止跨站换源；数据必须真的到达前端。
    blocked = [site for site in sites if site.get("changeable") is False]
    check(len(blocked) > 0, "real", "changeable:false reaches the snapshot", f"{len(blocked)} sites")
    record("real", "runtime census", json.dumps(counts, sort_keys=True))


def test_stub_parse_endpoint() -> None:
    """type 1 契约：GET `rule.url + playUrl` 返回 JSON 里的 url。"""
    base = "http://127.0.0.1:8787"
    proc = None
    try:
        urllib.request.urlopen(f"{base}/config.json", timeout=2).read()
    except OSError:
        proc = subprocess.Popen(
            [sys.executable, "tests/stub_server.py"],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.5)
    try:
        target = f"{base}/parse?url=http%3A%2F%2Fexample.com%2Fpage.html"
        body = json.loads(urllib.request.urlopen(target, timeout=5).read())
        check(bool(body.get("url")), "stub", "type-1 parser answers with url", json.dumps(body))
        check(
            "m3u8" in str(body.get("url")),
            "stub",
            "type-1 result is a stream",
            str(body.get("url")),
        )
    except (urllib.error.URLError, OSError, json.JSONDecodeError) as err:
        check(False, "stub", "type-1 parser reachable", str(err))
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()


def main() -> int:
    test_parse_normalization()
    test_site_passthrough()
    test_real_config()
    test_stub_parse_endpoint()
    print(f"\n{PASS} pass / {FAIL} fail / {NA} n-a")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
