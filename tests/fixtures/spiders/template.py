"""Self-made py spider template for P1 acceptance (spec T-15).

It never touches the network: every URL points at the local stub server, so the
fixture is safe to keep in the repository. The class name and method signatures
follow the TVBox convention; `pyrun.py` instantiates it with the site `ext`.
"""


class Spider:
    def __init__(self, ext):
        self.ext = ext or ""
        self.base = "http://127.0.0.1:8787"

    def _vod(self, vod_id, name):
        return {
            "vod_id": vod_id,
            "vod_name": name,
            "vod_pic": self.base + "/poster.jpg",
            "vod_remarks": "PY 模板",
            "type_name": "PY 分类",
            "vod_play_from": "py",
            "vod_play_url": "第1集$" + self.base + "/play.m3u8",
        }

    def homeContent(self, filter):  # noqa: A002 - TVBox signature
        return {
            "class": [{"type_id": "py_home", "type_name": "PY 分类"}],
            "list": [self._vod("py-1", "PY 首页影片")],
            "ext": self.ext,
        }

    def homeVideoContent(self):
        return {"list": []}

    def categoryContent(self, tid, pg, filter, extend):  # noqa: A002
        page = int(pg or 1)
        return {
            "list": [self._vod(f"py-{tid}-{page}", f"PY 分类 {tid} 第 {page} 页")],
            "page": page,
            "pagecount": 3,
            "limit": 20,
            "total": 3,
        }

    def detailContent(self, ids):
        vod_id = ids[0] if isinstance(ids, list) and ids else "py-1"
        return {"list": [self._vod(vod_id, f"PY 详情 {vod_id}")]}

    def searchContent(self, key, quick, pg):
        return {
            "list": [self._vod(f"py-search-{key}", f"PY 搜索 {key}")],
            "page": int(pg or 1),
            "pagecount": 1,
            "limit": 20,
            "total": 1,
        }

    def playerContent(self, flag, pid, vip_flags):
        return {
            "parse": 0,
            "url": self.base + "/play.m3u8",
            "header": {"Referer": self.base + "/"},
            "flag": flag,
            "ext": self.ext,
        }

    def liveContent(self, url):
        return {
            "class": [{"type_id": "py_live", "type_name": "PY 直播"}],
            "list": [
                {
                    "group": "PY 直播",
                    "channels": [
                        {"name": "PY 频道", "urls": [self.base + "/play.m3u8"]}
                    ],
                }
            ],
        }
