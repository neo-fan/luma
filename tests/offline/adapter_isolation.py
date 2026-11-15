#!/usr/bin/env python3
"""适配层健壮性回归（单车道 + 帧协议 + UTF-8 + 慢调用日志，不依赖窗口 / 桩服务）。

1.0.4 起适配层只剩「执行第三方 Python 脚本」一条职责：`config.*` / `site.route`
/ `live.*` / `parse.resolve` 全部搬进 Rust 宿主进程，协议面是 `ping` +
`spider.py`（外加门控的 `debug.*`）。车道隔离那条历史断言（导入不能排在爬虫后面）
随之失效——但帧健壮性、stdio 编码、慢调用可观测性仍然必须守：

1. `ping` 永远答帧，`spider.py` 能真的把脚本跑起来；
2. 8 个 worker 被占满时，后来的请求排队但最终必须答复（不是丢帧）；
3. 帧解析失败要回错误帧，不能静默丢弃（静默丢 = 宿主干等满自己的墙钟才报超时）；
4. stdio 恒为 UTF-8：即便环境把 `PYTHONIOENCODING` 设成 `gbk` / `cp936`
   （中文 Windows 的默认代码页），含中文的请求帧也必须原样送达；
5. 慢到可疑的 `spider.py` 调用要在适配层日志里留一条 `adapter_latency`。

运行： `python tests/offline/adapter_isolation.py`（`tools/check.py` 已接入）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ADAPTER = ROOT / "sidecars" / "py" / "main.py"
TEMPLATE = ROOT / "tests" / "fixtures" / "spiders" / "template.py"

# 一次请求（含排队）的答复预算；留足 CI 抖动余量。
ANSWER_BUDGET_S = 8.0
SATURATE_MS = 1200

PASS = 0
FAIL = 0


def check(ok: bool, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}  {detail}")


def interpreter() -> str:
    override = os.environ.get("LUMA_PYTHON")
    if override and Path(override).is_file():
        return override
    for candidate in (
        ROOT / "sidecars" / "python-embed" / "python.exe",
        ROOT / "sidecars" / "python-embed" / "bin" / "python3",
    ):
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def spider_source(body: str) -> str:
    """包一个最小 spider：body 是 `homeContent` 的方法体。"""
    return (
        "class Spider:\n"
        "    def homeContent(self, filter):\n"
        + "".join(f"        {line}\n" for line in body.strip().splitlines())
    )


class Adapter:
    """Minimal stdio client: background reader so a slow reply never blocks a send."""

    def __init__(self, suffix: str = "", env_extra: dict[str, str] | None = None) -> None:
        self.log_path = (
            Path(tempfile.gettempdir()) / f"luma-adapter-isolation-{os.getpid()}{suffix}.log"
        )
        self.log_path.unlink(missing_ok=True)
        env = dict(os.environ)
        env["LUMA_ADAPTER_DEBUG"] = "1"
        env["LUMA_ADAPTER_LOG"] = str(self.log_path)
        env.update(env_extra or {})
        self.proc = subprocess.Popen(
            [interpreter(), str(ADAPTER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(ROOT),
            env=env,
        )
        self.lock = threading.Lock()
        self.frames: dict[int, dict] = {}
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            text = raw.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                frame = json.loads(text)
            except json.JSONDecodeError:
                continue
            with self.lock:
                self.frames[frame.get("id")] = frame

    def send_raw(self, line: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write((line + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def send(self, method: str, params: dict | None = None, *, ensure_ascii: bool = True) -> int:
        self.next_id += 1
        request_id = self.next_id
        payload = json.dumps(
            {"id": request_id, "method": method, "params": params or {}},
            ensure_ascii=ensure_ascii,
        )
        self.send_raw(payload)
        return request_id

    def wait(self, request_id: int, timeout: float = ANSWER_BUDGET_S) -> dict | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                frame = self.frames.pop(request_id, None)
            if frame is not None:
                return frame
            time.sleep(0.01)
        return None

    def timed(self, method: str, params: dict | None = None, timeout: float = ANSWER_BUDGET_S):
        request_id = self.send(method, params)
        started = time.perf_counter()
        frame = self.wait(request_id, timeout)
        return frame, time.perf_counter() - started

    def close(self) -> None:
        try:
            self.proc.kill()
        except OSError:
            pass


def log_records(path: Path) -> list[dict]:
    """Every JSON line the adapter appended (``spider.log`` family)."""
    if not path.is_file():
        return []
    records = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def main() -> int:
    adapter = Adapter()
    try:
        # 1) 冷启动 + ping
        frame, took = adapter.timed("ping", {}, timeout=20.0)
        check(frame is not None and frame.get("ok") is True, "ping replies", str(frame))
        version = (frame or {}).get("result", {}).get("version", "")
        check(isinstance(version, str) and version.count(".") == 2, "ping reports a version", str(version))

        # 2) spider.py 真的把第三方脚本跑起来（模板 7 方法之一）
        template = TEMPLATE.read_text(encoding="utf-8")
        frame, _ = adapter.timed(
            "spider.py",
            {"source": template, "method": "homeContent", "args": [], "ext": "stub-ext"},
            timeout=25.0,
        )
        result = (frame or {}).get("result") or {}
        check(
            frame is not None and frame.get("ok") is True and bool(result.get("list")),
            "spider.py executes a template script",
            str(frame)[:200],
        )

        # 3) 8 个 worker 占满后，后来的请求排队但必须答复（丢帧会让宿主等满墙钟）
        for _ in range(8):
            adapter.send("debug.echo", {"delayMs": SATURATE_MS})
        frame, took = adapter.timed("ping", {})
        check(
            frame is not None and frame.get("ok") is True,
            "ping still answers while all workers are busy",
            f"{took * 1000:.0f}ms frame={frame}",
        )

        # 4) 坏帧（能捞出 id）必须回错误帧，而不是静默丢弃
        adapter.send_raw('{"id": 9001, "method": "spider.py", "params": {"source": "oops')
        frame = adapter.wait(9001, timeout=5.0)
        check(
            frame is not None and frame.get("ok") is False,
            "malformed frame is answered with an error frame",
            str(frame),
        )
        check(
            frame is not None and "malformed frame" in str(frame.get("error", {}).get("message", "")),
            "error frame explains the malformed frame",
            str(frame),
        )

        # 5) 没有 id 的垃圾帧不致命：适配层必须继续服务
        adapter.send_raw("this is not json")
        frame, _ = adapter.timed("ping", {})
        check(frame is not None and frame.get("ok") is True, "adapter survives an unidentifiable frame")

        # 6) 中文 Windows（cp936）：stdio 不能按 ANSI 代码页解码。
        # 1.0.2 的真实故障：UTF-8 帧被按 GBK 解码，中文内容在 ~8 KiB 处字节错位。
        # 请求必须够大（>8 KiB）且不转义成 \uXXXX，才会暴露真问题。
        blob = "".join(f"站点{i:03d}·港澳台直播" for i in range(360))
        source = spider_source(f"return {{'list': [{{'vod_name': {blob!r}}}]}}")
        for encoding in ("gbk", "cp936"):
            localized = Adapter(suffix=f"-{encoding}", env_extra={"PYTHONIOENCODING": encoding})
            try:
                request_id = localized.send(
                    "spider.py",
                    {"source": source, "method": "homeContent", "args": []},
                    ensure_ascii=False,
                )
                frame = localized.wait(request_id, timeout=30.0)
            finally:
                localized.close()
            got = ((frame or {}).get("result") or {}).get("list") or [{}]
            check(
                (frame or {}).get("ok") is True and got[0].get("vod_name") == blob,
                f"utf-8 frames survive a {encoding} stdio code page",
                f"{len(source)}B {str(frame)[:160]}",
            )

        # 7) 慢调用要在适配层日志里留一条 adapter_latency（超过 SLOW_CALL_MS=3000）
        slow = spider_source("import time\ntime.sleep(3.3)\nreturn {'list': []}")
        frame, took = adapter.timed(
            "spider.py",
            {"source": slow, "method": "homeContent", "args": []},
            timeout=30.0,
        )
        check(frame is not None and frame.get("ok") is True, "slow spider.py still answers", f"{took:.1f}s")
        time.sleep(0.2)
        records = log_records(adapter.log_path)
        slow_records = [
            r for r in records if r.get("kind") == "adapter_latency" and r.get("method") == "spider.py"
        ]
        check(bool(slow_records), "slow spider.py logs an adapter_latency record", str(records[:3]))
        check(
            any(isinstance(r.get("elapsedMs"), int) and r.get("elapsedMs") >= 3000 for r in slow_records),
            "adapter_latency carries the elapsed time",
            str(slow_records[:3]),
        )
        check(
            any(r.get("kind") == "bad_frame" for r in records),
            "malformed frame is recorded in the adapter log",
            str(records[-3:]),
        )
    finally:
        adapter.close()

    print(f"\n{'-' * 60}\n{'ALL GREEN' if FAIL == 0 else 'FAILED'}: {PASS} passed, {FAIL} failed")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
