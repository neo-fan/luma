# 体积报告（NSIS 安装版 · 实测）

> 口径：字节数取本机实测，1 MiB = 1024×1024 字节，MB 保留两位小数。
> **当前版本：1.0.1**（2026-11-14，由官方 `corepack pnpm tauri build` 产出 `src-tauri/target/release/bundle/nsis/Luma_1.0.1_x64-setup.exe`，构建日志显示 **40.48 MiB**）。
> 历史：2026-11-14 的 `1.0.0` 为 40.38 MiB；2026-11-13 的 `1.0.0-alpha` 便携包为 45.80 MB（未达标）；2026-11-10 首次 T-32 实测便携包 41.36 MB（当时命名 TVBox Desktop、exe 未静态链接 SQLite）。自 `1.0.0` 起**不再产出便携 zip**，交付物统一为 NSIS 安装器。

## 安装后目录（解包，相对安装根）

| 项 | 路径（相对安装根） | 体积 |
|---|---|---:|
| 主程序 | `Luma.exe` | 18.10 MB |
| QuickJS 侧载 | `qjs-runner.exe` | 3.14 MB |
| Python 适配层源码 | `sidecars/py/` | 0.09 MB |
| Python embeddable（含 8 个第三方包） | `sidecars/python-embed/` | 47.81 MB |
| jlink 裁剪 JRE（JDK 17） | `sidecars/jre/` | 26.24 MB |
| SpiderRunner | `sidecars/java/runner.jar` | 0.03 MB |
| JS 随包依赖（8 个模块 + manifest） | `sidecars/qjs-assets/` | 0.95 MB |
| 数据目录 | `data/`（仅 `.keep`） | 0.00 MB |
| **合计** | | **96.37 MB** |

> 1.0.1 只改了 Rust 源码（子进程 `CREATE_NO_WINDOW`），运行时产物与 1.0.0 完全一致；除 `Luma.exe` 实测 17.67 → 18.10 MB（+0.43 MB，含新版前端产物）外，其余行沿用 1.0.0 实测值。

mpv（可选，默认不打进安装包）：`sidecars/mpv/mpv.exe` 单文件约 116.83 MB。

## 分发包（压缩后）

| 产物 | 路径 | 体积 |
|---|---|---:|
| NSIS 安装器 | `src-tauri/target/release/bundle/nsis/Luma_1.0.1_x64-setup.exe` | **40.48 MiB**（磁盘约 42.5 MB） |

- NSIS 用 LZMA 把解包后约 96.37 MB 的运行时压缩进单一安装器；安装器内还含 `luma.exe`（前端已嵌入）。
- 随包运行时（JRE/Python/mpv/binaries）**不入库**，由 `tools/prepare_runtime.py` 重建；安装器只负责把它们落到安装目录。
- 构建即验收：`tauri build` 退出码 0、产物存在、`luma.exe` 内含 `1.0.1` 与 `dev.luma.desktop`、且能命中应用专属 JS chunk（`usePlayerEngine`）；GUI 启动冒烟与 `LUMA_SELFCHECK` 按计划本地确认。

## 判定

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| NSIS 安装器 | ≤ 130 MB | **40.48 MiB** | ✅ **达标** |
| 通用上限 | ≤ 130 MB | 40.48 MiB | 通过 |

### 体积是怎么压下来的

1. **移除 `qjs-runner.exe` 的死副本（省 1.50 MB，主因）**：`quickjs.rs::resolve_runner()` 只查 `LUMA_QJS_RUNNER` → exe 同目录 → 编译期 `source_root/sidecars/qjs-runner/target/{release,debug}`，**从不查** `sidecars/qjs-runner/qjs-runner.exe`。旧打包流程原先按「resource_dir 布局」多放一份，运行期永不命中，1.0.0 已删除该落点。`qjs-runner.exe` 现只经 `bundle.externalBin` 随安装器落一份到安装根。
2. **`[profile.release] strip = "symbols"`**：实测 exe 17.50 → 17.67 MB，**未带来体积收益**（Tauri release 模板已做等价处理）。作为常规 release 优化保留，debug 构建不受影响。
3. 未删任何运行时产物、未降低 `python-embed` 依赖完整度、未放宽目标。

> 体积优化原则——**消除真实冗余**，而不是删功能或谈目标。若后续再涨，按收益排序的剩余手段：`lto = "thin"` / `codegen-units = 1` 回压 exe；JRE 模块集已收到最小（`java.base,java.net.http,java.logging,jdk.unsupported`）；`cryptography` 的 `_rust.pyd`（压缩后 3.37 MB）是最大单包，移除会降开箱可用率，不推荐。

## 说明与偏差

1. **jlink JRE 26.24 MB**，低于规格预计的 40~60 MB。模块集 `java.base,java.net.http,java.logging,jdk.unsupported` + `--strip-debug --no-man-pages --no-header-files --compress=2`，JDK 17.0.12。运行期由 `paths::sidecar_roots()` 优先命中随包 JRE，**用户无需安装 JDK 17**。
2. **Python embeddable 从 74.27 MB 降到 47.81 MB**：打包时排除 `Scripts/`、`__pycache__/`、`pip`、`setuptools`、`wheel` 及其 `*.dist-info`（只服务构建期）；源目录未改动。8 个运行期依赖（requests / urllib3 / lxml / pyquery / cssselect / pycryptodome / cryptography / beautifulsoup4）全部保留，`prepare_runtime.py --check` 校验通过。
3. **`qjs-runner.exe` 只随包一份**：exe 同目录是 `resolve_runner()` 的有效命中点；编译期 `source_root` 路径在分发到别的机器后天然失效，故不需要 sidecars 布局副本。
4. **mpv 不打进安装包**：单文件 116.83 MB，会把分发包推大；需要时放入安装目录的 `sidecars/mpv/`。
5. **交付形态变更**：1.0.0 起不再出便携 zip，改为官方 `tauri build` 的 NSIS 安装器（`bundle.targets: ["nsis"]`）。安装后数据默认落 `%APPDATA%\Luma`；把安装目录整体放到可写位置并建 `data/` 即切换为便携模式。
6. 未签名 exe 会触发 SmartScreen，见 `README.md`。
