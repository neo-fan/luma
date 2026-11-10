#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Luma 品牌全套应用图标生成脚本。

依赖：Pillow（实测 13.0.0；仅用 PIL.Image / PIL.ImageDraw）
用法：在项目根目录执行  python tools/build_icons.py
用途：在 4 倍超采样画布上绘制「深墨圆角方底 + 渐变圆角播放三角（+ 细圆环）」，
      再经 LANCZOS 缩小，生成：
        src-tauri/icons/icon.ico            (16/24/32/48/64/128/256，逐尺寸独立渲染)
        src-tauri/icons/icon.png            (512)
        src-tauri/icons/128x128@2x.png     (256)
        src-tauri/icons/128x128.png        (128)
        src-tauri/icons/32x32.png          (32)
        src-tauri/icons/icon-preview.png   (512 预览图)
        public/icon.svg                    (同一图形的矢量版)
      几何参数集中在设计常量区，改这里即可整套重生成；所有文本 UTF-8 无 BOM / LF。
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

# --- 路径 -------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[1]
ICONS_DIR = ROOT / "src-tauri" / "icons"
PUBLIC_DIR = ROOT / "public"
ICO_PATH = ICONS_DIR / "icon.ico"
SVG_PATH = PUBLIC_DIR / "icon.svg"

# --- 设计常量（单位：512 设计画布，与 SVG viewBox 一致）--------------------
U = 512.0
SS = 4                        # 超采样倍数

INK = (0x10, 0x13, 0x1A)      # #10131A 深墨底
C0 = (0x6E, 0x8B, 0xFF)       # #6E8BFF 渐变左上
C1 = (0x9A, 0x8C, 0xFF)       # #9A8CFF 渐变右下

PAD = 0.025 * U               # 背景圆角方形内缩，避免全幅出血
RADIUS = 0.22 * U             # 圆角半径 ~画布 22%
HI_W = 0.002 * U              # 极细高光内描边（~1px @512）
HI_ALPHA = 15                 # 白色 opacity ~0.06

RING_R = 0.35 * U             # 细圆环半径 ~画布 34%
RING_W = 0.02 * U             # 细圆环 stroke 宽 ~画布 2%
RING_ALPHA = 26               # 白色 opacity ~0.10
WITH_RING = True              # 若显杂可置 False

TRI = [                       # 圆角播放三角三顶点（指向右）
    (0.28 * U, 0.29 * U),    # 左上
    (0.28 * U, 0.71 * U),    # 左下
    (0.72 * U, 0.50 * U),    # 右尖
]
# 右尖被圆角削去约 30px，而左侧是完整直边，导致渲染后包围盒偏左、
# 且播放三角视觉重量本就偏左。整体右移 3% 画布，使渲染后包围盒正好居中。
OPTICAL_SHIFT_X = 0.03 * U
TRI = [(x + OPTICAL_SHIFT_X, y) for x, y in TRI]
TRI_R = 0.045 * U             # 三角圆角半径
ARC_STEPS = 28                # 每段圆弧采样点数
G0 = min(x + y for x, y in TRI)   # 渐变起点（沿 45° 轴的最前点）
G1 = max(x + y for x, y in TRI)   # 渐变终点

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
PNG_SPECS = [
    ("icon.png", 512),
    ("128x128@2x.png", 256),
    ("128x128.png", 128),
    ("32x32.png", 32),
]


# --- 几何工具 ---------------------------------------------------------------
def _unit(v):
    x, y = v
    length = math.hypot(x, y)
    return (x / length, y / length)


def _corner(p, pprev, pnext, r):
    """返回 (切距 t, 入边单位向量 u1, 出边单位向量 u2, 半角 half)。"""
    u1 = _unit((pprev[0] - p[0], pprev[1] - p[1]))   # 指向上一顶点
    u2 = _unit((pnext[0] - p[0], pnext[1] - p[1]))   # 指向下一顶点
    dot = max(-1.0, min(1.0, u1[0] * u2[0] + u1[1] * u2[1]))
    half = math.acos(dot) / 2.0
    return (r / math.tan(half), u1, u2, half)


