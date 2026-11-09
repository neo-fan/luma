#!/usr/bin/env python3
"""T-20 符号守恒脚本：对模板 jar 实跑 javap -p -s，与 stub-signatures.json 基线比对。

用法：
  python tools/javap_conserve.py                  # 默认：两个自编模板 jar + stubs.jar，不匹配数必须为 0
  python tools/javap_conserve.py --jar <path>    # 外部 jar：输出签名差异报告（只读，不改 fixture）

默认模式覆盖：
  - stubs.jar 内的 com.github.catvod.crawler.Spider（桩基类，12 方法 + 构造器）
  - template-class.jar 的 com/tvbox/fixture/TemplateSpider.class
  - template-dex.jar 的等价 .class 资源 META-INF/equivalent/TemplateSpider.bin
  (dex 形态不能直接被 javap 读取，故对其携带的「等价 class 字节」实跑 javap)

退出码：默认模式不匹配数为 0 -> 0，否则 -> 1；--jar 报告模式恒为 0。
JDK17 路径优先读环境变量 TVBOX_JDK17_BIN。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
JAVA_DIR = os.path.join(ROOT, "sidecars", "java")
STUBS_JAR = os.path.join(JAVA_DIR, "stubs.jar")
SIG_JSON = os.path.join(JAVA_DIR, "stub-signatures.json")
CLASS_JAR = os.path.join(ROOT, "tests", "fixtures", "jars", "template-class.jar")
DEX_JAR = os.path.join(ROOT, "tests", "fixtures", "jars", "template-dex.jar")
DEFAULT_JARS = [CLASS_JAR, DEX_JAR]
EQUIV_DIR = "META-INF/equivalent/"

JDK_BIN = os.environ.get("TVBOX_JDK17_BIN", "D:/software/java/oracle-jdk-17/bin")


def tool(name):
    p = os.path.join(JDK_BIN, name)
    return p + ".exe" if os.path.isfile(p + ".exe") else p


JAVAP = tool("javap")


def load_expected():
    with open(SIG_JSON, encoding="utf-8") as f:
        doc = json.load(f)
    out = {}
    for cls, spec in doc["classes"].items():
        out[cls] = {
            "source": spec.get("source", "jar"),
            "members": set(tuple(m) for m in spec["members"]),
        }
    return out


def javap_signatures(class_bytes):
    """对单个 .class 字节实跑 javap -p -s；返回 (类名, {(方法名, 描述符)})。

    只保留方法/构造器（描述符以 '(' 开头），字段描述符自动跳过。
    任意文件名均可（javap 直接读 class 文件，无需 superclass 在 classpath）。
    """
    with tempfile.TemporaryDirectory(prefix="tvbox-javap-") as td:
        cf = os.path.join(td, "Target.class")
        with open(cf, "wb") as f:
            f.write(class_bytes)
        r = subprocess.run([JAVAP, "-p", "-s", cf], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("javap 失败: " + (r.stderr.strip() or r.stdout.strip()))
    lines = r.stdout.splitlines()
    cls = None
    members = set()
    for idx, line in enumerate(lines):
        s = line.strip()
        toks = s.split()
        if cls is None and "class" in toks:
            i = toks.index("class")
            if i + 1 < len(toks):
                cls = toks[i + 1]
        if not s.startswith("descriptor:"):
            continue
        desc = s[len("descriptor:"):].strip()
        if not desc.startswith("("):
            continue  # 字段
        j = idx - 1
        while j >= 0 and not lines[j].strip():
            j -= 1
        decl = lines[j].strip() if j >= 0 else ""
        head = decl.split("(")[0].strip()
        ht = head.split()
        name = ht[-1] if ht else "?"
        if "." in name:
            name = "<init>"
        members.add((name, desc))
    return cls, members


def class_bytes_in_jar(jar, cls):
    """从 jar 取类的字节码：优先 .class 条目，其次 dex 形态的等价 .bin 资源。"""
    with zipfile.ZipFile(jar) as z:
        names = z.namelist()
        entry = cls.replace(".", "/") + ".class"
        if entry in names:
            return z.read(entry)
        equiv = EQUIV_DIR + cls.rsplit(".", 1)[-1] + ".bin"
        if equiv in names:
            return z.read(equiv)
    return None


def class_bytes_in_stubs(cls):
    with zipfile.ZipFile(STUBS_JAR) as z:
        return z.read(cls.replace(".", "/") + ".class")


def diff(exp, act):
    return sorted(exp - act), sorted(act - exp)


def fmt_member(m):
    return "    %-18s %s" % (m[0], m[1])


def check_default(expected):
    total = 0
    reports = []
    # 桩基类：只对 stubs.jar 查一次
    for cls, spec in expected.items():
        if spec["source"] != "stubs":
            continue
        try:
            _, act = javap_signatures(class_bytes_in_stubs(cls))
            miss, extra = diff(spec["members"], act)
            total += len(miss) + len(extra)
            reports.append("  [stubs.jar] %s : 期望 %d / 实测 %d / 缺失 %d / 多余不符 %d"
                           % (cls, len(spec["members"]), len(act), len(miss), len(extra)))
            for m in miss:
                reports.append("    - 缺失 " + fmt_member(m).strip())
            for m in extra:
                reports.append("    + 多出 " + fmt_member(m).strip())
        except Exception as e:
            total += len(spec["members"])
            reports.append("  [stubs.jar] %s : 读取失败 %r" % (cls, e))
    # jar 形态类：对两个模板 jar 各查一次
    for jar in DEFAULT_JARS:
        label = os.path.basename(jar)
        for cls, spec in expected.items():
            if spec["source"] != "jar":
                continue
            try:
                b = class_bytes_in_jar(jar, cls)
                if b is None:
                    total += len(spec["members"])
                    reports.append("  [%s] %s : 未找到 .class/.bin 条目" % (label, cls))
                    continue
                _, act = javap_signatures(b)
                miss, extra = diff(spec["members"], act)
                total += len(miss) + len(extra)
                reports.append("  [%s] %s : 期望 %d / 实测 %d / 缺失 %d / 多余不符 %d"
                               % (label, cls, len(spec["members"]), len(act), len(miss), len(extra)))
                for m in miss:
                    reports.append("    - 缺失 " + fmt_member(m).strip())
                for m in extra:
                    reports.append("    + 多出 " + fmt_member(m).strip())
            except Exception as e:
                total += len(spec["members"])
                reports.append("  [%s] %s : 读取失败 %r" % (label, cls, e))
    return total, reports


def check_external(jar, expected):
    reports = []
    if not os.path.isfile(jar):
        return 1, ["  外部 jar 不存在: %s" % jar]
    try:
        with zipfile.ZipFile(jar) as z:
            names = z.namelist()
    except Exception as e:
        return 1, ["  无法作为 zip/jar 打开: %r" % (e,)]

    class_entries = [n for n in names if n.endswith(".class") and not n.startswith("META-INF/")]
    equiv_entries = [n for n in names if n.startswith(EQUIV_DIR) and n.endswith(".bin")]
    if "classes.dex" in names:
        reports.append("  提示: 该 jar 含 classes.dex（dex 形态），javap 不能直接读 dex 字节码。")

    actual = {}  # 类名 -> {(name, descriptor)}
    for n in class_entries + equiv_entries:
        try:
            with zipfile.ZipFile(jar) as z:
                b = z.read(n)
            cls, members = javap_signatures(b)
            key = cls or n
            actual.setdefault(key, set()).update(members)
        except Exception as e:
            reports.append("  javap 失败 %s : %r" % (n, e))

    reports.append("  发现 %d 个可读类 / %d 个 .class 条目 / %d 个等价 .bin 资源"
                   % (len(actual), len(class_entries), len(equiv_entries)))
    for cls in sorted(actual):
        reports.append("    类 %s : %d 个成员" % (cls, len(actual[cls])))

    total = 0
    reports.append("  --- 与基线对比 ---")
    exp_classes = set(expected)
    act_classes = set(actual)
    for cls in sorted(exp_classes):
        if cls not in actual:
            n = len(expected[cls]["members"])
            total += n
            reports.append("  - 缺失类 %s (%d 个期望成员)" % (cls, n))
            continue
        miss, extra = diff(expected[cls]["members"], actual[cls])
        total += len(miss) + len(extra)
        if miss or extra:
            reports.append("  ~ 类 %s : 缺失 %d / 多余不符 %d" % (cls, len(miss), len(extra)))
        for m in miss:
            reports.append("    - 缺失 " + fmt_member(m).strip())
        for m in extra:
            reports.append("    + 多出 " + fmt_member(m).strip())
    for cls in sorted(act_classes - exp_classes):
        total += len(actual[cls])
        reports.append("  + 基线外的类 %s (%d 个成员，计入差异)" % (cls, len(actual[cls])))
    return total, reports


def main():
    ap = argparse.ArgumentParser(description="T-20 符号守恒（javap -p -s vs stub-signatures.json）")
    ap.add_argument("--jar", default=None, help="外部 jar 路径：输出只读签名差异报告")
    args = ap.parse_args()

    try:
        expected = load_expected()
    except Exception as e:
        print("无法读取基线 %s: %r" % (SIG_JSON, e), file=sys.stderr)
        return 2

    if args.jar:
        total, reports = check_external(os.path.abspath(args.jar), expected)
        print("=== T-20 外部 jar 签名差异报告（只读，不改 fixture）===")
        print("  jar: %s" % os.path.abspath(args.jar))
        for r in reports:
            print(r)
        print("不匹配数: %d" % total)
        print("（--jar 为只读差异报告，退出码恒为 0）")
        return 0

    total, reports = check_default(expected)
    print("=== T-20 符号守恒（默认：两个自编模板 jar + stubs.jar）===")
    for r in reports:
        print(r)
    print("不匹配数: %d" % total)
    print("结论: %s" % ("PASS" if total == 0 else "FAIL"))
    return 0 if total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
