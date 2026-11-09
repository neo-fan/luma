#!/usr/bin/env python3
"""P1 stage acceptance (spec 12.2, cumulative).

Two phases:
  adapter  — drives `sidecars/py/main.py` over stdio directly: frame protocol,
             out-of-order ids, junk tolerance, crash, the full method table and
             the py spider template.
  app      — optional: if the desktop app is running (CDP 9222 + proxy 9978),
             asserts py routing through IPC, ext passthrough, fan-out timeout
             isolation and that no python child survives a crash.

Usage:
    python3 tests/e2e/p1.py            # adapter + app (app part skipped if absent)
    python3 tests/e2e/p1.py --adapter  # adapter only
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "sidecars" / "py" / "main.py"
STUB = "http://127.0.0.1:8787"
CDP = "http://127.0.0.1:9222/json/list"

results: list[tuple[str, str, str]] = []


def record(group: str, name: str, status: str, note: str = "") -> None:
    results.append((group, name, status))
    mark = {"PASS": "ok  ", "FAIL": "FAIL", "SKIP": "skip", "N/A": "n/a "}[status]
    print(f"[{mark}] {group:<12} {name}{('  -- ' + note) if note else ''}", flush=True)


def python_bin() -> str:
    return os.environ.get("TVBOX_PYTHON") or sys.executable


class Adapter:
    """Minimal stdio client used only by the acceptance script."""

    def __init__(self, timeout: float = 20.0) -> None:
        env = dict(os.environ)
        env.setdefault("TVBOX_ADAPTER_DEBUG", "1")
        self.proc = subprocess.Popen(
            [python_bin(), str(ADAPTER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(ROOT),
            env=env,
        )
        self.next_id = 0
        self.lock = threading.Lock()
        self.frames: dict[int, dict] = {}
        self.junk: list[str] = []
        self.timeout = timeout
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            text = raw.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                frame = json.loads(text)
            except json.JSONDecodeError:
                self.junk.append(text)
                continue
            with self.lock:
                self.frames[int(frame.get("id", -1))] = frame

    def send(self, method: str, params: dict | None = None) -> int:
        self.next_id += 1
        request_id = self.next_id
        line = json.dumps({"id": request_id, "method": method, "params": params or {}})
        assert self.proc.stdin is not None
        self.proc.stdin.write((line + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        return request_id

    def wait(self, request_id: int, timeout: float | None = None) -> dict:
        deadline = time.time() + (timeout or self.timeout)
        while time.time() < deadline:
            with self.lock:
                if request_id in self.frames:
                    return self.frames[request_id]
            if self.proc.poll() is not None:
                raise RuntimeError(f"adapter exited with {self.proc.returncode}")
            time.sleep(0.01)
        raise TimeoutError(f"frame {request_id} never arrived")

    def call(self, method: str, params: dict | None = None, timeout: float | None = None) -> dict:
        return self.wait(self.send(method, params), timeout)

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=3)
        except Exception:  # noqa: BLE001
            self.proc.kill()


def check(condition: bool, group: str, name: str, note: str = "") -> None:
    record(group, name, "PASS" if condition else "FAIL", note)


def http_text(url: str, timeout: float = 10.0) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read().decode("utf-8", "replace")


# --------------------------------------------------------------------------- #
# phase 1: adapter only
# --------------------------------------------------------------------------- #


def adapter_phase() -> None:
    adapter = Adapter()
    try:
        pong = adapter.call("ping")
        check(pong.get("ok") is True, "T-14 adapter", "ping", json.dumps(pong.get("result"))[:80])

        # full method table: every method must at least answer with a frame
        methods = [
            ("config.decrypt", {"raw": '{"sites":[]}'}),
            ("config.normalize", {"raw": '{"sites":[]}', "origin": "stub"}),
            ("config.mergeRepos", {"snapshots": []}),
            ("site.route", {"site": {"jar": "py", "api": "http://127.0.0.1:8787/x.py"}}),
            ("site.parseHome", {"site": {}, "raw": '{"class":[],"list":[]}'}),
            ("site.parseCategory", {"site": {}, "raw": '{"list":[]}', "tid": "1", "pg": 1}),
            ("site.parseDetail", {"site": {}, "raw": '{"list":[]}'}),
            ("site.parseSearch", {"site": {}, "raw": '{"list":[]}', "wd": "x", "pg": 1}),
            ("live.parseM3u", {"raw": '#EXTM3U\n#EXTINF:-1 group-title="G",Ch\nhttp://127.0.0.1:8787/play.m3u8\n', "url": "stub"}),
            ("parse.resolve", {"url": "http://127.0.0.1:8787/page/play.html", "rule": {"url": "http://127.0.0.1:8787/parse?url=${url}"}}),
            ("spider.py", {"source": (ROOT / "tests" / "fixtures" / "spiders" / "template.py").read_text(encoding="utf-8"), "method": "homeContent", "args": [], "ext": "stub-ext-py"}),
        ]
        missing = []
        for method, params in methods:
            frame = adapter.call(method, params)
            if "id" not in frame:
                missing.append(method)
            elif method == "site.route" and frame.get("result", {}).get("runtime") != "python":
                missing.append(f"{method}(runtime)")
        check(not missing, "T-14 adapter", "11 method table", ",".join(missing) or "all answered")

        route = adapter.call("site.route", {"site": {"key": "csp_x", "api": "http://127.0.0.1/a"}})
        check(route.get("result", {}).get("runtime") == "jvm", "T-14 adapter", "site.route jvm")

        m3u = adapter.call("live.parseM3u", {"raw": http_text(f"{STUB}/live/list.m3u")})
        groups = m3u.get("result", {}).get("groups", [])
        check(bool(groups) and len(groups[0]["channels"]) >= 1, "T-14 adapter", "live.parseM3u groups", f"{len(groups)} group(s)")

        # out-of-order: two concurrent calls, ids must route correctly
        slow = adapter.send("debug.echo", {"value": "slow", "delayMs": 400})
        fast = adapter.send("debug.echo", {"value": "fast", "delayMs": 0})
        fast_frame = adapter.wait(fast)
        slow_frame = adapter.wait(slow)
        check(
            fast_frame.get("result", {}).get("value") == "fast"
            and slow_frame.get("result", {}).get("value") == "slow",
            "T-13 bridge",
            "id matching under reordering",
            f"fast#{fast} slow#{slow}",
        )

        # junk frame must not break the connection
        junk = adapter.call("debug.junk")
        pong2 = adapter.call("ping")
        check(
            junk.get("ok") is True and pong2.get("ok") is True and adapter.junk,
            "T-13 bridge",
            "junk line tolerated",
            f"{len(adapter.junk)} ignored",
        )

        # py template: six methods, ext passthrough
        source = (ROOT / "tests" / "fixtures" / "spiders" / "template.py").read_text(encoding="utf-8")
        templates = [
            ("homeContent", [], "list"),
            ("categoryContent", ["1", 2], "list"),
            ("detailContent", ["py-1"], None),
            ("searchContent", ["关键词", False, 1], "list"),
            ("playerContent", ["py", "http://127.0.0.1:8787/play.m3u8"], "url"),
            ("liveContent", ["http://127.0.0.1:8787/live/list.m3u"], "list"),
        ]
        failures = []
        for method, args, key in templates:
            frame = adapter.call(
                "spider.py",
                {"source": source, "method": method, "args": args, "ext": "stub-ext-py"},
            )
            if not frame.get("ok"):
                failures.append(method)
                continue
            result = frame.get("result")
            if key and (not isinstance(result, dict) or key not in result):
                failures.append(f"{method}({key})")
        check(not failures, "T-15 python", "template 6 methods", ",".join(failures) or "6/6")

        home = adapter.call("spider.py", {"source": source, "method": "homeContent", "args": [], "ext": "stub-ext-py"})
        item = (home.get("result", {}).get("list") or [{}])[0]
        check(item.get("vod_id") == "py-1", "T-15 python", "normalized page shape", item.get("vod_name", ""))

        player = adapter.call(
            "spider.py",
            {"source": source, "method": "playerContent", "args": ["py", "x"], "ext": "stub-ext-py"},
        )
        check(
            player.get("result", {}).get("ext") == "stub-ext-py",
            "T-15 python",
            "ext passthrough",
            str(player.get("result", {}).get("ext")),
        )

        broken = (ROOT / "tests" / "fixtures" / "spiders" / "broken.py").read_text(encoding="utf-8")
        broken_frame = adapter.call("spider.py", {"source": broken, "method": "homeContent", "args": []})
        alive = adapter.call("ping")
        check(
            broken_frame.get("ok") is False and alive.get("ok") is True,
            "T-15 python",
            "broken spider isolated",
            broken_frame.get("error", {}).get("message", "")[:60],
        )

        slow_source = (ROOT / "tests" / "fixtures" / "spiders" / "slow.py").read_text(encoding="utf-8")
        started = time.time()
        timed_out = adapter.call(
            "spider.py",
            {"source": slow_source, "method": "homeContent", "args": [], "timeoutMs": 500},
            timeout=15,
        )
        elapsed = time.time() - started
        check(
            timed_out.get("ok") is False and elapsed < 10,
            "T-17 fanout",
            "py child killed on deadline",
            f"{elapsed:.1f}s",
        )
    finally:
        adapter.close()

    # crash then restart: a fresh process must work again
    crashed = Adapter()
    try:
        crashed.send("debug.crash", {"code": 7})
        # A loaded machine (desktop app + many sidecar children) can delay the
        # child's exit past a fixed sleep; poll instead of flaking.
        deadline = time.time() + 3.0
        while crashed.proc.poll() is None and time.time() < deadline:
            time.sleep(0.1)
        exited = crashed.proc.poll() is not None
    finally:
        crashed.close()
    fresh = Adapter()
    try:
        healed = fresh.call("ping").get("ok") is True
    finally:
        fresh.close()
    check(exited and healed, "T-13 bridge", "crash then fresh adapter")


# --------------------------------------------------------------------------- #
# phase 1b: qjs-runner sidecar (T-16)
# --------------------------------------------------------------------------- #


def qjs_binary() -> Path | None:
    override = os.environ.get("TVBOX_QJS_RUNNER")
    if override and Path(override).is_file():
        return Path(override)
    for profile in ("release", "debug"):
        candidate = ROOT / "sidecars" / "qjs-runner" / "target" / profile / "qjs-runner.exe"
        if candidate.is_file():
            return candidate
    return None


def qjs_phase() -> None:
    binary = qjs_binary()
    if binary is None:
        record("T-16 qjs", "sidecar present", "SKIP", "build sidecars/qjs-runner first")
        return
    record("T-16 qjs", "sidecar present", "PASS", str(binary.relative_to(ROOT)))

    source = (ROOT / "tests" / "fixtures" / "spiders" / "template.js").read_text(encoding="utf-8")
    calls = [
        ("homeContent", [], "list"),
        ("categoryContent", ["1", "2", False, {}], "list"),
        ("detailContent", [["js-1"]], "list"),
        ("searchContent", ["关键词", False, "1"], "list"),
        ("playerContent", ["js", "x", []], "url"),
        ("liveContent", ["http://127.0.0.1:8787/live/list.m3u"], "list"),
    ]
    lines = [
        json.dumps(
            {
                "id": index + 1,
                "source": source,
                "method": method,
                "args": args,
                "ext": "stub-ext-js",
                "timeout_ms": 5000,
            }
        )
        for index, (method, args, _key) in enumerate(calls)
    ]
    proc = subprocess.run(
        [str(binary)],
        input=("\n".join(lines) + "\n").encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=60,
    )
    frames = [json.loads(line) for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
    failures = []
    for (method, _args, key), frame in zip(calls, frames, strict=False):
        if not frame.get("ok"):
            failures.append(method)
            continue
        result = frame.get("result")
        if key and (not isinstance(result, dict) or key not in result):
            failures.append(f"{method}({key})")
    check(len(frames) == len(calls) and not failures, "T-16 qjs", "template 6 methods", ",".join(failures) or f"{len(frames)}/6")

    player = frames[4].get("result", {}) if len(frames) > 4 else {}
    check(player.get("ext") == "stub-ext-js", "T-16 qjs", "ext passthrough", str(player.get("ext")))

    sandbox_src = "globalThis.spider = { homeContent: function () { return { req: typeof req, require: typeof require, process: typeof process, fetch: typeof fetch }; } };"
    payload = json.dumps({"id": 1, "source": sandbox_src, "method": "homeContent", "args": [], "timeout_ms": 3000})
    sandbox = subprocess.run(
        [str(binary)],
        input=(payload + "\n").encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=30,
    )
    frame = json.loads(sandbox.stdout.decode("utf-8").strip().splitlines()[0])
    result = frame.get("result", {})
    denied = result.get("require") == "undefined" and result.get("process") == "undefined" and result.get("fetch") == "undefined"
    check(denied and result.get("req") == "function", "T-16 qjs", "sandbox exposes req only", json.dumps(result, ensure_ascii=False))

    loop_src = "globalThis.spider = { homeContent: function () { while (true) {} } };"
    payload = json.dumps({"id": 1, "source": loop_src, "method": "homeContent", "args": [], "timeout_ms": 600})
    started = time.time()
    loop = subprocess.run(
        [str(binary)],
        input=(payload + "\n").encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=20,
    )
    elapsed = time.time() - started
    frame = json.loads(loop.stdout.decode("utf-8").strip().splitlines()[0])
    check(
        frame.get("error", {}).get("code") == "SITE_TIMEOUT" and elapsed < 10,
        "T-16 qjs",
        "infinite loop interrupted",
        f"{elapsed:.1f}s",
    )


# --------------------------------------------------------------------------- #
# phase 2: running app (optional)
# --------------------------------------------------------------------------- #


def cdp_page() -> str | None:
    try:
        with urllib.request.urlopen(CDP, timeout=2) as response:
            targets = json.loads(response.read().decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    for target in targets:
        if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
            return target["webSocketDebuggerUrl"]
    return None


def python_children() -> int:
    """Count live python processes started by the app (best effort)."""
    if os.name != "nt":
        return 0
    try:
        output = subprocess.check_output(
            ["tasklist", "/FI", "IMAGENAME eq python.exe", "/FO", "CSV", "/NH"],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:  # noqa: BLE001
        return 0
    return sum(1 for line in output.splitlines() if "python.exe" in line.lower())


def app_phase_simple() -> None:
    if not cdp_page():
        for name in [
            "py ipc / fan-out probe",
            "no orphan python child",
        ]:
            record("app", name, "SKIP", "desktop app not running")
        return

    before = python_children()
    proc = subprocess.run(
        ["node", str(ROOT / "tools" / "probe_p1.mjs")],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=240,
    )
    for line in (proc.stdout or "").strip().splitlines():
        print(f"    {line}")
    record("app", "py ipc / fan-out probe", "PASS" if proc.returncode == 0 else "FAIL", f"exit {proc.returncode}")

    after = python_children()
    # One extra process would be the resident adapter; anything beyond that means
    # a killed child (pyrun) survived the job.
    leaked = after - before
    record("T-18 process", "no orphan python child", "PASS" if leaked <= 1 else "FAIL", f"python.exe {before} -> {after}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", action="store_true", help="adapter phase only")
    args = parser.parse_args()

    try:
        http_text(f"{STUB}/config.json", timeout=2)
        stub_up = True
    except Exception:  # noqa: BLE001
        stub_up = False
    record("stub", "stub server", "PASS" if stub_up else "FAIL", STUB)

    adapter_phase()
    qjs_phase()
    if not args.adapter:
        app_phase_simple()

    total = len(results)
    passed = sum(1 for _, _, status in results if status == "PASS")
    failed = sum(1 for _, _, status in results if status == "FAIL")
    skipped = sum(1 for _, _, status in results if status in ("SKIP", "N/A"))
    print(f"\nP1 summary: {passed} pass / {failed} fail / {skipped} skipped (total {total})")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