def rounded_polygon(points, r, steps=ARC_STEPS):
    """圆角多边形外轮廓点列表：多边形 + 真圆弧（按较短弧采样）。"""
    n = len(points)
    out = []
    for i in range(n):
        p = points[i]
        t, u1, u2, half = _corner(p, points[(i - 1) % n], points[(i + 1) % n], r)
        ta = (p[0] + t * u1[0], p[1] + t * u1[1])   # 入边切点
        tb = (p[0] + t * u2[0], p[1] + t * u2[1])   # 出边切点
        bis = _unit((u1[0] + u2[0], u1[1] + u2[1]))
        d = r / math.sin(half)
        cx, cy = p[0] + d * bis[0], p[1] + d * bis[1]
        a1 = math.atan2(ta[1] - cy, ta[0] - cx)
        a2 = math.atan2(tb[1] - cy, tb[0] - cx)
        sweep = a2 - a1
        while sweep > math.pi:
            sweep -= 2 * math.pi
        while sweep < -math.pi:
            sweep += 2 * math.pi
        out.append(ta)
        for k in range(1, steps):
            a = a1 + sweep * k / steps
            out.append((cx + r * math.cos(a), cy + r * math.sin(a)))
        out.append(tb)
    return out


def make_gradient(ss, g0px, g1px):
    """沿 45°（x+y）方向的线性渐变，跨三角自身极值铺满 C0->C1，返回 RGB。"""
    denom = g1px - g0px
    ramp = []
    for i in range(2 * ss):
        t = (i - g0px) / denom
        t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
        ramp.append(tuple(round(C0[c] + (C1[c] - C0[c]) * t) for c in range(3)))
    strip = Image.new("RGB", (2 * ss, 1))
    strip.putdata(ramp)
    grad = Image.new("RGB", (ss, ss))
    for y in range(ss):
        grad.paste(strip.crop((y, 0, y + ss, 1)), (0, y))
    return grad


def _ri(v):
    return int(round(v))


# --- 栅格渲染 ---------------------------------------------------------------
def render(size):
    """在 size*4 超采样画布绘制，LANCZOS 缩到 size，返回 RGBA。"""
    ss = size * SS
    k = ss / U
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    box = [_ri(PAD * k), _ri(PAD * k), _ri(ss - PAD * k), _ri(ss - PAD * k)]
    radius = _ri(RADIUS * k)

    # 1) 深墨圆角方底
    bg = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    ImageDraw.Draw(bg).rounded_rectangle(box, radius=radius, fill=INK + (255,))
    img = Image.alpha_composite(img, bg)

    # 2) 极细高光内描边
    hi = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    ImageDraw.Draw(hi).rounded_rectangle(
        box, radius=radius,
        outline=(255, 255, 255, HI_ALPHA), width=max(1, _ri(HI_W * k)),
    )
    img = Image.alpha_composite(img, hi)

    # 3) 细圆环（聚焦感）
    if WITH_RING:
        ring = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
        c = ss / 2
        ImageDraw.Draw(ring).ellipse(
            [_ri(c - RING_R * k), _ri(c - RING_R * k),
             _ri(c + RING_R * k), _ri(c + RING_R * k)],
            outline=(255, 255, 255, RING_ALPHA), width=max(1, _ri(RING_W * k)),
        )
        img = Image.alpha_composite(img, ring)

    # 4) 渐变圆角播放三角
    tri_px = [(x * k, y * k) for x, y in TRI]
    mask = Image.new("L", (ss, ss), 0)
    pts = [(_ri(x), _ri(y)) for x, y in rounded_polygon(tri_px, TRI_R * k)]
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    grad = make_gradient(ss, G0 * k, G1 * k).convert("RGBA")
    grad.putalpha(mask)
    img = Image.alpha_composite(img, grad)

    return img.resize((size, size), Image.LANCZOS)


_cache = {}


def get(size):
    if size not in _cache:
        _cache[size] = render(size)
    return _cache[size]


