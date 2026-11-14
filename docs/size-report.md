# 体积报告（便携版 · 实测）

> 口径：字节数取本机实测，1 MB = 1024×1024 字节，保留两位小数。
> **当前版本：1.0.0**（2026-11-14，`release/Luma-1.0.0-portable.zip`，由 `python tools/make_portable.py --skip-build` 组装；release exe 由 `cargo build --release` 产出，5m38s）。
> 历史：2026-11-13 的 `1.0.0-alpha` 包为 45.80 MB（未达标）；2026-11-10 首次 T-32 实测 41.36 MB（当时命名 TVBox Desktop、exe 未静态链接 SQLite）。

## 便携版目录（压缩前，`release/portable/Luma/`）

| 项 | 路径（相对包根） | 体积 |
|---|---|---:|
| 主程序 | `Luma.exe` | 17.67 MB |
| QuickJS 侧载 | `qjs-runner.exe` | 3.14 MB |
| Python 适配层源码 | `sidecars/py/` | 0.09 MB |
| Python embeddable（含 8 个第三方包） | `sidecars/python-embed/` | 47.81 MB |
| jlink 裁剪 JRE（JDK 17） | `sidecars/jre/` | 26.24 MB |
| SpiderRunner | `sidecars/java/runner.jar` | 0.03 MB |
| JS 随包依赖（8 个模块 + manifest） | `sidecars/qjs-assets/` | 0.95 MB |
| 便携数据目录 | `data/`（仅 `.keep`） | 0.00 MB |
| **合计** | | **95.94 MB** |

mpv（可选，默认不打进 zip）：`sidecars/mpv/mpv.exe` 单文件约 116.83 MB。

## 分发包（压缩后）

| 产物 | 路径 | 体积 |
|---|---|---:|
| 便携版 zip | `release/Luma-1.0.0-portable.zip` | **44.36 MB** |

- 条目数：1001；zip 内压缩数据合计 44.15 MB（差额为 zip 元数据）。
- `zipfile.ZIP_DEFLATED`，`compresslevel=9`。
- SHA256：`2f7272f905fb88c708a1e19a0dfce6fb3d4e687d2888db3c197f9e0d6c88a07b`。
- 静态验收：`Luma.exe` / `qjs-runner.exe` / `sidecars/py/main.py` / `python-embed/python.exe` / `jre/bin/java.exe` / `java/runner.jar` / `qjs-assets/manifest.json` 全部存在；无外部地址或真实配置残留。

## 判定

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 便携版分发包 | ≤ 45 MB | **44.36 MB** | ✅ **达标** |
| 通用上限 | ≤ 130 MB | 44.36 MB | 通过 |

### 从 45.80 MB 降到 44.36 MB 做了什么

1. **移除 `qjs-runner.exe` 的死副本（省 1.50 MB，主因）**：`quickjs.rs::resolve_runner()` 只查 `LUMA_QJS_RUNNER` → exe 同目录 → 编译期 `source_root/sidecars/qjs-runner/target/{release,debug}`，**从不查** `sidecars/qjs-runner/qjs-runner.exe`。`make_portable.py` 原先按「resource_dir 布局」多放一份，运行期永不命中，1.0.0 已删除该落点并修正注释。zip 内 `qjs-runner.exe` 副本数由 2 → 1。
2. **`[profile.release] strip = "symbols"`**：实测 exe 17.50 → 17.67 MB，**未带来体积收益**（Tauri release 模板已做等价处理）。作为常规 release 优化保留，debug 构建不受影响；如需符号化 release 堆栈可去掉。
3. 未删任何运行时产物、未降低 `python-embed` 依赖完整度、未放宽目标。

> 这就是 1.0.0 采用的方案——**消除真实冗余**，而不是删功能或谈目标。若后续再超 45 MB，按收益排序的剩余手段：`lto = "thin"` / `codegen-units = 1` 回压 exe；JRE 模块集已收到最小（`java.base,java.net.http,java.logging,jdk.unsupported`）；`cryptography` 的 `_rust.pyd`（压缩后 3.37 MB）是最大单包，移除会降开箱可用率，不推荐；最后才是把目标放宽到 50 MB。

## 说明与偏差

1. **jlink JRE 26.24 MB**，低于规格预计的 40~60 MB。模块集 `java.base,java.net.http,java.logging,jdk.unsupported` + `--strip-debug --no-man-pages --no-header-files --compress=2`，JDK 17.0.12。运行期由 `paths::sidecar_roots()` 优先命中随包 JRE，**用户无需安装 JDK 17**。
2. **Python embeddable 从 74.27 MB 降到 47.81 MB**：打包时排除 `Scripts/`、`__pycache__/`、`pip`、`setuptools`、`wheel` 及其 `*.dist-info`（只服务构建期）；源目录未改动。8 个运行期依赖（requests / urllib3 / lxml / pyquery / cssselect / pycryptodome / cryptography / beautifulsoup4）全部保留，`prepare_runtime.py --check` 校验通过。
3. **`qjs-runner.exe` 只放包根一份**：exe 同目录是 `resolve_runner()` 在便携版上的唯一有效命中点；编译期 `source_root` 路径在分发到其它机器后天然失效，故不需要 sidecars 布局副本。
4. **mpv 不打进 zip**：单文件 116.83 MB，会把分发包推到 ~85 MB；需要时放入 `sidecars/mpv/` 或用 `--with-mpv` 重新打包。
5. **不产出 NSIS 安装包**（用户要求解压即用）：`bundle.targets` 置空，`tools/make_portable.py` 负责组装文件夹与 zip。
6. 运行时路径按 `paths::sidecar_roots()` 多候选探测（resource 目录、exe 目录、其父目录、源码根）。历史版本曾用 `LUMA_SELFCHECK=1` 实测 `ping ok`；**1.0.0 本次仅做静态验收**（zip 结构 / 关键文件 / SHA256），GUI 启动冒烟与 `LUMA_SELFCHECK` 留待本地确认，按 `docs/RELEASING.md` 清单执行。
7. 旧备份目录（`Luma.old-20261113`、`_prev-Luma-alpha`）与 `1.0.0-alpha` zip 已在整理阶段清除，`release/` 当前只保留 1.0.0 产物。
8. 未签名 exe 会触发 SmartScreen，见 `README.md`。
