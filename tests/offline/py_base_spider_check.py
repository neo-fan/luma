"""py 框架与 TVBox 原生对齐的离线断言（不依赖桌面窗口 / 桩服务）。

背景：项目 vendored 了三份 TVBox 原生 `base.spider`（fongmi / box-main /
avbox），我们的 `sidecars/py/base/spider.py` 是子进程版复刻。本断言守住
「脚本执行效果一致」的关键契约，防止漂移回归：

1. `__init__` 不得覆盖子类 `header`/`headers` 类属性（豆瓣等 6 站自定义
   UA/Referer 被吞 → frodo 400 → 首页空的根因）；
2. `html()` 用 `etree.HTML`，对残缺 HTML 仍可 xpath（对齐 box/avbox）；
3. `fetch`/`post` 强制 `rsp.encoding='utf-8'`（否则中文站点 `.text` 乱码）；
4. 缓存 `setCache`/`delCache` 返回原生约定的 `succeed`；
5. 补齐的原生纯工具方法与协议空桩存在且行为正确。

豆瓣 `homeVideoContent` 经 frodo 接口出数据是「header 修复」的端到端铁证；
该项依赖外网，连不上记 N/A，不影响离线断言的 PASS/FAIL。

运行： `<python-embed>/python.exe tests/offline/py_base_spider_check.py`
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "sidecars" / "py"))

from base.spider import Spider  # noqa: E402
import base.spider as spider_mod  # noqa: E402

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


def na(group: str, name: str, detail: str = "") -> None:
    global NA
    NA += 1
    print(f"N/A   [{group}] {name}  {detail}")


def test_header_class_attribute() -> None:
    class DoubanLike(Spider):
        header = {"User-Agent": "WeChat-UA", "Referer": "https://frodo.douban.com"}

    s = DoubanLike()
    check(
        s._merge_headers(None).get("User-Agent") == "WeChat-UA"
        and s._merge_headers(None).get("Referer") == "https://frodo.douban.com",
        "header",
        "子类类属性 header 生效（不再被 __init__ 覆盖）",
        str(s.header),
    )
    s.header["X-Once"] = "1"
    check("X-Once" not in DoubanLike.header, "header", "header 为每实例副本，改动不串回类属性")

    class HeadersLike(Spider):
        headers = {"user-agent": "Custom-UA", "accept-language": "zh-CN"}

    check(HeadersLike().headers.get("user-agent") == "Custom-UA", "header", "子类类属性 headers 生效（4KAV/杉札等）")
    check(
        Spider().header.get("User-Agent") == "okhttp/3.15",
        "header",
        "未声明时回落默认 UA",
    )


def test_html_tolerant() -> None:
    s = Spider()
    tree = s.html("<div><ul><li>a</li><li>b</li>")
    check(
        tree is not None and len(tree.xpath("//li")) == 2,
        "html",
        "残缺 HTML 返回可 xpath 树（etree.HTML 对齐原生）",
    )
    check(s.html("   ") is None, "html", "空内容返回 None")


class _FakeResponse:
    encoding = "iso-8859-1"
    text = "x"
    content = b"x"
    status_code = 200


class _FakeSession:
    def request(self, *args: object, **kwargs: object) -> _FakeResponse:
        return _FakeResponse()


def test_encoding() -> None:
    # `fetch`/`post` only honour the injected `_session` when `requests` is
    # importable; without it the adapter deliberately falls back to urllib and
    # the fake session is bypassed — turning this offline check into a real DNS
    # lookup that can crash the gate. The bundled python-embed ships requests, so
    # run this file with it (`tools/check.py` does that).
    if spider_mod.requests is None:
        # check.py always uses the bundled interpreter. Silent N/A here used to
        # let the whole utf-8 group report PASS without running a single assertion.
        check(False, "http", "requests 可用", "请用 sidecars/python-embed 或安装 requests 后运行")
        return
    s = Spider()
    s._session = _FakeSession()  # type: ignore[assignment]
    check(s.fetch("http://x").encoding == "utf-8", "http", "fetch() 强制 rsp.encoding=utf-8")
    check(s.post("http://x", data={"a": 1}).encoding == "utf-8", "http", "post() 强制 rsp.encoding=utf-8")
    check(
        s.fetch("http://x", headers={"X": "Y"}) is not None,
        "http",
        "fetch() headers 参数可用",
    )


def test_cache_contract() -> None:
    s = Spider()
    check(s.setCache("k", "v") == "succeed", "cache", "setCache 返回 succeed")
    check(s.getCache("k") == "v", "cache", "getCache 取值")
    check(s.delCache("k") == "succeed" and s.getCache("k") is None, "cache", "delCache 返回 succeed 且真删")
    check(s.getCache("none", default=42) == 42, "cache", "getCache default 生效")


def test_native_helpers() -> None:
    s = Spider()
    check(s.str2json('{"a":1}') == {"a": 1} and s.json2str({"a": 1}) == '{"a": 1}', "util", "str2json/json2str")
    check(s.json_loads("[1,2]") == [1, 2], "util", "json_loads 别名")
    check(s.removeHtmlTags("<b>x</b>y") == "xy", "util", "removeHtmlTags")
    check(s.cleanText("好😀") == "好", "util", "cleanText 去 emoji")
    check(s.regStr(r"(\d+)", "ab123cd") == "123", "util", "regStr box 顺序 (reg, src)")
    check(s.regStr("ab123cd", r"(\d+)") == "123", "util", "regStr avbox 顺序 (src, reg)")
    check(s.regStr(r"\d+", "ab123cd") == "123", "util", "regStr 无捕获组回退 group(0)")
    check(s.regStr(r"a\w+(\d+)c", "ab123cd", 1) == "3", "util", "regStr 位置 group 参数")
    from lxml import html as lhtml

    check(s.xpText(lhtml.fromstring("<p>hi</p>"), "//p") == "hi", "util", "xpText")
    check(s.isVideoFormat("http://x") is False, "stub", "isVideoFormat 空桩")
    check(s.manualVideoCheck() is False, "stub", "manualVideoCheck 空桩")
    check(s.getDependence() == [] and s.getName() == "", "stub", "getDependence/getName 空桩")
    check(s.action({}) == {} and s.destroy() is None, "stub", "action/destroy 空桩")
    check(s.localProxy({})[0] == 404 and s.proxy({})[0] == 404, "stub", "localProxy/proxy 空桩")

    # FongMi 语义：宿主调 proxy()，社区爬虫多只实现 localProxy()。基类 proxy 必须
    # 委派 localProxy，否则只实现 localProxy 的源（如央视频 yangshipin）永远拿 404。
    class _LocalOnly(Spider):
        def localProxy(self, param):
            return [200, "application/vnd.apple.mpegurl", b"#EXTM3U\n", {}]

    lp = _LocalOnly()
    check(lp.proxy({"type": "m3u8", "slug": "cctv2"})[0] == 200, "proxy", "proxy 委派 localProxy")
    check(s.page([1, 2, 3], 1, 2).get("total") == 3, "util", "page 工具（fongmi）")
    check("[a=cr:" in s.link("x", {"a": "b"}), "util", "link 工具（fongmi）")


def test_douban_real_source() -> None:
    """豆瓣是 header 覆盖 bug 的最直接受害者；顺带验证外网 frodo 链路。"""
    src_path = ROOT / "tests" / "fixtures" / "upstream" / "py-src" / "py_douban.py"
    if not src_path.is_file():
        na("douban", "豆瓣真实脚本回归", "参考副本不存在（不入库）")
        return
    try:
        source = src_path.read_text(encoding="utf-8").lstrip("\ufeff")
        module = types.ModuleType("douban")
        module.__dict__["__name__"] = "douban"
        exec(compile(source, "py_douban.py", "exec"), module.__dict__)  # noqa: S102
        spider = module.Spider("")  # type: ignore[call-arg]
    except Exception as exc:  # noqa: BLE001
        check(False, "douban", "豆瓣真实脚本可加载", str(exc))
        return

    try:
        home = spider.homeContent(False)
        check(
            len(home.get("class", [])) > 0 and len(home.get("list", [])) == 0,
            "douban",
            "homeContent 只给 class（严格分家，验证的是真场景）",
            f"class={len(home.get('class', []))} list={len(home.get('list', []))}",
        )
    except Exception as exc:  # noqa: BLE001
        check(False, "douban", "homeContent 可调用", str(exc))

    try:
        video = spider.homeVideoContent()
        if len(video.get("list", [])) > 0:
            check(True, "douban", "homeVideoContent 经 frodo 出推荐（header 修复铁证）", f"list={len(video['list'])}")
        else:
            na("douban", "homeVideoContent frodo 出推荐", "外网不可达或接口变更，离线不断言")
    except Exception as exc:  # noqa: BLE001
        na("douban", "homeVideoContent frodo 出推荐", f"外网异常：{exc}")


def main() -> int:
    test_header_class_attribute()
    test_html_tolerant()
    test_encoding()
    test_cache_contract()
    test_native_helpers()
    test_douban_real_source()
    print(f"\n=== py_base_spider_check: {PASS} passed, {FAIL} failed, {NA} n/a ===")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