def build_preview():
    """512 预览图：大图 + 一排小尺寸，便于检查 16..256 的可辨性。"""
    PV = 512
    canvas = Image.new("RGBA", (PV, PV), (0x26, 0x2B, 0x36, 255))
    big = get(320)
    canvas.alpha_composite(big, ((PV - 320) // 2, 16))
    smalls = [128, 64, 48, 32, 24, 16]
    gap = 12
    total = sum(smalls) + gap * (len(smalls) - 1)
    x = (PV - total) // 2
    yc = 430
    for s in smalls:
        canvas.alpha_composite(get(s), (x, yc - s // 2))
        x += s + gap
    return canvas


# --- SVG（同一图形）---------------------------------------------------------
def _num(v):
    s = f"{v:.2f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".") or "0"
    return s


def build_svg():
    """由同一套几何常量生成 SVG 字符串（无 base64 / 无外链）。"""
    bx0 = PAD
    bw = U - 2 * PAD
    rx = RADIUS
    hw = 1.0                                  # 1px 高光内描边
    ibx0 = bx0 + hw / 2                      # 内缩半个描边宽 -> 纯内描边
    ibw = bw - hw
    irx = rx - hw / 2
    rr = RING_R - RING_W / 2                 # 中心描边，外缘对齐 RING_R
    gx1 = gy1 = G0 / 2                       # userSpaceOnUse 渐变端点
    gx2 = gy2 = G1 / 2

    # 圆角三角：每个顶点用二次贝塞尔（控制点 = 原顶点）近似圆角
    n = len(TRI)
    segs = []
    for i in range(n):
        p = TRI[i]
        t, u1, u2, _ = _corner(p, TRI[(i - 1) % n], TRI[(i + 1) % n], TRI_R)
        tn = (p[0] + t * u1[0], p[1] + t * u1[1])   # 入边切点
        tp = (p[0] + t * u2[0], p[1] + t * u2[1])   # 出边切点
        segs.append((tn, p, tp))
    d = f"M {_num(segs[0][0][0])} {_num(segs[0][0][1])}"
    for i in range(n):
        _, p, tp = segs[i]
        d += f" Q {_num(p[0])} {_num(p[1])} {_num(tp[0])} {_num(tp[1])}"
        nxt = segs[(i + 1) % n][0]
        d += f" L {_num(nxt[0])} {_num(nxt[1])}"
    d += " Z"

    ring = (
        f'  <circle cx="{_num(U / 2)}" cy="{_num(U / 2)}" r="{_num(rr)}" '
        f'fill="none" stroke="#FFFFFF" stroke-opacity="0.10" '
        f'stroke-width="{_num(RING_W)}"/>\n'
    ) if WITH_RING else ""

    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        'width="512" height="512" role="img" aria-label="Luma">\n'
        '  <defs>\n'
        f'    <linearGradient id="lumaGrad" gradientUnits="userSpaceOnUse" '
        f'x1="{_num(gx1)}" y1="{_num(gy1)}" x2="{_num(gx2)}" y2="{_num(gy2)}">\n'
        '      <stop offset="0" stop-color="#6E8BFF"/>\n'
        '      <stop offset="1" stop-color="#9A8CFF"/>\n'
        '    </linearGradient>\n'
        '  </defs>\n'
        f'  <rect x="{_num(bx0)}" y="{_num(bx0)}" width="{_num(bw)}" '
        f'height="{_num(bw)}" rx="{_num(rx)}" fill="#10131A"/>\n'
        f'  <rect x="{_num(ibx0)}" y="{_num(ibx0)}" width="{_num(ibw)}" '
        f'height="{_num(ibw)}" rx="{_num(irx)}" fill="none" stroke="#FFFFFF" '
        f'stroke-opacity="0.06" stroke-width="{_num(hw)}"/>\n'
        f'{ring}'
        f'  <path d="{d}" fill="url(#lumaGrad)"/>\n'
        '</svg>\n'
    )


# --- 主流程 -----------------------------------------------------------------
def main():
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    outputs = []

    # ICO：逐尺寸独立渲染，用 append_images 保留各帧
    frames = {s: get(s) for s in ICO_SIZES}
    others = [frames[s] for s in ICO_SIZES[:-1]]
    frames[ICO_SIZES[-1]].save(
        ICO_PATH, format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=others,
    )
    outputs.append(ICO_PATH)

    for name, size in PNG_SPECS:
        p = ICONS_DIR / name
        get(size).save(p, format="PNG")
        outputs.append(p)

    preview = ICONS_DIR / "icon-preview.png"
    build_preview().save(preview, format="PNG")
    outputs.append(preview)

    SVG_PATH.write_text(build_svg(), encoding="utf-8", newline="\n")
    outputs.append(SVG_PATH)

    # 重新打开 ICO 验证尺寸数量
    with Image.open(ICO_PATH) as ico:
        sizes_in = sorted(ico.info.get("sizes", []))
    assert len(sizes_in) == len(ICO_SIZES), f"ICO 尺寸数量不符：{sizes_in}"

    print("\n== 生成文件 ==")
    for p in outputs:
        print(f"  {p.relative_to(ROOT).as_posix()}  {p.stat().st_size} bytes")
    print(f"\n== ICO 内含尺寸（共 {len(sizes_in)} 个）==")
    print("  " + ", ".join(f"{w}x{h}" for w, h in sizes_in))


if __name__ == "__main__":
    main()
