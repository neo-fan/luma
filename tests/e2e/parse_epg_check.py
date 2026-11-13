"""parse_epg 回归测试：频道名匹配、时区换算、跨频道隔离、边界。

纯脚本风格（与 py_compat_check.py 一致）：assert 失败即非零退出。
运行：python tests/e2e/parse_epg_check.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sidecars", "py"))

from live import parse_epg

XML = """<tv>
  <channel id="cctv1"><display-name>CCTV-1</display-name><display-name>CCTV-1 综合</display-name></channel>
  <channel id="cctv5"><display-name>CCTV-5</display-name></channel>
  <programme channel="cctv1" start="20261113060000 +0800" stop="20261113070000 +0800"><title>朝闻天下</title><desc>早间新闻</desc></programme>
  <programme channel="cctv1" start="20261113070000 +0800" stop="20261113080000 +0800"><title>新闻联播重播</title></programme>
  <programme channel="cctv5" start="20261113060000 +0800"><title>体育晨报</title></programme>
</tv>"""


def test_exact_match():
    res = parse_epg(XML, "CCTV-1")
    assert res["channel"] == "CCTV-1"
    assert len(res["programs"]) == 2
    assert res["programs"][0]["title"] == "朝闻天下"
    assert res["programs"][0]["desc"] == "早间新闻"
    assert res["programs"][0]["start"] == "2026-11-13T06:00:00+08:00"


def test_alias_substring_match():
    # 别名命中走子串回退。
    res = parse_epg(XML, "CCTV-1 综合")
    assert len(res["programs"]) == 2


def test_other_channel_isolated():
    # 不同频道不能串台。
    res = parse_epg(XML, "CCTV-5")
    assert len(res["programs"]) == 1
    assert res["programs"][0]["title"] == "体育晨报"


def test_no_match():
    assert parse_epg(XML, "不存在的台")["programs"] == []


def test_empty_channel():
    assert parse_epg(XML, "")["programs"] == []


if __name__ == "__main__":
    test_exact_match()
    test_alias_substring_match()
    test_other_channel_isolated()
    test_no_match()
    test_empty_channel()
    print("parse_epg: all checks passed")
