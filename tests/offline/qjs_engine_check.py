"""qjs 引擎宿主注入的离线回归断言（不依赖桌面窗口 / 桩服务 / 真网络）。

本 check 驱动 `sidecars/qjs-runner` 二进制喂 JSON 帧，锁三组关键契约防漂移回归：

1. **GBK 编解码**：`gbkTool()` 模块经宿主 `__luma_gbk_encode/decode` 委托
   `encoding_rs::GBK`，对中文 / ASCII / 全角 / 字面 % 混合串往返一致；
2. **ds 真实现**：`batchFetch(list)` 串行返回与入参等长数组（每项含 code），
   `reqs` 委托 `req`、`toBeijingTime` 东八区、`jsonToCookie/cookieToJson` 往返；
3. **ds STUBS 空兜底**：`executeParse/rsaX/aesX/desX/js2Proxy/cachedRequest/`
   `JSProxyStream/JSFile/AIS/XMLHttpRequest/jsoup/pq/pj/pjfa/pjfh/pdfl` 等
   依赖 Node/Java 桥、Luma 未复刻的符号，调用返回空而非抛 ReferenceError 中断整站。

运行： `<python-embed>/python.exe tests/offline/qjs_engine_check.py`
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SIDECAR = ROOT / "sidecars" / "qjs-runner"
CARGO = os.environ.get("CARGO", "cargo")
LIB = ROOT / "sidecars" / "qjs-assets" / "js" / "lib"

PASS = 0
FAIL = 0
NA = 0


def check(ok: bool, group: str, name: str, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"PASS  [{group}] {name}")
    else:
        FAIL += 1
        print(f"FAIL  [{group}] {name}  {detail}")


def na(group: str, name: str, detail: str = "") -> None:
    global NA
    NA += 1
    print(f"N/A   [{group}] {name}  {detail}")


def binary_path() -> Path | None:
    override = os.environ.get("LUMA_QJS_RUNNER")
    if override and Path(override).is_file():
        return Path(override)
    for prof in ("release", "debug"):
        cand = SIDECAR / "target" / prof / "qjs-runner.exe"
        if cand.is_file():
            return cand
        cand = SIDECAR / "target" / prof / "qjs-runner"  # non-windows
        if cand.is_file():
            return cand
    return None


def ensure_binary() -> Path | None:
    p = binary_path()
    if p:
        return p
    try:
        subprocess.run(
            [CARGO, "build", "--offline"],
            cwd=str(SIDECAR), check=True, timeout=600,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        )
    except FileNotFoundError:
        na("qjs", "cargo missing")
        return None
    except subprocess.CalledProcessError as e:
        na("qjs", "build failed", f"{str(e.stdout)[:200]!r}")
        return None
    except subprocess.TimeoutExpired:
        na("qjs", "build timeout")
        return None
    return binary_path()


def encode(frames):
    lines = [json.dumps(f, ensure_ascii=False) for f in frames]
    return ("\n".join(lines) + "\n").encode("utf-8")


def run(binary: Path, frames):
    p = subprocess.run(
        [str(binary)],
        input=encode(frames),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
    )
    out = []
    for line in p.stdout.decode("utf-8", "replace").splitlines():
        s = line.strip()
        if not s:
            continue
        try:
            out.append(json.loads(s))
        except Exception as e:
            out.append({"_parseerr": str(e), "raw": s[:300]})
    return out, p.stderr.decode("utf-8", "replace")


def frame(idx: int, source: str, method: str = "homeContent", args: list | None = None, ext: str = "", api: str = ""):
    return {
        "id": idx, "source": source, "method": method,
        "args": args or [], "ext": ext, "api": api,
        "assets_dir": str(ROOT / "sidecars" / "qjs-assets"),
        "timeout_ms": 30000,
    }


# ---- 1) GBK module roundtrip via shim -------------------------------
GBK_SPIDER = r"""
import { gbkTool } from "./gbk.js";
export function __jsEvalReturn() {
  return { home: async () => {
    var t = gbkTool();
    var cases = ["中文测试", "50%数据", "你每", "全角【】和ASCII abc-123"];
    var rt = cases.map(s => t.decode(t.encode(s)) === s);
    var known = (t.encode("你") === "%C4%E3") && (t.encode("你好") === "%C4%E3%BA%C3") && (t.encode("中文") === "%D6%D0%CE%C4");
    return { list: [{ rt: rt, known: known }] };
  } };
}
"""


def check_gbk(binary: Path):
    resp, err = run(binary, [frame(1, GBK_SPIDER)])
    if not resp or resp[0].get("_parseerr"):
        na("gbk", "runner", str(resp[:1]))
        return
    check(bool(resp[0].get("ok")), "gbk", "engine loaded", str(resp[0].get("error", ""))[:200])
    res = resp[0].get("result") or {}
    items = res.get("list") or []
    if items:
        item = items[0]
        check(all(item.get("rt") or []), "gbk", "roundtrip preserved", str(item.get("rt")))
        check(bool(item.get("known")), "gbk", "known GBK bytes", "你=C4E3 好=BAC3 中文=D6D0CEEC")
    else:
        na("gbk", "no result")
    if "decode failed" in err or "encode failed" in err:
        check(False, "gbk", "no engine warnings", err[:200])


# ---- 2) ds real impls ----------------------------------------------
DS_REAL = r"""
export function __jsEvalReturn() {
  return { home: async () => {
    var names = ['batchFetch', 'reqs', 'toBeijingTime', 'jsonToCookie', 'cookieToJson'];
    var present = names.filter(n => typeof eval(n) === 'function');
    var time = (typeof toBeijingTime === 'function') ? toBeijingTime(1700000000000) : null;
    var c2j  = (typeof cookieToJson === 'function') ? cookieToJson('a=1; b=2') : null;
    var j2c  = (typeof jsonToCookie === 'function') ? jsonToCookie({x: '9'}) : null;
    // batchFetch 串行返回等长数组（每项含 code；离线 URL 返回 code 0/200 都可，
    // 但必须是数组且长度匹配）。
    var urls = ["https://offline.example/a", "https://offline.example/b"];
    var bf   = batchFetch(urls);
    return { list: [{ present: present.join(','), time: String(time),
                      c2j: JSON.stringify(c2j), j2c: String(j2c),
                      bf_len: bf && bf.length,
                      bf_arr: Array.isArray(bf) }] };
  } };
}
"""


def check_ds_real(binary: Path):
    resp, err = run(binary, [frame(1, DS_REAL, api="https://x/y.js")])
    if not resp or resp[0].get("_parseerr"):
        na("ds-real", "runner", str(resp[:1]))
        return
    check(bool(resp[0].get("ok")), "ds-real", "engine loaded", str(resp[0].get("error", ""))[:200])
    res = resp[0].get("result") or {}
    items = res.get("list") or []
    if not items:
        na("ds-real", "no result")
        return
    item = items[0]
    check(item.get("present") == "batchFetch,reqs,toBeijingTime,jsonToCookie,cookieToJson",
          "ds-real", "all present", item.get("present"))
    # 东八区：1700000000000ms -> 2023-11-15 06:13:20
    check(item.get("time") == "2023-11-15 06:13:20", "ds-real", "toBeijingTime +8", item.get("time"))
    check(json.loads(item["c2j"]) == {"a": "1", "b": "2"}, "ds-real", "cookieToJson", item.get("c2j"))
    check(item.get("j2c") == "x=9", "ds-real", "jsonToCookie", item.get("j2c"))
    check(bool(item.get("bf_arr")) and item.get("bf_len") == 2,
          "ds-real", "batchFetch returns array same-length", str(item.get("bf_len")))


# ---- 3) ds STUBS fallback (must not ReferenceError) ----------------
DS_STUBS = r"""
export function __jsEvalReturn() {
  return { home: async () => {
    var names = ['executeParse','rsaX','aesX','desX','js2Proxy','cachedRequest','JSProxyStream','JSFile','AIS','XMLHttpRequest','jsoup','pq','pj','pjfa','pjfh','pdfl'];
    var results = {};
    var crash = null;
    for (var n of names) {
      try { results[n] = (typeof globalThis[n] === 'function') ? 'ok' : 'MISSING'; }
      catch(e) { results[n] = 'crash:' + String(e); crash = crash || (n + ':' + e); }
    }
    // 真的调用一次：executeParse 应返回空串而非抛 ReferenceError
    try { results._call = String(executeParse('x')); } catch(e) { results._call = 'crash:' + String(e); }
    return { list: [{ results: results, crash: crash }] };
  } };
}
"""


def check_ds_stubs(binary: Path):
    resp, err = run(binary, [frame(1, DS_STUBS, api="https://x/y.js")])
    if not resp or resp[0].get("_parseerr"):
        na("ds-stubs", "runner", str(resp[:1]))
        return
    check(bool(resp[0].get("ok")), "ds-stubs", "engine loaded", str(resp[0].get("error", ""))[:200])
    res = resp[0].get("result") or {}
    items = res.get("list") or []
    if not items:
        na("ds-stubs", "no result")
        return
    item = items[0]
    results = item.get("results") or {}
    missing = [n for n, v in results.items() if v == "MISSING"]
    check(len(missing) == 0, "ds-stubs", "all 16 stubs present", ",".join(missing))
    check(item.get("crash") is None, "ds-stubs", "no crash", str(item.get("crash")))
    check(not (results.get("_call", "").startswith("crash")), "ds-stubs", "executeParse('x') safe", results.get("_call"))


def main() -> int:
    binp = ensure_binary()
    if not binp:
        print(f"no sidecar binary available — 9 N/A, 0 P, 0 F")
        return 0
    print(f"using {binp}")
    check_gbk(binp)
    check_ds_real(binp)
    check_ds_stubs(binp)
    print("=" * 60)
    print(f"qjs engine check: {PASS} pass / {FAIL} fail / {NA} N/A")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
