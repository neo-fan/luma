# 体积报告（T-32 实测）

> 口径：字节数取自本机实测（`PYTHONPATH` 无关，纯 `Path.stat()` / `rglob`），
> 1 MB = 1024×1024 字节，1 MiB 与 MB 在本表按同一换算展示，四舍五入两位小数。
> 构建时间：2026-11-10；`corepack pnpm tauri build --bundles nsis`。

## 逐项体积（压缩前）

| 项 | 路径 | 字节 | 体积 |
|---|---|---:|---:|
| 主程序 | `src-tauri/target/release/tvbox-desktop.exe` | 15,872,512 | 15.14 MB |
| 前端产物 | `dist/` | 783,849 | 0.75 MB |
| Python embeddable（含 8 个第三方包） | `sidecars/python-embed/` | 77,874,582 | 74.27 MB |
| jlink 裁剪 JRE（JDK 17） | `sidecars/jre/` | 27,513,244 | 26.24 MB |
| SpiderRunner | `sidecars/java/runner.jar` | 31,238 | 0.03 MB |
| qjs-runner | `src-tauri/binaries/qjs-runner-x86_64-pc-windows-msvc.exe` | 3,292,672 | 3.14 MB |
| mpv（**不随包**，按需放入） | `sidecars/mpv/mpv.exe` | 122,509,312 | 116.83 MB |

## 安装包（压缩后）

| 产物 | 路径 | 字节 | 体积 |
|---|---|---:|---:|
| NSIS 安装包（含 JRE + Python + qjs-runner + runner.jar，不含 mpv） | `src-tauri/target/release/bundle/nsis/TVBox Desktop_0.1.0_x64-setup.exe` | 40,644,894 | 38.76 MiB |

## 判定

| 规格指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 安装版 | ≤ 130 MB | 38.76 MiB | 通过 |
| 按需版（不含 JRE / mpv） | ≤ 45 MB | 未单独构建；按 JRE 在 NSIS 中的压缩贡献估算约 28–32 MB | 待实测（见下） |

## 说明与偏差

1. **jlink JRE 实测 26.24 MB**，低于规格预计的 40~60 MB。命令与模块集完全按 13 节执行
   （`java.base,java.net.http,java.logging,jdk.unsupported` + `--strip-debug --no-man-pages
   --no-header-files --compress=2`），JDK 17.0.12。
2. **Python embeddable 74.27 MB**：官方 3.11.9 本体约 20.7 MB，装齐适配层依赖
   （requests / urllib3 / lxml / pyquery / cssselect / pycryptodome / cryptography /
   beautifulsoup4 及传递依赖）后增至 74.27 MB。构建期工具 pip / setuptools / wheel 仍保留
   （安全删除策略拒绝清理）；若后续在打包脚本里剔除，可再降约 18 MB。
3. **mpv 不随安装包分发**：单文件静态构建 116.83 MB，随包会挤压安装版体积；按规格
   「JRE/mpv 可按需下载」处理，用户放入 `sidecars/mpv/mpv.exe` 或设 `TVBOX_MPV` 即可启用。
4. **按需版未单独出包**：`tauri build` 目前只产出含 JRE 的 NSIS。若需按需版，建议在
   打包脚本里用资源映射排除 `sidecars/jre`，再单独构建一次并回填本表实测值。
5. 未签名 exe 会触发 SmartScreen，见 `README.md`。
