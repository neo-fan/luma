# 体积报告（便携版 · 实测）

> 口径：字节数取自本机实测（`find -printf %s` 累加），1 MB = 1024×1024 字节，保留两位小数。
> **最近一次实测：2026-11-13 包**（`release/Luma-1.0.0-alpha-portable.zip`，由 `python tools/make_portable.py` 生成）。
> 历史：2026-11-10 首次 T-32 实测（当时命名仍为 TVBox Desktop、exe 未静态链接 SQLite）。

## 便携版目录（压缩前，`release/portable/Luma/`）

| 项 | 路径（相对包根） | 体积 |
|---|---|---:|
| 主程序 | `Luma.exe` | 17.50 MB |
| QuickJS 侧载 | `qjs-runner.exe` | 3.14 MB |
| Python 适配层源码 | `sidecars/py/` | 0.09 MB |
| Python embeddable（含 8 个第三方包） | `sidecars/python-embed/` | 47.81 MB |
| jlink 裁剪 JRE（JDK 17） | `sidecars/jre/` | 26.24 MB |
| SpiderRunner | `sidecars/java/runner.jar` | 0.03 MB |
| JS 随包依赖（8 个模块 + manifest） | `sidecars/qjs-assets/` | 0.95 MB |
| 便携数据目录 | `data/` | 0.00 MB |
| **合计** | | **98.91 MB** |

mpv（可选，默认不打进 zip）：`sidecars/mpv/mpv.exe` 单文件 **116.83 MB**。

## 分发包（压缩后）

| 产物 | 路径 | 体积 |
|---|---|---:|
| 便携版 zip | `release/Luma-1.0.0-alpha-portable.zip` | **45.80 MB** |

## 判定

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 便携版分发包 | ≤ 45 MB | 45.80 MB | **未达标（超 1.8%）** |
| 通用上限 | ≤ 130 MB | 45.80 MB | 通过 |

与 2026-11-10 首次实测（41.36 MB）的增量来自三处：主程序由 15.00 → 17.50 MB（`rusqlite bundled` 静态链接 SQLite）、新增 `qjs-runner.exe` 3.14 MB、新增 `qjs-assets` 0.95 MB。

若要回到 45 MB 以内，按收益排序的可选手段：

1. **`Luma.exe` 加 `strip = "symbols"` / `lto = true`**（`src-tauri/Cargo.toml` 的 release profile），预计省 2~4 MB，无功能影响，首选。
2. `dlltool` 无关；**JRE 再收一个模块集**（当前已是 `java.base,java.net.http,java.logging,jdk.unsupported`，无更多可裁空间）。
3. `python-embed` 里的 `cryptography`（含大型 `_openssl` pyd）是最大单包；若确认无源依赖它，可移出随包并要求按需安装——但会降低开箱可用率，不推荐。
4. 或者把目标放宽到 50 MB（规格原定 45 MB，属可谈判项，需用户确认）。

## 说明与偏差

1. **jlink JRE 26.24 MB**，低于规格预计的 40~60 MB。命令与模块集按规格 13 节执行（`java.base,java.net.http,java.logging,jdk.unsupported` + `--strip-debug --no-man-pages --no-header-files --compress=2`），JDK 17.0.12。
2. **Python embeddable 从 74.27 MB 降到 47.81 MB**：打包时排除 `Scripts/`、`__pycache__/`、`pip`、`setuptools`、`wheel` 及其 `*.dist-info`（这些只服务构建期）；源目录未改动，需要 pip 时仍可用。8 个运行期依赖（requests / urllib3 / lxml / pyquery / cssselect / pycryptodome / cryptography / beautifulsoup4）全部保留。
3. **`qjs-runner.exe` 放在包根目录**（不是 `sidecars/` 下）：运行时按「exe 同目录」优先命中，`make_portable.py` 另在 `sidecars/qjs-runner/` 放一份 resource_dir 布局副本。
4. **mpv 不打进 zip**：单文件 116.83 MB，会把分发包推到 ~85 MB；需要时放入 `sidecars/mpv/` 或用 `--with-mpv` 重新打包。
5. **不产出 NSIS 安装包**（用户要求解压即用）：`bundle.targets` 置空，`tools/make_portable.py` 负责组装文件夹与 zip。
6. 运行时路径按 `paths::sidecar_roots()` 多候选探测（resource 目录、exe 目录、其父目录、源码根），便携版已用 `LUMA_SELFCHECK=1` 实测：`data/selfcheck.log` 返回 `ping ok`，子进程命令行指向 `sidecars/python-embed/python.exe`。
7. **`release/portable/Luma.old-20261113/` 是上一次打包的备份目录**，不参与 zip；确认新版可用后可手工删除以省 ~93 MB 磁盘。
8. 未签名 exe 会触发 SmartScreen，见 `README.md`。
