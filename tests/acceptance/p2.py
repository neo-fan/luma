#!/usr/bin/env python3
"""P2 stage acceptance (spec 12.2 cumulative matrix, T-20 ~ T-27).

Cumulative by construction: earlier stages are re-run and must stay green,
then the P2-specific assertions are added. Capabilities that belong to P3 are
reported as N/A (not FAIL, not silently passed) per v1.1 12.2.

Phases:
  build   — T-20 javap symbol conservation, T-21 stubs, T-22 dex shape
  jvm     — T-23 all 12 Spider API methods + ext passthrough, T-24 process
            pool, T-25 proxy-port injection, T-26 crash isolation
  cumulative — p0 / p1 / config_compat / contract / capabilities
  app     — optional (--with-app): real window routing through CDP

Usage:
    python3 tests/acceptance/p2.py
    python3 tests/acceptance/p2.py --no-cumulative   # P2 assertions only
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
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STUB = "http://127.0.0.1:8787"
RUNNER_JAR = ROOT / "sidecars" / "java" / "runner.jar"
STUBS_JAR = ROOT / "sidecars" / "java" / "stubs.jar"
CLASS_JAR = ROOT / "tests" / "fixtures" / "jars" / "template-class.jar"
DEX_JAR = ROOT / "tests" / "fixtures" / "jars" / "template-dex.jar"

SPIDER_API = [
    "init", "homeContent", "homeVideoContent", "categoryContent",
    "detailContent", "searchContent", "playerContent", "liveContent",
    "proxy", "isVideoFormat", "manualVideoCheck", "destroy",
]
SPIDER_METHODS = [
    "homeContent", "homeVideoContent", "categoryContent", "detailContent",
    "searchContent", "playerContent", "liveContent",
]

results: list[tuple[str, str, str]] = []


def record(group: str, name: str, status: str, note: str = "") -> None:
    results.append((group, name, status))
    mark = {"PASS": "ok  ", "FAIL": "FAIL", "SKIP": "skip", "N/A": "n/a "}[status]
    print(f"[{mark}] {group:<12} {name}{('  -- ' + note) if note else ''}", flush=True)


def check(condition: bool, group: str, name: str, note: str = "") -> None:
    record(group, name, "PASS" if condition else "FAIL", note)


def java_bin() -> str:
    override = os.environ.get("LUMA_JAVA") or os.environ.get("TVBOX_JAVA")
    if override:
        return override
    home = os.environ.get("JAVA_HOME")
    if home:
        exe = "java.exe" if os.name == "nt" else "java"
        return str(Path(home) / "bin" / exe)
    return "java"


def run_script(group: str, name: str, argv: list[str]) -> None:
    proc = subprocess.run(argv, cwd=str(ROOT), capture_output=True, text=True)
    tail = (proc.stdout or proc.stderr).strip().splitlines()
    check(proc.returncode == 0, group, name, tail[-1][:110] if tail else f"rc={proc.returncode}")


def ensure_stub() -> subprocess.Popen | None:
    """Start the local stub only if it is not already listening."""
    try:
        with urllib.request.urlopen(f"{STUB}/config.json", timeout=1) as response:
            response.read(64)
        return None
    except Exception:
        pass
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "tests" / "stub_server.py")],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        try:
            with urllib.request.urlopen(f"{STUB}/config.json", timeout=1) as response:
                response.read(64)
            return proc
        except Exception:
            if proc.poll() is not None:
                break
            time.sleep(0.1)
    return proc


class JvmRunner:
    """Minimal stdio client for the long-lived SpiderRunner JVM."""

    def __init__(self, port: str = "9978") -> None:
        env = dict(os.environ)
        self.proc = subprocess.Popen(
            [java_bin(), f"-Dluma.proxy.port={port}", f"-Dtvbox.proxy.port={port}",
             "-cp", str(RUNNER_JAR), "SpiderRunner"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=str(ROOT), env=env,
        )
        self.next_id = 0
        self.lock = threading.Lock()
        self.frames: dict[object, dict] = {}
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
                continue
            with self.lock:
                self.frames[frame.get("id")] = frame

    def send(self, method: str, params: dict | None = None) -> int:
        self.next_id += 1
        line = json.dumps({"id": self.next_id, "method": method, "params": params or {}})
        assert self.proc.stdin is not None
        self.proc.stdin.write((line + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        return self.next_id

    def wait(self, request_id: int, timeout: float = 15.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                if request_id in self.frames:
                    return self.frames[request_id]
            if self.proc.poll() is not None:
                raise RuntimeError(f"jvm runner exited with {self.proc.returncode}")
            time.sleep(0.01)
        raise TimeoutError(f"frame {request_id} never arrived")

    def call(self, method: str, params: dict | None = None, timeout: float = 15.0) -> dict:
        return self.wait(self.send(method, params), timeout)

    def invoke(self, jar: Path, method: str, args: list | None = None, ext: str = "") -> dict:
        return self.call("invoke", {
            "jar": str(jar), "api": "csp_Template", "className": "",
            "method": method, "args": args or [], "ext": ext,
            "siteKey": "p2-template", "timeoutMs": 15000,
        })

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
            self.proc.wait(timeout=3)
        except Exception:
            self.proc.kill()


def build_phase() -> None:
    # T-20: javap -p -s symbol conservation on both self-authored template jars.
    conserve = ROOT / "tools" / "javap_conserve.py"
    if not conserve.is_file():
        check(False, "T-20 javap", "conserve script present")
        return
    proc = subprocess.run([sys.executable, str(conserve)], cwd=str(ROOT),
                          capture_output=True, text=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    check(proc.returncode == 0 and "不匹配数: 0" in out, "T-20 javap",
          "0 symbol mismatches", out.strip().splitlines()[-1][:80] if out.strip() else "")

    # T-21: stubs.jar exposes the catvod Spider base class.
    with zipfile.ZipFile(STUBS_JAR) as archive:
        names = archive.namelist()
    check("com/github/catvod/crawler/Spider.class" in names, "T-21 stubs",
          "catvod Spider base class", f"{len(names)} entries")
    check("android/content/Context.class" in names, "T-21 stubs", "android Context stub")

    # T-22: the dex-shaped template has classes.dex and no .class entry.
    with zipfile.ZipFile(DEX_JAR) as archive:
        dex_names = archive.namelist()
    check(any(n == "classes.dex" for n in dex_names), "T-22 dex", "classes.dex present")
    check(not any(n.endswith(".class") for n in dex_names), "T-22 dex",
          "no .class entries (dex shape)")


def jvm_phase() -> None:
    if not RUNNER_JAR.is_file():
        check(False, "T-23 api", "runner.jar built", "run sidecars/java/build.py")
        return

    runner = JvmRunner()
    try:
        pong = runner.call("ping")
        ping_result = pong.get("result") or {}
        check(pong.get("ok") is True and ping_result.get("ok") is True,
              "T-23 api", "jvm runner alive", str(ping_result.get("version")))

        # T-25 / 7.5.1: the host must inject the live proxy port into the JVM.
        check(str(ping_result.get("proxyPort")) == "9978", "T-25 proxy",
              "-Dluma.proxy.port injected", str(ping_result.get("proxyPort")))

        class_probe = runner.call("probe", {"jar": str(CLASS_JAR)}).get("result") or {}
        dex_probe = runner.call("probe", {"jar": str(DEX_JAR)}).get("result") or {}
        check(class_probe.get("kind") == "class", "T-22 dex",
              "probe(class) -> class", str(class_probe.get("kind")))
        check(dex_probe.get("kind") == "dex", "T-22 dex",
              "probe(dex) -> dex", str(dex_probe.get("kind")))

        for jar, label in ((CLASS_JAR, "class"), (DEX_JAR, "dex")):
            failures = []
            for method in SPIDER_API:
                frame = runner.invoke(jar, method)
                if frame.get("ok") is not True:
                    failures.append(method)
            check(not failures, f"T-23 {label}", "12 Spider API methods",
                  ",".join(failures) or "all 12 ok")

            # TVBox shapes differ per method: pages carry `list`, details are
            # an array, player carries `playUrl`, live carries `live`/`groups`.
            key_field = {
                "homeContent": "list", "homeVideoContent": "list",
                "categoryContent": "list", "searchContent": "list",
                "playerContent": "playUrl", "liveContent": "live",
            }
            shapes = []
            for method in SPIDER_METHODS:
                result = runner.invoke(jar, method).get("result")
                if method == "detailContent":
                    ok = isinstance(result, list) and bool(result)
                elif isinstance(result, dict):
                    ok = key_field.get(method) in result
                else:
                    ok = False
                if not ok:
                    shapes.append(method)
            check(not shapes, f"T-23 {label}",
                  f"{len(SPIDER_METHODS)} SpiderMethod shapes",
                  ",".join(shapes) or "all shaped")

            # 8.5: ext must arrive at Spider.init(Context, String) unchanged.
            frame = runner.invoke(jar, "homeContent", ext="stub-ext-jar")
            result = frame.get("result") or {}
            check(result.get("extEcho") == "stub-ext-jar", f"T-23 {label}",
                  "ext passthrough (8.5)", str(result.get("extEcho")))

        # T-24: one JVM serves the whole burst; no restart between calls.
        pid_before = runner.proc.pid
        burst_ok = all(runner.invoke(CLASS_JAR, "homeContent").get("ok") is True
                       for _ in range(50))
        check(burst_ok and runner.proc.pid == pid_before and runner.proc.poll() is None,
              "T-24 pool", "50 calls / single JVM", f"pid={pid_before}")

        # T-26: a broken jar must not take the shared JVM down.
        missing = ROOT / "tests" / "fixtures" / "jars" / "definitely-absent.jar"
        isolated = True
        for _ in range(3):
            frame = runner.invoke(missing, "homeContent")
            isolated = isolated and frame.get("ok") is False
        check(isolated and runner.call("ping").get("ok") is True, "T-26 isolate",
              "bad jar is a frame error, JVM survives")
    finally:
        runner.close()

    # T-25: dynamic port is honoured as well (7.5.1 dynamic injection).
    alt = JvmRunner(port="9988")
    try:
        port = (alt.call("ping").get("result") or {}).get("proxyPort")
        check(str(port) == "9988", "T-25 proxy", "dynamic port honoured", str(port))
    finally:
        alt.close()


def cumulative_phase() -> None:
    py = sys.executable
    run_script("12.2 cumul", "p0.py (offline)", [py, "tests/acceptance/p0.py", "--offline"])
    run_script("12.2 cumul", "p1.py (adapter)", [py, "tests/acceptance/p1.py", "--adapter"])
    run_script("12.2 cumul", "config_compat.py", [py, "tests/offline/config_compat.py"])
    run_script("12.2 cumul", "contract_check.py", [py, "tests/offline/contract_check.py"])
    run_script("12.2 cumul", "capabilities_check.py", [py, "tests/offline/capabilities_check.py"])
    # P3 sniffing is the only group still not delivered in P2.
    record("12.2 N/A", "sniffing (4th playback fallback)", "N/A", "enabled in P3")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-cumulative", action="store_true")
    args = parser.parse_args()

    stub = ensure_stub()
    try:
        build_phase()
        jvm_phase()
        if not args.no_cumulative:
            cumulative_phase()
    finally:
        if stub is not None:
            stub.terminate()

    passed = sum(1 for _, _, s in results if s == "PASS")
    failed = sum(1 for _, _, s in results if s == "FAIL")
    skipped = sum(1 for _, _, s in results if s in ("SKIP", "N/A"))
    print(f"\nP2 summary: {passed} pass / {failed} fail / {skipped} n-a (total {len(results)})")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
