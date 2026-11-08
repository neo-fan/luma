#!/usr/bin/env python3
"""Generate the application icon set used by Tauri bundling.

Pure standard library: builds a 32x32 BGRA icon (dark rounded square + play
triangle) and writes a single-image .ico to src-tauri/icons/icon.ico.

Usage:
    python3 tools/make_icon.py
"""

from __future__ import annotations

import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons" / "icon.ico"
SIZE = 32

BG = (0x1B, 0x1E, 0x24, 0xFF)
ACCENT = (0x4C, 0x8D, 0xFF, 0xFF)
FG = (0xE8, 0xEA, 0xED, 0xFF)


def inside_rounded(x: int, y: int, radius: int) -> bool:
    if radius <= x < SIZE - radius or radius <= y < SIZE - radius:
        return 0 <= x < SIZE and 0 <= y < SIZE
    cx = radius if x < radius else SIZE - 1 - radius
    cy = radius if y < radius else SIZE - 1 - radius
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def triangle(x: int, y: int) -> bool:
    # 播放三角：左边界 x=12，斜边从 (12,9) 到 (23,16) 再到 (12,23)
    if not 12 <= x <= 23 or not 9 <= y <= 23:
        return False
    left = 12
    return x - left <= (y - 9) if y <= 16 else x - left <= (23 - y)


def pixels() -> bytes:
    rows = []
    for y in range(SIZE - 1, -1, -1):  # BMP 为自底向上
        for x in range(SIZE):
            if not inside_rounded(x, y, 6):
                rows.append(b"\x00\x00\x00\x00")
            elif triangle(x, y):
                rows.append(bytes((FG[2], FG[1], FG[0], FG[3])))
            elif inside_rounded(x, y, 7):
                rows.append(bytes((ACCENT[2], ACCENT[1], ACCENT[0], ACCENT[3])))
            else:
                rows.append(bytes((BG[2], BG[1], BG[0], BG[3])))
    return b"".join(rows)


def main() -> int:
    xor = pixels()
    and_mask = b"\x00" * (SIZE * 4)  # 每行 4 字节对齐，32 行
    header = struct.pack("<IiiHHIIiiII", 40, SIZE, SIZE * 2, 1, 32, 0, len(xor), 0, 0, 0, 0)
    image = header + xor + and_mask
    icondir = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", SIZE, SIZE, 0, 0, 1, 32, len(image), 22)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(icondir + entry + image)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
