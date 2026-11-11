"""TVBox python-spider framework (`base.spider`), vendored.

Every community py config ships spiders that start with

    from base.spider import Spider

and the host app normally injects that module. Our adapter runs spiders in a
child process, so the package lives here and is picked up through `sys.path`
(sidecars/py is the script directory of pyrun.py).

Only the surface that real configs touch is implemented: `fetch` / `post`
returning a requests-like response (`.text`, `.content`, `.json()`,
`.status_code`), plus cache, proxy helpers and logging.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any
from urllib.parse import quote, urljoin

try:  # requests is optional: fall back to urllib when it is absent.
    import requests
    from requests import Response
except Exception:  # noqa: BLE001 - optional dependency
    requests = None  # type: ignore[assignment]
    Response = Any  # type: ignore[misc,assignment]

DEFAULT_UA = "okhttp/3.15"


class TokenExpired(Exception):
    """Raised by spiders when a token/session must be refreshed."""


class _Cache:
    """Tiny TTL cache shared per spider instance."""

    def __init__(self) -> None:
        self._data: dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            hit = self._data.get(key)
            if not hit:
                return default
            expires, value = hit
            if expires and expires < time.time():
                self._data.pop(key, None)
                return default
            return value

    def set(self, key: str, value: Any, ttl: float = 0) -> Any:
        with self._lock:
            expires = time.time() + ttl if ttl else 0
            self._data[key] = (expires, value)
        return value


class Spider:
    """Base class matching the TVBox `base.spider.Spider` contract."""

    #: spiders frequently read/write these directly
    header: dict[str, str] = {"User-Agent": DEFAULT_UA}
    headers: dict[str, str] = {"User-Agent": DEFAULT_UA}

    def __init__(self, ext: Any = "", *args: Any, **kwargs: Any) -> None:
        self.ext = ext if ext is not None else ""
        self.extend = self.ext
        self.host = ""
        self.cache = _Cache()
        self._session = requests.Session() if requests is not None else None
        port = os.environ.get("LUMA_PROXY_PORT") or os.environ.get("TVBOX_PROXY_PORT") or ""
        self.proxy_port = int(port) if port.isdigit() else 0
        self.header = {"User-Agent": DEFAULT_UA}
        self.headers = self.header

        # TVBox's base class forwards construction to `init(extend)`; many configs
        # rely on that hook instead of overriding `__init__`.
        hook = getattr(self, "init", None)
        if callable(hook):
            try:
                hook(self.ext)
            except TypeError:
                hook()
        if not isinstance(getattr(self, "headers", None), dict):
            self.headers = {"User-Agent": DEFAULT_UA}
        if not isinstance(getattr(self, "header", None), dict):
            self.header = self.headers

    def init(self, extend: Any = "") -> None:
        """Subclass hook; TVBox calls this from `__init__`."""

    def html(self, content: Any, *args: Any, **kwargs: Any) -> Any:
        """Parse markup like TVBox's base class: `self.html(text).xpath(...)`.

        lxml elements already provide `.xpath()`, `.get()` and `.text`, which is
        exactly what community spiders expect. A missing lxml or malformed
        markup yields `None` so the spider can fail gracefully per source.
        """
        text = content if isinstance(content, str) else str(getattr(content, "text", "") or "")
        if not text.strip():
            return None
        try:
            from lxml import html as lxml_html

            return lxml_html.fromstring(text)
        except Exception:  # noqa: BLE001 - parser errors must stay source-local
            return None

    # ------------------------------------------------------------------ http
    @staticmethod
    def _timeout(value: Any) -> float:
        """Configs pass seconds (`15`) and milliseconds (`4000`) alike."""
        try:
            number = float(value)
        except (TypeError, ValueError):
            return 10.0
        if number > 100:  # milliseconds
            number /= 1000.0
        return max(1.0, min(number, 120.0))

    def _merge_headers(self, headers: Any) -> dict[str, str]:
        merged = dict(self.header or {})
        if isinstance(headers, dict):
            merged.update({str(k): str(v) for k, v in headers.items()})
        return merged

    def fetch(
        self,
        url: str,
        params: Any = None,
        cookies: Any = None,
        headers: Any = None,
        timeout: Any = 10,
        verify: bool = False,
        stream: bool = False,
        allow_redirects: bool = True,
        **kwargs: Any,
    ) -> Any:
        if requests is None:
            return _urllib_request(
                "GET",
                url,
                self._merge_headers(headers),
                self._timeout(timeout),
                params=params,
                data=None,
            )
        return self._session.request(
            "GET",
            url,
            params=params,
            cookies=cookies,
            headers=self._merge_headers(headers),
            timeout=self._timeout(timeout),
            verify=verify,
            stream=stream,
            allow_redirects=allow_redirects,
            **{k: v for k, v in kwargs.items() if k in {"proxies", "auth", "hooks"}},
        )

    def post(
        self,
        url: str,
        params: Any = None,
        data: Any = None,
        json: Any = None,
        cookies: Any = None,
        headers: Any = None,
        timeout: Any = 10,
        verify: bool = False,
        stream: bool = False,
        allow_redirects: bool = True,
        **kwargs: Any,
    ) -> Any:
        if requests is None:
            return _urllib_request(
                "POST",
                url,
                self._merge_headers(headers),
                self._timeout(timeout),
                params=params,
                data=data,
            )
        return self._session.request(
            "POST",
            url,
            params=params,
            data=data,
            json=json,
            cookies=cookies,
            headers=self._merge_headers(headers),
            timeout=self._timeout(timeout),
            verify=verify,
            stream=stream,
            allow_redirects=allow_redirects,
        )

    # ----------------------------------------------------------------- proxy
    def getProxyUrl(self, local: bool = True, *args: Any, **kwargs: Any) -> str:
        """Base address of the app's local proxy (playback helper)."""
        if not self.proxy_port:
            return ""
        return f"http://127.0.0.1:{self.proxy_port}/proxy?url="

    def _wrap(self, url: Any) -> Any:
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            return url
        if not self.proxy_port:
            return url
        return f"http://127.0.0.1:{self.proxy_port}/proxy?url={quote(url, safe='')}"

    def proxyMedia(self, url: Any, *args: Any, **kwargs: Any) -> Any:
        return self._wrap(url)

    def proxyM3u8(self, url: Any, *args: Any, **kwargs: Any) -> Any:
        return self._wrap(url)

    def proxyTs(self, url: Any, *args: Any, **kwargs: Any) -> Any:
        return self._wrap(url)

    # ------------------------------------------------------------ misc utils
    def getCache(self, key: str, default: Any = None) -> Any:
        return self.cache.get(key, default)

    def setCache(self, key: str, value: Any, ttl: float = 0, *args: Any, **kwargs: Any) -> Any:
        return self.cache.set(key, value, ttl)

    def delCache(self, key: str) -> None:
        self.cache.set(key, None, -1)

    def log(self, *args: Any, **kwargs: Any) -> None:
        # stdout is reserved for the protocol frame; spiders' own `print` is
        # redirected to stderr by pyrun, so logging there keeps parity.
        try:
            print(*args, file=__import__("sys").stderr)
        except Exception:  # noqa: BLE001 - logging must never break a call
            pass

    def limiter(self, *args: Any, **kwargs: Any) -> Any:
        """No-op stand-in for the host's rate limiter."""
        return None

    def joinUrl(self, base: str, path: str) -> str:
        return urljoin(base, path)

    @staticmethod
    def json_loads(text: Any, default: Any = None) -> Any:
        try:
            return json.loads(text)
        except Exception:  # noqa: BLE001
            return default if default is not None else {}


class _urllib_response:
    """Minimal requests.Response stand-in used when requests is unavailable."""

    def __init__(self, body: bytes, status: int, headers: dict[str, str]) -> None:
        self.content = body
        self.status_code = status
        self.headers = headers

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")

    def json(self) -> Any:
        return json.loads(self.text)

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


def _urllib_request(
    method: str,
    url: str,
    headers: dict[str, str],
    timeout: float,
    params: Any = None,
    data: Any = None,
) -> Any:
    import gzip
    import urllib.parse
    import urllib.request

    if params and isinstance(params, dict):
        query = urllib.parse.urlencode(params, doseq=True)
        url = f"{url}{'&' if '?' in url else '?'}{query}"
    body = None
    if data is not None:
        if isinstance(data, (dict, list)):
            body = urllib.parse.urlencode(data, doseq=True).encode()
        elif isinstance(data, str):
            body = data.encode()
        else:
            body = data
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return _urllib_response(raw, response.status, dict(response.headers))


__all__ = ["Spider", "TokenExpired", "DEFAULT_UA"]
