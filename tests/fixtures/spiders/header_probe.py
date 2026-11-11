"""Class-attribute header inheritance probe (network-free).

This fixture inherits the REAL `base.spider.Spider` and declares a custom
`header` as a CLASS attribute — exactly the pattern Douban / 4KAV / shanzha /
shortfilm / 农民影视 / 嗨皮影视 use. It then echoes the effective header back
inside `homeVideoContent`'s list, so a window probe can assert over the true
Rust -> pyspider -> pyrun -> base.spider chain:

  * framework fixed  -> `self.header` keeps the subclass value ->
    vod_name == "LumaProbeUA|class-attr-alive"
  * framework regressed (old `self.header = {DEFAULT_UA}` in __init__) ->
    `self.header` is clobbered -> vod_name == "okhttp/3.15|MISSING"

It intentionally returns classes-only from `homeContent` (an empty list), so
it doubles as a strict home-split source for the homeVideoContent fallback.
"""

from base.spider import Spider


class Spider(Spider):  # noqa: F811 - shadow import, same as real community scripts
    header = {"User-Agent": "LumaProbeUA", "X-Probe": "class-attr-alive"}

    def init(self, extend=""):
        pass

    def _vod(self, vod_id, name):
        return {
            "vod_id": vod_id,
            "vod_name": name,
            "vod_pic": "http://127.0.0.1:8787/poster.jpg",
            "vod_remarks": "header 探针",
            "vod_play_from": "headerprobe",
            "vod_play_url": "第1集$http://127.0.0.1:8787/play.m3u8",
        }

    def homeContent(self, filter):  # noqa: A002 - TVBox signature
        return {
            "class": [{"type_id": "hp_hot", "type_name": "探针热门"}],
            "list": [],
        }

    def homeVideoContent(self):
        # Echo the effective header: this is the assertion target. If the
        # framework clobbers the class attribute, X-Probe is absent.
        ua = self.header.get("User-Agent", "MISSING")
        probe = self.header.get("X-Probe", "MISSING")
        return {"list": [self._vod("header-1", f"{ua}|{probe}")]}

    def categoryContent(self, tid, pg, filter, extend):  # noqa: A002
        return {"list": [self._vod(f"hp-{tid}-{pg}", "探针分类影片")], "page": 1, "pagecount": 1, "limit": 20, "total": 1}

    def detailContent(self, ids):
        return {"list": [self._vod("header-1", "探针详情影片")]}

    def searchContent(self, key, quick, pg):  # noqa: A002
        return {"list": [self._vod("hp-search", f"探针搜索 {key}")], "page": 1, "pagecount": 1, "limit": 20, "total": 1}

    def playerContent(self, flag, id, vipFlags):
        return {"parse": 0, "playUrl": "http://127.0.0.1:8787/play.m3u8", "url": "http://127.0.0.1:8787/play.m3u8", "header": {}}

    def localProxy(self, param):
        return [200, "video/MP2T", b"", ""]
