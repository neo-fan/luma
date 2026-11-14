# 开发调试指南（DEVELOPMENT）

> 单入口。环境/构建/测试命令也见 `README.md`；命令全集与开发约定见 `AGENTS.md`「常用命令 / 开发约定」。本文聚焦 **如何本地把项目跑起来并定位问题**。

## 0. 一句话流程

```text
clone → 装依赖 → 准备运行时 → pnpm tauri dev → 改代码热更新
      → 调试（CDP / 日志 / 各 sidecar）→ 按需 verify → 确认后打包
```

构建与测试命令全集在 `README.md` 与 `AGENTS.md` 第 388 行，本文不再重复，只列调试必需项。

## 1. 首次环境准备

| 用途 | 要求 |
|---|---|
| 运行 | Windows 11 x64；WebView2 常青版（系统自带，不随包分发） |
| 前端 | Node 20+ / `pnpm`（由 corepack 固定版本） |
| Rust | stable ≥ 1.77.2，`x86_64-pc-windows-msvc` |
| 构建 | VS2022 Build Tools + Win11 SDK（MSVC） |
| JVM 源 | **JDK 17**（编译、运行、`jlink` 统一 17；不兼容 JDK 8） |
| 可选 | `mpv`（`sidecars/mpv/mpv.exe`）用于解码兜底 |

```powershell
corepack pnpm install                       # 前端依赖
python sidecars/java/build.py              # 桩类 + SpiderRunner + 模板 jar（需 JDK 17）
python tools/prepare_runtime.py            # jlink JRE + python-embed + externalBin（幂等；--force 强做，--check 只体检）

# 开发必须显式指定 JDK 17，否则会落到系统默认版本：
$env:LUMA_JAVA = "D:\software\java\oracle-jdk-17\bin\java.exe"

# 可选：把 mpv.exe 放进 sidecars/mpv/ 即启用解码兜底
```

运行时产物（JRE / python-embed / binaries）**不入库**，统一由 `prepare_runtime.py` 重建。
dev 与便携版统一用随包 `sidecars/python-embed/python.exe`（`bridge.rs::embedded_python` 自动探测，无需设环境变量）。

## 2. 日常开发

```powershell
corepack pnpm tauri dev        # 出窗口，前端热更新 + Rust 重编译
corepack pnpm build            # 仅前端产物（验证打包无误）
corepack pnpm test             # 前端单测（src/**/*.test.ts 19 + tests/frontend 18）
cargo check  --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml --lib
```

**交付节奏**（用户约定）：改完**停在 debug 模式**确认即可，**不要每次 `cargo build --release` + `make_portable.py` 打包**；release 编译 + 打包约 3~4 分钟、反馈回路过长，只在用户明确要求或发版时打。

## 3. 四端调试

### 3.1 前端（WebView2）—— CDP

debug 构建默认开 9222（`src-tauri/src/lib.rs::enable_devtools_port`，在 WebView2 环境创建前设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）。release 构建不带调试口；想换端口/关掉就自己设该变量（`=0` 即关闭）。

```powershell
# 浏览器/探针访问调试口：
curl --noproxy '*' http://127.0.0.1:9222/json/list     # 列出所有 target

# 本地访问 localhost 需绕过 http_proxy：
$env:NO_PROXY = 'localhost,127.0.0.1'
```

- **target 选择**：Vite 调试页是 `webSocketDebuggerUrl` 对应 `port=1420` 且 `path` 为空的那个；播放页只按 `location.hash` 判断是否"在播放页"（常驻 `player-host` 层隐藏但仍留 DOM，取 video 用 `checkVisibility`）。
- **9222 被残留进程占用** → WebView2 起不来，先确认 `(Get-Process luma).Count -eq 0`。
- 常用 CDP 工具（需 dev 窗口 + Vite 在跑）：
  - `node tools/audit_ui.mjs` / `node tools/audit_player_layout.mjs`：DOM/布局取证；
  - `node tools/probe_*.mjs`：各功能窗口探针。

### 3.2 Rust 后端

