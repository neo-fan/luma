"""Self-made py spider that ignores deadlines, for timeout assertions (T-17/T-19).

`homeContent` sleeps far longer than the per-source wall clock, so Rust must kill
the child process instead of waiting for a cooperative cancel.
"""

import time


class Spider:
    def __init__(self, ext):
        self.ext = ext or ""

    def homeContent(self, filter):  # noqa: A002 - TVBox signature
        time.sleep(30)
        return {"class": [], "list": []}

    def categoryContent(self, tid, pg, filter, extend):  # noqa: A002
        time.sleep(30)
        return {"list": []}

    def detailContent(self, ids):
        time.sleep(30)
        return {"list": []}

    def searchContent(self, key, quick, pg):
        time.sleep(30)
        return {"list": []}

    def playerContent(self, flag, pid, vip_flags):
        time.sleep(30)
        return {}

    def liveContent(self, url):
        time.sleep(30)
        return {}
