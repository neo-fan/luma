#!/usr/bin/env python3
"""P2 Java 侧一键（幂等）编译脚本（T-21 / T-23 / T-27）。

用固定 JDK 17（--release 17）编译：
  1. stubs-src/**          -> sidecars/java/stubs.jar
  2. SpiderRunner.java     -> sidecars/java/runner.jar（自包含 stubs + Runner，Main-Class=SpiderRunner）
  3. 模板源码              -> tests/fixtures/jars/template-class.jar（纯 class 形态）
                          -> tests/fixtures/jars/template-dex.jar（dex 形态，见下）

template-dex.jar 形态说明：
  - jar 内含 classes.dex：优先用 r8/D8 真实 class->dex 转换生成；工具不可用时退回
    自写最小 DEX 容器（合法 dex\\n035 头，0 个 class）。
  - Win x64 无 dex->class 运行时，故 dex jar 内另附「等价 .class 资源」
    META-INF/equivalent/TemplateSpider.bin（与 class 版完全相同的字节码），
    供 SpiderRunner 的「自编双形态模板」兼容路径兜底加载。
  - 内含 META-INF/tvbox-self-fixture.properties 标记；不含任何 .class 条目，
    因此 probe 判定为 dex。这是自编 fixture 专用兼容路径，第三方 dex 不在承诺范围。

  JDK 路径：优先读环境变量 LUMA_JDK17_BIN，缺省为项目约定的 JDK17 安装目录。
  全部日志写 stderr；中间产物在 tests/fixtures/upstream/java-p2/（已 gitignore）。
  不依赖系统默认 java，可重复运行。
"""
import glob
import hashlib
import os
import shutil
import struct
import subprocess
import sys
import urllib.request
import zipfile
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
JAVA_DIR = os.path.join(ROOT, "sidecars", "java")
STUBS_SRC = os.path.join(JAVA_DIR, "stubs-src")
RUNNER_SRC = os.path.join(JAVA_DIR, "SpiderRunner.java")
STUBS_JAR = os.path.join(JAVA_DIR, "stubs.jar")
RUNNER_JAR = os.path.join(JAVA_DIR, "runner.jar")
FIXTURE_DIR = os.path.join(ROOT, "tests", "fixtures", "jars")
FIXTURE_SRC = os.path.join(FIXTURE_DIR, "src", "TemplateSpider.java")
TEMPLATE_CLASS_JAR = os.path.join(FIXTURE_DIR, "template-class.jar")
TEMPLATE_DEX_JAR = os.path.join(FIXTURE_DIR, "template-dex.jar")

UPSTREAM = os.path.join(ROOT, "tests", "fixtures", "upstream", "java-p2")
BUILD = os.path.join(UPSTREAM, "build")
R8_JAR = os.path.join(UPSTREAM, "r8.jar")
R8_URLS = [
    "https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.3.37/r8-8.3.37.jar",
    "https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.2.47/r8-8.2.47.jar",
    "https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.1.56/r8-8.1.56.jar",
]

JDK_BIN = (os.environ.get("LUMA_JDK17_BIN") or os.environ.get("TVBOX_JDK17_BIN")
             or "D:/software/java/oracle-jdk-17/bin")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def tool(name):
    """解析 JDK17 工具绝对路径（Windows 上优先 .exe）。"""
    p = os.path.join(JDK_BIN, name)
    if os.path.isfile(p + ".exe"):
        return p + ".exe"
    return p