```powershell
$env:CARGO_INCREMENTAL = "0"                # Windows 上 incremental 目录会 os error 5 挂起
cargo check --manifest-path src-tauri/Cargo.toml
```

- **编译前先停 `tauri dev`**（cargo 会等 `target` 目录锁）。
- **沙箱 / Agent 环境**里 `vcvarsall.bat` 依赖的 `reg.exe` 可能被拦 → `INCLUDE`/`LIB` 为空、Git 自带 GNU `link` 遮蔽 MSVC `link.exe` 误报"缺 SDK"。工具链其实齐全，手工加载即可（版本号按本机实际目录替换）：

```powershell
$vc  = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207'
$sdk = 'C:\Program Files (x86)\Windows Kits\10'
$env:INCLUDE = "$vc\include;$sdk\Include\10.0.26100.0\ucrt;$sdk\Include\10.0.26100.0\um;$sdk\Include\10.0.26100.0\shared;$sdk\Include\10.0.26100.0\winrt"
$env:LIB     = "$vc\lib\x64;$sdk\Lib\10.0.26100.0\ucrt\x64;$sdk\Lib\10.0.26100.0\um\x64"
$env:PATH    = "$vc\bin\Hostx64\x64;$sdk\bin\10.0.26100.0\x64;$env:PATH"   # 必须压过 GNU link
```

### 3.3 Python 采集适配层

- 诊断日志写 `logs/spider.log`（每行一条 JSON，含站点 `api`、脚本指纹、方法与完整 traceback）；`LUMA_ADAPTER_LOG` 可改路径，默认 `%APPDATA%\Luma\logs\spider.log`。日志模块对 spider 协议尽力而为——缺失也不让 py 源整体失效。
- 临时切解释器：`$env:LUMA_PYTHON = <path>`。

### 3.4 JVM spider 桥

- 必须 JDK 17：`$env:LUMA_JAVA` 指向 17；`$env:LUMA_JVM_RUNNER` 覆盖 `runner.jar`。
- 注意：dev 启动若未显式设 `LUMA_JAVA`，可能落到系统默认 JDK 23，导致 jar 桥行为不一致。

### 3.5 QuickJS 侧载进程（JS 源）

- 改 `rquickjs` 后需重编：`cargo build --release --manifest-path sidecars/qjs-runner/Cargo.toml`，产物在 `sidecars/qjs-runner/target/release`。
- 直驱 JS 源前先确认 sidecar 已重编（mtime 晚于源码），否则跑的是旧副本。

## 4. 日志与诊断

```powershell
$env:LUMA_LOG = "debug"     # 重启后生效；排查 sidecar / 聚合细节用
$env:LUMA_SELFCHECK = "1"   # 启动自检并写 data/selfcheck.log（便携版实测 ping ok）
```

- 位置：便携版 `data/logs/luma-YYYY-MM-DD.log`；dev/安装模式 `%APPDATA%\Luma\logs\`，每天一个文件保留 7 天。
- 内容：启动摘要、前端关键操作、IPC 错误、未捕获异常；URL 只记 `scheme+host+path`，查询参数与播放直链不落盘。
- 反馈：设置页「复制诊断信息」（含版本/平台/目录/配置规模/日志列表 JSON）+「打开日志目录」。

## 5. 验证与回归

### 5.1 离线（无需窗口）

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib
corepack pnpm test
python tests/e2e/parse_check.py            # 解析池与配置字段
python tests/e2e/py_compat_check.py        # TVBox py 脚本通用兼容 / 错误日志
python tests/e2e/py_base_spider_check.py   # py 框架与原生对齐
python tools/prepare_runtime.py --check    # 随包 JRE/Python 依赖齐全度
python tests/e2e/contract_check.py         # 校验 contracts/tvbox.schema.json 与 TS 侧字段
```

### 5.2 需窗口（CDP 驱动真实窗口）

