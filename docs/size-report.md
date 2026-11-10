# 体积报告（T-32 实测 · 便携版）

> 口径：字节数取自本机实测（`Path.stat()` / `rglob`），1 MB = 1024×1024 字节，保留两位小数。
> 构建时间：2026-11-10；`python tools/make_portable.py`（`cargo build --release` + 组装 + zip）。

## 便携版目录（压缩前）

| 项 | 路径（相对 `dist/portable/TVBox Desktop/`） | 体积 |
|---|---|---:|
| 主程序 | `TVBox Desktop.exe` | 15.00 MB |
| Python 适配层源码 | `sidecars/py/` | 0.04 MB |
| Python embeddable（含 8 个第三方包） | `sidecars/python-embed/` | 47.81 MB |
| jlink 裁剪 JRE（JDK 17） | `sidecars/jre/` | 26.24 MB |
| SpiderRunner | `sidecars/java/runner.jar` | 0.03 MB |
| 便携数据目录 | `data/` | 0.00 MB |
| **合计** | | **89.13 MB** |

mpv（可选，默认不打进 zip）：`sidecars/mpv/mpv.exe` 单文件 **116.83 MB**。

## 分发包（压缩后）

| 产物 | 路径 | 体积 |
|---|---|---:|
| 便携版 zip | `dist/TVBox-Desktop-0.1.0-portable.zip` | **41.36 MB** |

## 判定

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 便携版分发包 | ≤ 45 MB | 41.36 MB | 通过 |
| 通用上限 | ≤ 130 MB | 41.36 MB | 通过 |

## 说明与偏差

1. **jlink JRE 26.24 MB**，低于规格预计的 40~60 MB。命令与模块集完全按 13 节执行
   （`java.base,java.net.http,java.logging,jdk.unsupported` + `--strip-debug --no-man-pages
   --no-header-files --compress=2`），JDK 17.0.12。
2. **Python embeddable 从 74.27 MB 降到 47.81 MB**：打包时排除 `Scripts/`、`__pycache__/`、
   `pip`、`setuptools`、`wheel` 及其 `*.dist-info`（这些只服务构建期）；源目录未改动，
   需要 pip 时仍可用。8 个运行期依赖（requests / urllib3 / lxml / pyquery / cssselect /
   pycryptodome / cryptography / beautifulsoup4）全部保留。
3. **mpv 不打进 zip**：单文件 116.83 MB，会把分发包推到 ~85MB；按规格「mpv 可按需下载」处理，
   需要时放入 `sidecars/mpv/` 或用 `--with-mpv` 重新打包。
4. **不产出 NSIS 安装包**（用户要求解压即用）：`bundle.targets` 置空，
   `tools/make_portable.py` 负责组装文件夹与 zip。
5. 运行时路径按 `paths::sidecar_roots()` 多候选探测（resource 目录、exe 目录、其父目录、源码根），
   便携版已用 `TVBOX_SELFCHECK=1` 实测：`data/selfcheck.log` 返回 `ping ok`，子进程命令行指向
   `sidecars/python-embed/python.exe`。
6. 未签名 exe 会触发 SmartScreen，见 `README.md`。
