#!/usr/bin/env python3
"""Local stub server for P0/T-05 verification (spec 12.1).

Serves six configuration shapes plus CMS / live / play endpoints. Every target
is 127.0.0.1; no external host is referenced. Standard library only.

Usage:
    python3 tests/stub_server.py [--port 8787]
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = b"tvbox-stub-key"
SPIDER_JAR = "http://127.0.0.1:{port}/spider.jar"

SITES = [
    {
        "key": "stub_json",
        "name": "Stub JSON CMS",
        "type": 1,
        "api": "http://127.0.0.1:{port}/cms/vod",
        "searchable": 1,
        "quickSearch": 1,
        "filterable": 1,
    },
    {
        "key": "stub_xml",
        "name": "Stub XML CMS",
        "type": 0,
        "api": "http://127.0.0.1:{port}/cms/xml",
        "searchable": 0,
    },
    {
        "key": "stub_py",
        "name": "Stub Python",
        "jar": "py",
        "api": "http://127.0.0.1:{port}/spider/template.py",
        "ext": "stub-ext-py",
    },
    {
        "key": "stub_js",
        "name": "Stub JS",
        "jar": "js",
        "api": "http://127.0.0.1:{port}/spider/template.js",
    },
    {
        "key": "csp_stub",
        "name": "Stub Jar",
        "jar": "http://127.0.0.1:{port}/spider.jar",
        "ext": "stub-ext-jar",
    },
    {
        "key": "stub_probe",
        "name": "Stub Probe",
        "type": 3,
        "api": "http://127.0.0.1:{port}/probe",
        "ext": "x" * 36,
        "style": {"type": "rect"},
        "indexs": [{"name": "index1", "value": "1"}],
        "timeout": 20,
        "playerType": 1,
        "changeable": 1,
        "customFlag": "kept-in-raw",
    },
]

LIVES = [
    {
        "name": "Stub Live",
        "type": 0,
        "url": "http://127.0.0.1:{port}/live/list.m3u",
        "playerType": 1,
        "timeZone": "Asia/Shanghai",
        "ua": "okhttp/3.15",
    }
]

PARSES = [
    {
        "name": "Stub Parse",
        "type": 1,
        "url": "http://127.0.0.1:{port}/parse",
        "ext": {"flag": ["qq"]},
    }
]

M3U = """#EXTM3U
#EXTINF:-1 tvg-name="Stub One" group-title="Stub",Stub One
http://127.0.0.1:{port}/play.m3u8
#EXTINF:-1 tvg-name="Stub Two" group-title="Stub",Stub Two
http://127.0.0.1:{port}/play.m3u8
"""

PLAYLIST = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2.0,
seg0.ts
#EXT-X-ENDLIST
"""


def standard(port: int) -> dict:
    return {
        "spider": SPIDER_JAR.format(port=port) + ";md5;00000000000000000000000000000000",
        "wallpaper": f"http://127.0.0.1:{port}/wallpaper.jpg",
        "sites": json.loads(json.dumps(SITES).replace("{port}", str(port))),
        "lives": json.loads(json.dumps(LIVES).replace("{port}", str(port))),
        "parses": PARSES,
        "flags": ["qq", "youku"],
        "rules": [{"name": "stub", "hosts": [f"127.0.0.1:{port}"], "regex": ["127\\.0\\.0\\.1/cms/"]}],
        "hosts": [f"127.0.0.1:{port}"],
        "logo": f"http://127.0.0.1:{port}/logo.png",
    }


def dialect(port: int) -> dict:
    """Same config with community aliases: list / parse / global jar."""
    base = standard(port)
    sites = base["sites"]
    for site in sites:
        if site["key"] == "stub_probe":
            site["title"] = site.pop("name")
    return {
        "jar": base["spider"],
        "list": sites,
        "parse": base["parses"],
        "lives": base["lives"],
        "wallpaper": base["wallpaper"],
    }


def repos(port: int) -> dict:
    return {
        "urls": [
            {"url": f"http://127.0.0.1:{port}/config.json", "name": "Stub Repo A"},
            {"url": f"http://127.0.0.1:{port}/config-dialect.json", "name": "Stub Repo B"},
            {"url": f"http://127.0.0.1:{port}/missing.json", "name": "Stub Repo Broken"},
        ]
    }


def xor(data: bytes, key: bytes) -> bytes:
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


def encrypted_shell(port: int) -> bytes:
    payload = json.dumps(standard(port), ensure_ascii=False).encode("utf-8")
    return b"****" + base64.b64encode(xor(payload, KEY))


def b64_config(port: int) -> bytes:
    return base64.b64encode(json.dumps(standard(port), ensure_ascii=False).encode("utf-8"))


def gzip_b64_config(port: int) -> bytes:
    raw = json.dumps(standard(port), ensure_ascii=False).encode("utf-8")
    return base64.b64encode(gzip.compress(raw, 9))


def make_routes(port: int) -> dict[str, tuple[bytes, str]]:
    as_json = lambda obj: (json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
    return {
        "/config.json": as_json(standard(port)),
        "/config-dialect.json": as_json(dialect(port)),
        "/config-repos.json": as_json(repos(port)),
        "/config-b64.txt": (b64_config(port), "text/plain; charset=utf-8"),
        "/config-gzip.txt": (gzip_b64_config(port), "text/plain; charset=utf-8"),
        "/config-encrypted.txt": (encrypted_shell(port), "text/plain; charset=utf-8"),
        "/cms/vod": as_json(
            {
                "code": 1,
                "list": [
                    {
                        "vod_id": "1",
                        "vod_name": "Stub Movie",
                        "vod_pic": f"http://127.0.0.1:{port}/poster.jpg",
                        "vod_remarks": "HD",
                        "vod_play_from": "stub",
                        "vod_play_url": "第1集$http://127.0.0.1:{port}/play.m3u8".format(port=port),
                    }
                ],
                "page": 1,
                "pagecount": 1,
                "limit": 20,
                "total": 1,
            }
        ),
        "/cms/xml": (
            b'<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><list page="1" pagecount="1" pagesize="20" recordcount="0"></list></rss>',
            "application/xml; charset=utf-8",
        ),
        "/live/list.m3u": (M3U.format(port=port).encode("utf-8"), "audio/x-mpegurl"),
        "/play.m3u8": (PLAYLIST.encode("utf-8"), "application/vnd.apple.mpegurl"),
        "/spider.jar": (b"PK\x03\x04stub", "application/java-archive"),
        "/probe": as_json({"code": 1, "list": []}),
        "/parse": as_json({"code": 200, "url": f"http://127.0.0.1:{port}/play.m3u8"}),
        "/wallpaper.jpg": (b"\xff\xd8\xff\xd9", "image/jpeg"),
        "/logo.png": (b"\x89PNG\r\n\x1a\n", "image/png"),
        "/poster.jpg": (b"\xff\xd8\xff\xd9", "image/jpeg"),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "TVBoxStub/1.0"

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        routes = self.server.routes  # type: ignore[attr-defined]
        body, ctype = routes.get(path, (b"not found", "text/plain; charset=utf-8"))
        self.send_response(200 if path in routes else 404)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[stub] {self.address_string()} {fmt % args}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.routes = make_routes(args.port)  # type: ignore[attr-defined]
    print(f"stub server on http://{args.host}:{args.port} ({len(server.routes)} routes)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