```powershell
python tests/e2e/p0.py     # P0 基线（需 stub + 运行中的应用，可用 --offline）
python tests/e2e/p1.py     # P1 子进程运行时
python tests/e2e/p2.py     # P2 jar / JVM 运行时
python tests/e2e/p3.py     # P3 嗅探 / mpv / 打包
node tools/run_probes.mjs                 # 一条命令跑全部窗口探针
node tools/run_probes.mjs --with-ui       # 连 UI 冒烟（会切桩配置，放最后）
node tools/run_probes.mjs --only=flv,history
node tools/run_probes.mjs --list          # 列出全部探针及其标签
```

探针脚本分类（tools/ 下）：`probe_*` 约 50 个、`verify_*` 8 个、`diag_*` 7 个、`scan_*` 2 个、`audit_*` 若干；多数依赖 `run_probes.mjs` 拉起的应用 + Vite，仅 `run_probes.mjs` 及各 `verify_*` 有 usage 头注释，其余看脚本顶部 docstring。

> 探针依赖桩服务 fixture（`strict_home` / `header_probe` 等）与临时内联配置，会自清理、不污染真实配置；`probe_ui` 会切到桩配置，默认不跑。

## 6. 环境变量速查（`LUMA_*` 为文档拼写，`TVBOX_*` 仍被读取，仅供旧脚本沿用）

| 变量 | 用途 | 调试常用值 |
|---|---|---|
| `LUMA_PYTHON` | 覆盖 Python 解释器 | 临时切测试解释器 |
| `LUMA_JAVA` | 覆盖 java 可执行文件 | JDK 17 路径（**必设**） |
| `LUMA_JVM_RUNNER` | 覆盖 `runner.jar` | 自测用 |
| `LUMA_MPV` | 覆盖 `mpv.exe` | — |
| `LUMA_PROXY_PORT` | 本地反代端口 | 默认 9978 |
| `LUMA_DATA_DIR` | 覆盖数据目录 | — |
| `LUMA_PROXY_ALLOW_LOCAL` | 允许反代访问 `127.0.0.1` | `1`（仅本地联调） |
| `LUMA_SELFCHECK` | 启动自检写日志 | `1` |
| `LUMA_LOG` | 日志级别 | `debug` |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | WebView2 调试口 | `--remote-debugging-port=9222`（debug 默认已设；`=0` 关闭） |
| `NO_PROXY` | 本地访问绕过代理 | `localhost,127.0.0.1` |

## 7. 常见坑（踩过的，按出现频率）

1. **dev 加载旧 sidecar 副本** → `/proxy` 首次报 `unsupported method: proxy`。`paths::sidecar_roots()` 在 debug 构建优先源码根，避免静默加载 `target/debug/sidecars` 旧副本。
2. **Vite dev `styles.css` 返回空串** → 整站退化成无样式堆叠。解决：重启 `tauri dev`。
3. **Vite 转换缓存让探针连跑旧代码** → 误判"修复无效"。探针开头已加 `Network.setCacheDisabled` + reload `ignoreCache:true` + 拉 `PlayerPage.tsx` 自检特征，确保不把 stale 模块当产品 bug。
4. **CDP 9222 被残留 luma 占用** → WebView2 起不来；先清残留进程。
5. **嗅探窗口冲突**：dev 的 `--remote-debugging-port=9222` 会让第二个 WebView2 返 `0x8007139F`；嗅探窗口必须给独立 `data_directory` 且覆盖 `--remote-debugging-port=0`。
6. **F 盘回收站占满** → cargo 链接 `os error 112`；已把 `src-tauri/target` 与 `release` 做成指向 `E:\luma-build\{target,release}` 的 junction，路径不变、输出不占 F 盘（彻底解决需清空 F 盘回收站）。

## 8. 相关文档

- `README.md` —— 构建 / 测试 / 环境变量 / 日志与诊断 / 运行（便携版）
- `AGENTS.md` —— 常用命令（388 行）、开发约定（432 行）、逐轮开发记录
- `docs/project-layout.md` —— 目录 / 产物 / 编码权威
- `docs/js-support.md` —— JS 源支持现状与限制
- `docs/site-compat-report.md` —— 站点兼容性实测（含时效说明）
