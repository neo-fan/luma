"""TVBox python-spider framework (`base.spider`), aligned with the box/pyramid family.

Every community py config ships spiders that start with

    from base.spider import Spider

and the host app normally injects that module. Our adapter runs spiders in a
child process, so the package lives here and is picked up through `sys.path`
(sidecars/py is the script directory of pyrun.py).

Alignment contract (see AGENTS.md "py 框架对齐 TVBox 原生"):
  * `box-src/Box-main` + `avbox` (pyramid) are the reference for the HTTP layer:
    positional `fetch(url, params, cookies, headers, ...)`, `rsp.encoding =
    "utf-8"`, and `html()` = `etree.HTML()` (tolerant, always xpath-able).
  * `__init__` must NOT overwrite subclass `header`/`headers` class attributes.
    The native `base.spider.Spider.__init__` only sets `self.extend`; subclass
    class attributes (e.g. Douban's WeChat UA + Referer) therefore survive.
    We used to hard-assign `self.header = {"User-Agent": DEFAULT_UA}` here,
    which silently broke every source that declares a custom header as a class
    attribute (douban / 4KAV / shanzha / shortfilm / 农民 / 嗨皮 ...) -> frodo
    HTTP 400 -> empty home list. Fixed by copying the class attribute instead.
  * Deliberate deviations forced by the one-shot child-process model (do NOT
    "fix" these): `log()` writes stderr (stdout is the JSON-RPC frame), no
    `__new__` singleton, proxy URL is `?url=` via `LUMA_PROXY_PORT`, cache is
    in-process. `verify=False` is an explicit compatibility choice (self-signed
    source sites), documented rather than silently matching the native True.

Only the surface that real configs touch is implemented.
"""

from __future__ import annotations

import json
import os
import re
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

try:  # lxml powers `html()`; box/avbox use etree.HTML for tolerant parsing.
    from lxml import etree
except Exception:  # noqa: BLE001 - optional dependency
    etree = None  # type: ignore[assignment]

# Kept as the default UA when a spider does not declare its own header. This is
# an intentional Luma choice (TVBox-compatible UA required by many real sources);
# it is applied as a *default*, never over a subclass's declared header.
DEFAULT_UA = "okhttp/3.15"


class TokenExpired(Exception):
    """Raised by spiders when a token/session must be refreshed."""


class _Cache:
    """Tiny TTL cache shared per spider instance (in-process, one-shot)."""

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

    def delete(self, key: str) -> None:
        with self._lock:
            self._data.pop(key, None)


