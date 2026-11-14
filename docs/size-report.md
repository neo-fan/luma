# 体积报告（NSIS 安装版 · 实测）

> 口径：字节数取本机实测，1 MiB = 1024×1024 字节，保留两位小数。
> **当前版本：1.0.2**（2026-11-14，由官方 `corepack pnpm tauri build` 产出 `src-tauri/target/release/bundle/nsis/Luma_1.0.2_x64-setup.exe`，构建日志显示 **38.75 MiB**，实测 40,629,359 字节）。
> 历史：2026-11-14 的 `1.0.1` 为 40.48 MiB、`1.0.0` 为 40.43 MiB；2026-11-13 的 `1.0.0-alpha` 便携包为 45.80 MB（未达标）；2026-11-10 首次 T-32 实测便携包 41.36 MB（当时命名 TVBox Desktop、exe 未静态链接 SQLite）。自 `1.0.0` 起**不再产出便携 zip**，交付物统一为 NSIS 安装器。

## 安装后目录（解包，相对安装根）

| 项 | 路径（相对安装根） | 体积 |
|---|---|---:|
| 主程序 | `Luma.exe` | 7.83 MB（8,214,528 字节） |
| QuickJS 侧载 | `qjs-runner.exe` | 3.14 MB |
| Python 适配层源码 | `sidecars/py/` | 0.09 MB |
| Python embeddable（含 8 个第三方包） | `sidecars/python-embed/` | 47.81 MB |
| jlink 裁剪 JRE（JDK 17，1.0.3 已移除） | `sidecars/jre/` | 26.24 MB |
| SpiderRunner（1.0.3 已移除） | `sidecars/java/runner.jar` | 0.03 MB |
| JS 随包依赖（8 个模块 + manifest） | `sidecars/qjs-assets/` | 0.95 MB |
| 数据目录 | `data/`（仅 `.keep`） | 0.00 MB |
| **合计** | | **86.10 MB** |

> 1.0.2 只改了 Rust 源码（导入超时修复）与版本号，运行时产物与 1.0.1 完全一致；唯一变化的行是 `Luma.exe` 18.10 → 7.83 MB（−10.27 MB）。原因是 `d9a4994` 把 Cargo release profile 对齐 Tauri 官方 [App Size](https://v2.tauri.app/concept/size/) 建议（`lto = true` + `codegen-units = 1` + `opt-level = "s"` + `panic = "abort"` + `strip = true`）：1.0.1 的安装器是在该提交（22:12）之前（21:52）构建的，因此还带着旧 profile 的体积；1.0.2 是第一个真正吃到这套 profile 的发行包。

外部播放 / 随包 mpv 已在 1.0.3 移除，安装包不再包含 `sidecars/mpv/`。JVM 运行时（`sidecars/jre` 26.24 MB + `sidecars/java/runner.jar` 0.03 MB）也已在 1.0.3 移除；上表合计仍按 1.0.2 基线统计，下一次打包后会自然减少约 26 MB。jar 站点仍会被识别为 `jvm` 并在导入时屏蔽。

## 分发包（压缩后）

| 产物 | 路径 | 体积 |
|---|---|---:|
| NSIS 安装器 | `src-tauri/target/release/bundle/nsis/Luma_1.0.2_x64-setup.exe` | **38.75 MiB**（40,629,359 字节，磁盘约 40.63 MB） |

- NSIS 用 LZMA 把解包后约 86.10 MB 的运行时压缩进单一安装器；安装器内还含 `luma.exe`（前端已嵌入）。
- 随包运行时（Python/binaries）**不入库**，由 `tools/prepare_runtime.py` 重建；安装器只负责把它们落到安装目录。
- 构建即验收：`tauri build` 退出码 0、产物存在、`luma.exe` 内含 `1.0.2` 与 `dev.luma.desktop`、且能命中应用专属 JS chunk（`usePlayerEngine`）；GUI 启动冒烟与 `LUMA_SELFCHECK` 按计划本地确认。

## 判定

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| NSIS 安装器 | ≤ 130 MB | **38.75 MiB** | ✅ **达标** |
| 通用上限 | ≤ 130 MB | 38.75 MiB | 通过 |

### 体积是怎么压下来的

1. **Release profile 对齐官方建议（本轮主因，省 10.27 MB）**：`d9a4994` 起 `[profile.release]` = `lto = true` / `codegen-units = 1` / `opt-level = "s"` / `panic = "abort"` / `strip = true`。fat LTO 去掉跨 crate 的重复泛型，`panic = "abort"` 去掉整张 unwind 表（`.pdata` 698 KB → 136 KB），`opt-level = "s"` 再压一轮代码。代价是 release 构建变慢（整图 LTO 重链接，约 2.5 分钟），迭代时用 `tauri build --no-bundle`。
2. **移除 `qjs-runner.exe` 的死副本（1.0.0，省 1.50 MB）**：`quickjs.rs::resolve_runner()` 只查 `LUMA_QJS_RUNNER` → exe 同目录 → 编译期 `source_root/sidecars/qjs-runner/target/{release,debug}`，**从不查** `sidecars/qjs-runner/qjs-runner.exe`；`qjs-runner.exe` 现只经 `bundle.externalBin` 随安装器落一份到安装根。
3. 未删任何运行时产物、未降低 `python-embed` 依赖完整度、未放宽目标。

> 体积优化原则——**消除真实冗余**，而不是删功能或谈目标。若后续再涨，按收益排序的剩余手段：`lto = "thin"`（换构建时间）/ `codegen-units = 1` 已到底；`cryptography` 的 `_rust.pyd`（压缩后 3.37 MB）是最大单包，移除会降开箱可用率，不推荐。

## 说明与偏差

1. **jlink JRE 26.24 MB（1.0.3 已移除）**：1.0.2 及以前用模块集 `java.base,java.net.http,java.logging,jdk.unsupported` + `--strip-debug --no-man-pages --no-header-files --compress=2`（JDK 17.0.12）。1.0.3 已整体移除 JVM 运行时（`sidecars/jre` + `runner.jar` + `spider/jvm.rs`），不再需要 JDK；jar 站点仅保留分类与导入屏蔽。
2. **Python embeddable 从 74.27 MB 降到 47.81 MB**：打包时排除 `Scripts/`、`__pycache__/`、`pip`、`setuptools`、`wheel` 及其 `*.dist-info`（只服务构建期）；源目录未改动。8 个运行期依赖（requests / urllib3 / lxml / pyquery / cssselect / pycryptodome / cryptography / beautifulsoup4）全部保留，`prepare_runtime.py --check` 校验通过。
3. **`qjs-runner.exe` 只随包一份**：exe 同目录是 `resolve_runner()` 的有效命中点；编译期 `source_root` 路径在分发到别的机器后天然失效，故不需要 sidecars 布局副本。
4. **不再有 mpv 兜底**：外部播放整体关闭、随包 mpv 已移除，解码失败只走换线路 / 换源。
5. **交付形态变更**：1.0.0 起不再出便携 zip，改为官方 `tauri build` 的 NSIS 安装器（`bundle.targets: ["nsis"]`）。安装后数据默认落 `%APPDATA%\Luma`；把安装目录整体放到可写位置并建 `data/` 即切换为便携模式。
6. 未签名 exe 会触发 SmartScreen，见 `README.md`。