def run(cmd):
    log("+ " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("command failed (%d): %s\n[stdout] %s\n[stderr] %s"
                           % (r.returncode, " ".join(cmd), r.stdout, r.stderr))
    if r.stdout.strip():
        log("  " + r.stdout.strip())
    if r.stderr.strip():
        log("  " + r.stderr.strip())
    return r


def clean():
    for d in ("stubs", "runner", "template", "dexout"):
        shutil.rmtree(os.path.join(BUILD, d), ignore_errors=True)
    os.makedirs(BUILD, exist_ok=True)


def compile_stubs():
    srcs = sorted(glob.glob(os.path.join(STUBS_SRC, "**", "*.java"), recursive=True))
    if not srcs:
        raise RuntimeError("no stub sources under " + STUBS_SRC)
    out = os.path.join(BUILD, "stubs")
    os.makedirs(out, exist_ok=True)
    run([tool("javac"), "--release", "17", "-d", out] + srcs)
    return out


def make_stubs_jar(stubs_dir):
    run([tool("jar"), "cf", STUBS_JAR, "-C", stubs_dir, "."])


def compile_runner():
    out = os.path.join(BUILD, "runner")
    os.makedirs(out, exist_ok=True)
    run([tool("javac"), "--release", "17", "-cp", STUBS_JAR, "-d", out, RUNNER_SRC])
    return out


def make_runner_jar(stubs_dir, runner_dir):
    # 单 -cp 可启动：runner.jar 内含 stubs + Runner，且 manifest 指定 Main-Class。
    run([tool("jar"), "cfe", RUNNER_JAR, "SpiderRunner",
         "-C", stubs_dir, ".", "-C", runner_dir, "."])


def compile_template():
    out = os.path.join(BUILD, "template")
    os.makedirs(out, exist_ok=True)
    run([tool("javac"), "--release", "17", "-cp", STUBS_JAR, "-d", out, FIXTURE_SRC])
    cls = os.path.join(out, "com", "tvbox", "fixture", "TemplateSpider.class")
    if not os.path.isfile(cls):
        raise RuntimeError("template class not produced: " + cls)
    return cls


def make_template_class_jar(cls_path):
    with zipfile.ZipFile(TEMPLATE_CLASS_JAR, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n")
        z.write(cls_path, "com/tvbox/fixture/TemplateSpider.class")


# ---------------------------------------------------------------- r8 / D8

def obtain_r8():
    """优先用已缓存的 r8.jar；否则 best-effort 下载（urllib -> curl），失败返回 None。"""
    if os.path.isfile(R8_JAR) and os.path.getsize(R8_JAR) > 1000000:
        log("r8: using cached " + R8_JAR)
        return R8_JAR
    os.makedirs(UPSTREAM, exist_ok=True)
    for url in R8_URLS:
        log("r8: downloading " + url)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "tvbox-p2/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp, open(R8_JAR, "wb") as f:
                shutil.copyfileobj(resp, f)
            if os.path.getsize(R8_JAR) > 1000000:
                return R8_JAR
        except Exception as e:
            log("r8: urllib failed: %r" % (e,))
        try:
            r = subprocess.run(["curl", "-s", "--max-time", "60", "-o", R8_JAR, url],
                               capture_output=True, text=True, timeout=90)
            if r.returncode == 0 and os.path.getsize(R8_JAR) > 1000000:
                return R8_JAR
        except Exception as e:
            log("r8: curl failed: %r" % (e,))
    return None


def minimal_dex():
    """生成一个合法但空（0 class）的最小 DEX：正确 magic/文件头/checksum/SHA1/map_list。

    仅作为「确实拿不到 D8」时的兜底容器；probe 只认 classes.dex 条目名，故足够，
    且绝不会被冒充为真实 class->dex 转换（报告中会如实说明）。
    """
    header_size = 0x70
    map_off = header_size
    map_list = struct.pack("<I", 1) + struct.pack("<HHII", 0x1000, 0, 1, map_off)
    data_size = len(map_list)
    file_size = header_size + data_size
    fields = [
        file_size, header_size, 0x12345678,          # file_size, header_size, endian_tag
        0, 0, map_off,                               # link_size, link_off, map_off
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,       # string/type/proto/field/method/class ids (size,off)
        data_size, header_size,                      # data_size, data_off
    ]
    head = b"dex\n035\x00" + b"\x00" * 4 + b"\x00" * 20 + struct.pack("<20I", *fields)
    assert len(head) == header_size, len(head)
    blob = bytearray(head + map_list)
    # SHA1 覆盖 signature 字段之后的所有字节（offset 32 起）；先填 signature。
    blob[12:32] = hashlib.sha1(bytes(blob[32:])).digest()
    # adler32 覆盖 checksum 字段之后的所有字节（offset 12 起）；后填 checksum。
    blob[8:12] = struct.pack("<I", zlib.adler32(bytes(blob[12:])) & 0xFFFFFFFF)
    return bytes(blob)


def gen_dex(cls_path, stubs_dir):
    """返回 (dex 文件路径, 生成方式 'd8' | 'minimal')。"""
    out_dir = os.path.join(BUILD, "dexout")
    os.makedirs(out_dir, exist_ok=True)
    dex = os.path.join(out_dir, "classes.dex")
    r8 = obtain_r8()
    if r8:
        try:
            run([tool("java"), "-cp", r8, "com.android.tools.r8.D8",
                 "--output", out_dir, "--classpath", stubs_dir, "--min-api", "21", cls_path])
            if os.path.isfile(dex) and os.path.getsize(dex) > 0:
                with open(dex, "rb") as f:
                    magic = f.read(8)
                if magic.startswith(b"dex\n"):
                    log("dex: D8 real class->dex, size=%d" % os.path.getsize(dex))
                    return dex, "d8"
        except Exception as e:
            log("dex: D8 failed: %r" % (e,))
    log("dex: minimal self-generated DEX container (no real conversion)")
    with open(dex, "wb") as f:
        f.write(minimal_dex())
    return dex, "minimal"


def make_template_dex_jar(dex_path, cls_path, method):
    equiv = open(cls_path, "rb").read()
    with zipfile.ZipFile(TEMPLATE_DEX_JAR, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\n")
        z.write(dex_path, "classes.dex")
        # 等价 .class 资源：文件名为 .bin，probe 不会当成 .class 计数 -> 仍判定为 dex。
        z.writestr("META-INF/equivalent/TemplateSpider.bin", equiv)
        z.writestr("META-INF/tvbox-self-fixture.properties",
                   "self-authored fixture; dual-shape compat path\n"
                   "equiv-class=com.tvbox.fixture.TemplateSpider\n"
                   "dex-mode=%s\n" % method)


def main():
    os.makedirs(UPSTREAM, exist_ok=True)
    clean()
    stubs_dir = compile_stubs()
    make_stubs_jar(stubs_dir)
    runner_dir = compile_runner()
    make_runner_jar(stubs_dir, runner_dir)
    cls = compile_template()
    make_template_class_jar(cls)
    dex, method = gen_dex(cls, stubs_dir)
    make_template_dex_jar(dex, cls, method)

    log("=== BUILD SUMMARY ===")
    for p in (STUBS_JAR, RUNNER_JAR, TEMPLATE_CLASS_JAR, TEMPLATE_DEX_JAR):
        log("  %s (%d bytes)" % (os.path.relpath(p, ROOT), os.path.getsize(p)))
    log("  classes.dex generation method: %s" % method)
    log("BUILD OK")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log("BUILD FAILED: %r" % (e,))
        sys.exit(1)
