# 体积报告（NSIS 安装版 · 实测）

> 口径：字节数取本机实测，1 MiB = 1024×1024 字节，1 MB = 1000×1000 字节（表内「MB」列按 1024×1024 折算，保留两位小数）。
> **当前版本：1.0.3**（2026-11-15，由官方 `corepack pnpm tauri build` 产出 `src-tauri/target/release/bundle/nsis/Luma_1.0.3_x64-setup.exe`，构建日志显示 **25.44 MiB**，实测 **26,670,865 字节**）。
> 历史：`1.0.2` 38.75 MiB（40,629,359 字节）、`1.0.1` 40.48 MiB、`1.0.0` 40.43 MiB；2026-11-13 的 `1.0.0-alpha` 便携包为 45.80 MB（未达标）；2026-11-10 首次 T-32 实测便携包 41.36 MB（当时命名 TVBox Desktop、exe 未静态链接 SQLite）。自 `1.0.0` 起**不再产出便携 zip**，交付物统一为 NSIS 安装器。

## 安装后目录（解包，相对安装根，1.0.3 实测）

用 `Luma_1.0.3_x64-setup.exe /S /D=<临时目录>` 静默安装后，对安装根逐项统计：

| 项 | 路径（相对安装根） | 体积 |
|---|---|---:|
| 主程序 | `Luma.exe` | 8.44 MB（8,853,504 字节） |
| QuickJS 侧载 | `qjs-runner.exe` | 3.59 MB（3,766,784 字节） |
| 卸载程序 | `uninstall.exe` | 0.12 MB（126,487 字节） |
| Python 适配层源码 | `sidecars/py/`（24 个文件） | 0.27 MB（280,250 字节） |
| Python embeddable（含 8 个第三方包） | `sidecars/python-embed/`（2968 个文件） | 74.27 MB（77,874,582 字节） |
| JS 随包依赖（8 个模块 + manifest） | `sidecars/qjs-assets/`（10 个文件） | 0.95 MB（999,546 字节） |
| **合计** | | **87.64 MB（91,901,153 字节）** |

> **1.0.3 相对 1.0.2 的变化**：删掉 JVM 运行时（`sidecars/jre` 26.24 MB + `sidecars/java/runner.jar` 0.03 MB ≈ 26.3 MB 解包体积）和随包 mpv 链路（mpv 本来就没有随包，`sidecars/mpv` 只在开发机存在，不影响安装包）；`Luma.exe` 7.83 → 8.44 MB（直播页常驻层、错误边界、封面嗅探等新增代码）。按同口径推算 1.0.2 应为 ≈ 113.3 MB，1.0.3 为 **87.64 MB**，解包体积净减 **约 25.7 MB**；安装器 38.75 → **25.44 MiB**（净减 13.31 MiB）。
>
> 历史报告里 1.0.2 的「安装后合计 86.10 MB」是按 `python-embed 47.81 MB` 记的；本轮用同一台机器的静默安装重测为 74.27 MB，旧口径偏低，故 1.0.3 的数字不能与旧合计直接相减，只能与「旧合计 + 26.3 MB」比较。

## 分发包（压缩后）

| 产物 | 路径 | 体积 |
|---|---|---:|
| NSIS 安装器 | `src-tauri/target/release/bundle/nsis/Luma_1.0.3_x64-setup.exe` | **25.44 MiB**（26,670,865 字节） |

- SHA256：`73201B96CCE7CCBF07167CA18715924EAC47A1CEEB6FA80607CDCB6333824954`
- NSIS 用 LZMA 把解包后约 87.64 MB 的运行时压进单一安装器；安装器内还含 `luma.exe`（前端已嵌入）。
- 随包运行时（Python/binaries）**不入库**，由 `tools/prepare_runtime.py` 重建；安装器只负责把它们落到安装目录。
- 构建即验收：`tauri build` 退出码 0、产物存在、静默安装退出码 0、`Luma.exe` 版本串为 `1.0.3`；GUI 启动冒烟与 `LUMA_SELFCHECK` 按计划本地确认。

## 判定

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| NSIS 安装器 | ≤ 130 MB | **25.44 MiB** | ✅ **达标** |
| 安装后解包体积 | —（仅记录） | 87.64 MB | 记录项 |

### 体积是怎么压下来的

1. **移除 JVM 运行时（1.0.3 主因，解包省约 26.3 MB）**：jar 是 Android dex，Win x64 无解（父类不在 jar 内 + 缺 Android 运行时），`sidecars/java` + `sidecars/jre` 只服务维护态回归。1.0.3 删掉 `spider/jvm.rs`、`sidecars/{java,jre}`、打包 resources 与 `prepare_runtime.py` 的 jlink 步骤；契约里的 `"jvm"` 分类保留（jar 站点仍被识别并在导入时屏蔽）。
2. **Release profile 对齐官方建议（1.0.2 主因，省 10.27 MB）**：`d9a4994` 起 `[profile.release]` = `lto = true` / `codegen-units = 1` / `opt-level = "s"` / `panic = "abort"` / `strip = true`。fat LTO 去掉跨 crate 的重复泛型，`panic = "abort"` 去掉整张 unwind 表（`.pdata` 698 KB → 136 KB）。代价是 release 构建变慢（整图 LTO 重链接，约 3 分钟），迭代时用 `tauri build --no-bundle`。
3. **移除 `qjs-runner.exe` 的死副本（1.0.0，省 1.50 MB）**：`quickjs.rs::resolve_runner()` 只查 `LUMA_QJS_RUNNER` → exe 同目录 → 编译期 `source_root/sidecars/qjs-runner/target/{release,debug}`，**从不查** `sidecars/qjs-runner/qjs-runner.exe`；`qjs-runner.exe` 现只经 `bundle.externalBin` 随安装器落一份到安装根。

> 体积优化原则——**消除真实冗余**，而不是删功能或谈目标。若后续再涨，按收益排序的剩余手段：`lto = "thin"`（换构建时间）/ `codegen-units = 1` 已到底；`cryptography` 的 `_rust.pyd`（压缩后 3.37 MB）是最大单包，移除会降开箱可用率，不推荐。

## 说明与偏差

1. **Python embeddable 是最大单包（74.27 MB / 2968 个文件）**：8 个运行期依赖（requests / urllib3 / lxml / pyquery / cssselect / pycryptodome / cryptography / beautifulsoup4）全部保留，`prepare_runtime.py --check` 校验通过。只排除构建期才用的 `Scripts/`、`__pycache__/`、`pip`/`setuptools`/`wheel` 及其 `*.dist-info`，随包源目录本身未改。
2. **`qjs-runner.exe` 只随包一份**：exe 同目录是 `resolve_runner()` 的有效命中点；编译期 `source_root` 路径在分发到别的机器后天然失效，故不需要 sidecars 布局副本。
3. **不再有 mpv 兜底**：外部播放整体关闭、随包 mpv 已移除（本来也没打进过安装包），解码失败只走换线路 / 换源。
4. **jar 站点仍被识别为 `jvm`**：契约与归一化分类不动，只删运行时；用户导入含 jar 的配置时这些站点显示 `enabled=false` + 「jar 源为 Android dex，Windows 端暂不支持」。
5. **交付形态变更**：1.0.0 起不再出便携 zip，改为官方 `tauri build` 的 NSIS 安装器（`bundle.targets: ["nsis"]`）。安装后数据默认落 `%APPDATA%\Luma`；把安装目录整体放到可写位置并建 `data/` 即切换为便携模式。
6. 未签名 exe 会触发 SmartScreen，见 `README.md`。
