"""Strict TVBox home-split spider fixture (no network).

Reproduces the Douban-style contract split deterministically, so the
`homeVideoContent` fallback can be regression-tested without depending on any
external API or a third-party script's header quirks:

  * `homeContent` returns classes only, with an empty list;
  * `homeVideoContent` returns the actual recommendation list.

If the client only calls `homeContent` (the old behaviour), the home grid is
empty. With the fallback, it renders the two cards below.
"""


class Spider:
    def __init__(self, ext):
        self.ext = ext or ""

    def _vod(self, vod_id, name):
        return {
            "vod_id": vod_id,
            "vod_name": name,
            "vod_pic": "http://127.0.0.1:8787/poster.jpg",
            "vod_remarks": "严格分家 fixture",
            "vod_play_from": "strict",
            "vod_play_url": "第1集$http://127.0.0.1:8787/play.m3u8",
        }

    def homeContent(self, filter):  # noqa: A002 - TVBox signature
        # 严格按协议：只给分类，推荐列表交给 homeVideoContent。
        return {
            "class": [
                {"type_id": "strict_hot", "type_name": "严格热门"},
                {"type_id": "strict_new", "type_name": "严格最新"},
            ],
            "list": [],
        }

    def homeVideoContent(self):
        return {"list": [self._vod("strict-1", "严格首页影片甲"), self._vod("strict-2", "严格首页影片乙")]}

    def categoryContent(self, tid, pg, filter, extend):  # noqa: A002
        return {"list": [self._vod(f"strict-{tid}-{pg}", "严格分类影片")], "page": 1, "pagecount": 1, "limit": 20, "total": 1}

    def detailContent(self, ids):
        return {"list": [self._vod("strict-1", "严格详情影片")]}

    def searchContent(self, key, quick, pg):  # noqa: A002
        return {"list": [self._vod("strict-search", f"严格搜索 {key}")], "page": 1, "pagecount": 1, "limit": 20, "total": 1}

    def playerContent(self, flag, id, vipFlags):
        return {"parse": 0, "playUrl": "http://127.0.0.1:8787/play.m3u8", "url": "http://127.0.0.1:8787/play.m3u8", "header": {}}

    def localProxy(self, param):
        return [200, "video/MP2T", b"", ""]