class Spider:
    """Base class matching the TVBox `base.spider.Spider` contract."""

    #: Default header templates. A subclass may declare `header = {...}` or
    #: `headers = {...}` as a CLASS attribute; `__init__` copies (not overwrites)
    #: whichever exists so the subclass value stays authoritative.
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

        # TVBox native parity: never clobber a subclass-declared header. Reading
        # `self.header` here resolves the subclass class attribute (or this class
        # default); dict(...) makes a per-instance copy so one spider's mutation
        # cannot leak. The old `self.header = {DEFAULT_UA}` destroyed Douban's
        # WeChat UA/Referer and 5 other sources' custom headers.
        self.header = dict(getattr(self, "header", None) or {"User-Agent": DEFAULT_UA})
        self.headers = dict(getattr(self, "headers", None) or self.header)

        # TVBox's base class forwards construction to `init(extend)`; many configs
        # rely on that hook instead of overriding `__init__`.
        hook = getattr(self, "init", None)
        if callable(hook):
            try:
                hook(self.ext)
            except TypeError:
                hook()
        # A spider may set header/headers inside init(); keep them dicts.
        if not isinstance(getattr(self, "headers", None), dict):
            self.headers = {"User-Agent": DEFAULT_UA}
        if not isinstance(getattr(self, "header", None), dict):
            self.header = self.headers

    def init(self, extend: Any = "") -> None:
        """Subclass hook; TVBox calls this from `__init__`."""

    # --------------------------------------------------------------- parsing
    def html(self, content: Any, *args: Any, **kwargs: Any) -> Any:
        """Parse markup like the native pyramid base: `etree.HTML(content)`.

        `etree.HTML` tolerates broken/fragment HTML and always returns an
        xpath-able tree (or None for empty input), matching box/avbox. The old
        `lxml.html.fromstring` raised on fragments and returned None, making
        spider `.xpath()` calls crash.
        """
        text = content if isinstance(content, str) else str(getattr(content, "text", "") or "")
        if not text.strip():
            return None
        if etree is None:
            return None
        try:
            return etree.HTML(text)
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

    @staticmethod
    def _clean_header_value(value: Any) -> str:
        """Native box/avbox: sanitize a header value before a POST.

        Some sources accidentally pass a whole HTML document as a header value;
        the native base replaces that with a benign sentinel instead of letting
        requests raise `InvalidHeader`.
        """
        cleaned = str(value).strip()
        if cleaned.startswith("<!DOCTYPE html>"):
            return "DefaultValue"
        return cleaned

    # `verify=False` deviation: a number of real self-signed/legacy source sites
    # only respond with TLS verification off. Native box/avbox default True, but
    # matching that here would drop coverage, so keep False deliberately.
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
                cookies=cookies,
            )
        rsp = self._session.request(
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
        # Native parity: force utf-8 so `.text` matches what the script sees on
        # TVBox (otherwise requests guesses charset and CN sites may mojibake).
        try:
            rsp.encoding = "utf-8"
        except Exception:  # noqa: BLE001 - non-standard response objects
            pass
        return rsp

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
        if isinstance(headers, dict):
            headers = {str(k): self._clean_header_value(v) for k, v in headers.items()}
        if requests is None:
            return _urllib_request(
                "POST",
                url,
                self._merge_headers(headers),
                self._timeout(timeout),
                params=params,
                data=data if json is None else json,
                cookies=cookies,
            )
        rsp = self._session.request(
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
            **{k: v for k, v in kwargs.items() if k in {"proxies", "auth", "hooks"}},
        )
        try:
            rsp.encoding = "utf-8"
        except Exception:  # noqa: BLE001
            pass
        return rsp

    def postJson(self, url: str, json: Any = None, headers: Any = None, cookies: Any = None) -> Any:
        """Native avbox convenience: POST a JSON body."""
        return self.post(url, json=json, headers=headers, cookies=cookies)

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

    def setCache(self, key: str, value: Any, ttl: float = 0, *args: Any, **kwargs: Any) -> str:
        self.cache.set(key, value, ttl)
        # Native box/avbox return a status string; scripts branching on the
        # return value expect it, so align rather than returning the raw value.
        return "succeed"

    def delCache(self, key: str) -> str:
        self.cache.delete(key)
        return "succeed"

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

    # Native box/avbox string & JSON helpers (pure, no host dependency).
    def str2json(self, content: Any, default: Any = None) -> Any:
        try:
            return json.loads(content)
        except Exception:  # noqa: BLE001
            return default if default is not None else {}

    def json2str(self, content: Any) -> str:
        return json.dumps(content, ensure_ascii=False)

    def json_loads(self, text: Any, default: Any = None) -> Any:
        """Alias kept for backwards compatibility; same as `str2json`."""
        return self.str2json(text, default)

    def regStr(self, *args: Any, **kwargs: Any) -> str:
        """Regex extract, accepting both native argument orders.

        box: `regStr(reg, src, group=1)`; avbox: `regStr(src, reg, group=1)`
        (tries both directions too). `group` may be a keyword or the 3rd
        positional arg. Falls back to group(0) when the requested capture
        group is absent, so an ungrouped pattern still works.
        """
        if len(args) < 2:
            return ""
        raw_group = kwargs.get("group", args[2] if len(args) > 2 else 1)
        try:
            group = int(raw_group)
        except (TypeError, ValueError):
            group = 1
        a, b = args[0], args[1]
        for pattern, src in ((a, b), (b, a)):
            if not isinstance(pattern, str) or not isinstance(src, str):
                continue
            try:
                match = re.search(pattern, src)
            except re.error:
                continue
            if match:
                try:
                    return match.group(group)
                except IndexError:
                    return match.group(0)
        return ""

    def removeHtmlTags(self, src: Any) -> str:
        return re.sub("<.*?>", "", str(src or ""))

    def cleanText(self, src: Any) -> str:
        return re.sub(
            "[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF]",
            "",
            str(src or ""),
        )

    def xpText(self, root: Any, expr: str) -> str:
        """Native avbox: first xpath result as text, or ""."""
        try:
            ele = root.xpath(expr)
        except Exception:  # noqa: BLE001
            return ""
        if not ele:
            return ""
        node = ele[0]
        return str(node) if isinstance(node, str) else str(getattr(node, "text", "") or "")

    # ---------------------------------------------------- protocol no-op stubs
    # These belong to the TVBox Spider surface. Scripts may reference them; a
    # harmless default keeps them from raising AttributeError.
    def getName(self) -> str:
        return ""

    def getDependence(self) -> list:
        return []

    def isVideoFormat(self, url: Any) -> bool:
        return False

    def manualVideoCheck(self) -> bool:
        return False

    def action(self, action: Any) -> dict:
        return {}

    def destroy(self) -> None:
        return None

    def localProxy(self, param: Any) -> Any:
        return [404, "text/plain", b""]

    def proxy(self, params: Any) -> Any:
        return [404, "text/plain", ""]

    @staticmethod
    def link(name: Any, target: dict) -> str:
        """Native fongmi: render a `[a=cr:...]` target link."""
        if not isinstance(target, dict):
            raise TypeError("link requires a target dict")
        payload = json.dumps(target, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        return f"[a=cr:{payload}/]{name!s}[/a]"

    @staticmethod
    def page(items: list, pg: Any, limit: int, total: Any = None) -> dict:
        """Native fongmi: paginate a list into a TVBox page envelope."""
        pg = max(1, int(pg))
        if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
            raise ValueError("page requires a positive limit")
        if total is None:
            total = len(items)
            items = items[(pg - 1) * limit : pg * limit]
        if isinstance(total, bool) or not isinstance(total, int) or total < 0:
            raise ValueError("page requires a nonnegative total")
        return {
            "list": items,
            "page": pg,
            "pagecount": max(1, (total + limit - 1) // limit),
            "limit": limit,
            "total": total,
        }


class _urllib_response:
    """Minimal requests.Response stand-in used when requests is unavailable."""

    encoding = "utf-8"

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
    cookies: Any = None,
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
    final_headers = dict(headers or {})
    if cookies:
        if isinstance(cookies, dict):
            final_headers.setdefault("Cookie", "; ".join(f"{k}={v}" for k, v in cookies.items()))
        else:
            final_headers.setdefault("Cookie", str(cookies))
    request = urllib.request.Request(url, data=body, headers=final_headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return _urllib_response(raw, response.status, dict(response.headers))
