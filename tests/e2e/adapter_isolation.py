#!/usr/bin/env python3
"""适配层「车道隔离」回归（1.0.2 修复点，不依赖窗口 / 桩服务）。

1.0.1 的真实故障：导入配置时弹出
`导入失败：python adapter config.decrypt exceeded 15000ms`。
根因**不是**解密慢 —— 同一份 `box.json` 解密只要 7ms —— 而是 `config.*` 与
`spider.py` 共用同一条 8 线程 FIFO 队列：一次 `spider.py` 能占住 worker 到子进程
结束（最长 15s），导入就排在它后面一路等到宿主自己的墙钟到期，报出来的字面却
像「解密花了 15 秒」。

本脚本守三件事：

1. 爬虫车道被占满时，`config.decrypt` / `ping` 仍然立即返回（两者走独立车道）；
2. 帧解析失败要回错误帧，不能静默丢弃（静默丢 = 宿主干等满 15s 才报超时）；
3. 每次 `config.*` 都在适配层日志里留一条 `adapter_latency`（耗时 + 字节数），
   下次再出问题不必靠猜。

运行： `python tests/e2e/adapter_isolation.py`（`tools/check.py` 已接入）。
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

# 爬虫车道占满后，导入车道必须在这个预算内答复；留足 CI 抖动余量。
LANE_BUDGET_S = 0.7
SATURATE_MS = 1500

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


class Adapter:
    """Minimal stdio client: background reader so a slow reply never blocks a send."""

    def __init__(self) -> None:
        self.log_path = Path(tempfile.gettempdir()) / f"luma-adapter-isolation-{os.getpid()}.log"
        self.log_path.unlink(missing_ok=True)
        env = dict(os.environ)
        env["LUMA_ADAPTER_DEBUG"] = "1"
        env["LUMA_ADAPTER_LOG"] = str(self.log_path)
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

    def send(self, method: str, params: dict | None = None) -> int:
        self.next_id += 1
        request_id = self.next_id
        self.send_raw(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        return request_id

    def wait(self, request_id: int, timeout: float = 10.0) -> dict | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with self.lock:
                frame = self.frames.pop(request_id, None)
            if frame is not None:
                return frame
            time.sleep(0.01)
        return None

    def timed(self, method: str, params: dict | None = None, timeout: float = 10.0):
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
        # 1) 冷启动 + ping（ping 与导入同车道，不能被爬虫堵住）
        frame, took = adapter.timed("ping", {}, timeout=20.0)
        check(frame is not None and frame.get("ok") is True, "ping replies", str(frame))
        version = (frame or {}).get("result", {}).get("version", "")
        check(isinstance(version, str) and version.count(".") == 2, "ping reports a version", str(version))

        # 2) 明文配置照常解密
        frame, _ = adapter.timed("config.decrypt", {"raw": json.dumps({"sites": []})})
        check(
            frame is not None and frame.get("ok") is True and frame["result"].get("method") == "plain",
            "config.decrypt plain json",
            str(frame),
        )

        # 3) 占满爬虫车道，再插一次导入：必须在 LANE_BUDGET_S 内答复
        for _ in range(8):
            adapter.send("debug.echo", {"delayMs": SATURATE_MS})
        frame, took = adapter.timed("config.decrypt", {"raw": json.dumps({"sites": [{"key": "a"}]})})
        check(
            frame is not None and frame.get("ok") is True,
            "config.decrypt answers while 8 spider workers are busy",
            f"{took * 1000:.0f}ms frame={frame}",
        )
        check(
            took < LANE_BUDGET_S,
            f"import lane is not queued behind spiders (<{LANE_BUDGET_S * 1000:.0f}ms)",
            f"{took * 1000:.0f}ms",
        )
        frame, took = adapter.timed("ping", {})
        check(
            frame is not None and frame.get("ok") is True and took < LANE_BUDGET_S,
            "ping is not queued behind spiders",
            f"{took * 1000:.0f}ms",
        )

        # 4) 坏帧（能捞出 id）必须回错误帧，而不是静默丢弃
        adapter.send_raw('{"id": 9001, "method": "config.decrypt", "params": {"raw": "oops}')
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

        # 6) 导入耗时/字节数必须落盘（1.0.1 查不动就是缺这条）
        time.sleep(0.2)  # adapterlog 是同步写，这里只等文件系统刷一下
        records = log_records(adapter.log_path)
        decrypts = [
            r for r in records if r.get("kind") == "adapter_latency" and r.get("method") == "config.decrypt"
        ]
        check(bool(decrypts), "config.decrypt logs an adapter_latency record", str(records[:3]))
        check(
            any(isinstance(r.get("elapsedMs"), int) and isinstance(r.get("bytes"), int) for r in decrypts),
            "adapter_latency carries elapsedMs + bytes",
            str(decrypts[:3]),
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
