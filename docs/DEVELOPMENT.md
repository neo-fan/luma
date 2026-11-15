# 开发调试指南（DEVELOPMENT）

> 单入口。环境/构建/测试命令也见 `README.md`；命令全集与开发约定见 `AGENTS.md`「常用命令 / 开发约定」。本文聚焦 **如何本地把项目跑起来并定位问题**。

## 0. 一句话流程

```text
clone → 装依赖 → 准备运行时 → pnpm tauri dev → 改代码热更新
      → 调试（CDP / 日志 / 各 sidecar）→ 按需 verify → 确认后打包
```

构建与测试命令全集在 `README.md`「构建」与 `AGENTS.md`「常用命令」，本文不再重复，只列调试必需项。

## 1. 首次环境准备

| 用途 | 要求 |
|---|---|
| 运行 | Windows 11 x64；WebView2 常青版（系统自带，不随包分发） |
| 前端 | Node 20+ / `pnpm`（由 corepack 固定版本） |
| Rust | stable ≥ 1.77.2，`x86_64-pc-windows-msvc` |
| 构建 | VS2022 Build Tools + Win11 SDK（MSVC） |
| 可选 | 无（外部播放整体关闭，随包 mpv 已移除；jar/JVM 运行时已移除，不需要 JDK） |

```powershell
corepack pnpm install                       # 前端依赖
python tools/prepare_runtime.py            # python-embed + externalBin staging（幂等；--force 强做，--check 只体检）

# 不需要设 LUMA_JAVA / LUMA_JDK17_HOME：JVM 运行时（sidecars/jre + runner.jar）已在 1.0.3 移除。
# jar 站点仍在导入时被识别为 runtime=jvm 并屏蔽，但不会启动任何 JVM。

# 外部播放 / mpv 兜底已移除；解码失败走换线路 → 换源。
```

运行时产物（python-embed / binaries）**不入库**，统一由 `prepare_runtime.py` 重建。
dev 与安装交付版统一用随包 `sidecars/python-embed/python.exe`（`bridge.rs::embedded_python` 自动探测，无需设环境变量）。

## 2. 日常开发

```powershell
corepack pnpm tauri dev        # 出窗口，前端热更新 + Rust 重编译
corepack pnpm build            # 仅前端产物（验证打包无误）
corepack pnpm test             # 前端单测：src 下与被测模块同目录 33 个 + tests/frontend 6 个跨文件约定
cargo check  --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml --lib
```

> 测试放哪、四层各自跑到什么程度，见 `docs/TESTING.md`。日常最低门槛就是 `python tools/check.py`。

**交付节奏**（用户约定）：改完**停在 debug 模式**（`pnpm dev:app`）确认即可，**不要每次都 `tauri build` 打包**；`tauri build` 编译 + 打包约 3~4 分钟、反馈回路过长，只在用户明确要求或发版时打。发版统一用官方 `tauri build`，不手搓打包脚本。

### 2.1 debug 与正式版必须能同时跑

开发时**已安装的正式版常常还开着**（用户在用它看片）。两者不隔离会互相打死，而且报错很难懂：

| 资源 | release | debug | 冲突后果 |
|---|---|---|---|
| 数据目录（库/日志/收藏） | `%APPDATA%\Luma` | `%APPDATA%\Luma-debug`（`store::data_dir` 按 `cfg!(debug_assertions)` 分叉） | 已隔离，dev 折腾不影响真实数据 |
| WebView2 用户数据目录 | `%LOCALAPPDATA%\dev.luma.desktop` | `%LOCALAPPDATA%\dev.luma.desktop.debug` | **必须隔离**，见下 |
| 本地反代 | `127.0.0.1:9978` | 同左，后启动的自动退到临时端口（`proxy::bind_listener`） | 各自可用，只是 debug 的端口不固定 |
| CDP | 不开 | `127.0.0.1:9222` | release 不占，无冲突 |

**WebView2 那条是硬约束**：Tauri 在 Windows 上把 webview 的 data dir 钉成 `app_local_data_dir()`（= `%LOCALAPPDATA%\<identifier>`），而 wry 明确要求「**browser args 不同的 webview 必须用不同的 data dir**」。debug 构建会额外注入 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，于是：

- 先开 release、再 `tauri dev` → debug 侧 `Failed to setup app: … WebView2 error: HRESULT(0x8007139F) "组或资源的状态不是执行请求操作的正确状态"`，窗口起不来；
- 反过来先 dev 再开安装版，**用户的安装版起不来**——这就是「开发影响本地使用」的真实机制。

隔离办法（纯配置 + 脚本，不改 Rust）：

- `src-tauri/tauri.dev.conf.json` 只覆盖一个键：`identifier` → `dev.luma.desktop.debug`。Tauri CLI 的 `--config` 会把它合并到 `tauri.conf.json` 之上，identifier 变了，`app_local_data_dir()` 跟着变，WebView2 用户数据目录自然分开。
- `package.json` 里 `dev:app = tauri dev --config src-tauri/tauri.dev.conf.json`。**debug 一律用 `corepack pnpm dev:app`**；`tauri build` 不读这个文件，安装包的 identifier 仍是 `dev.luma.desktop`。
- 验收：两个窗口同时开着不打架，且 `%LOCALAPPDATA%` 下同时存在 `dev.luma.desktop\EBWebView`（安装版）与 `dev.luma.desktop.debug\EBWebView`（dev）。

> 顺带：`vite.config.ts` 的 `server.watch.ignored` 排除了 `src-tauri/`、`.agents/`、`.*.tmpdir/`、`.git/`。Node 24 把 `fs.watch` 的 EBUSY 当致命错误，而 `tauri dev` 正在写 `target\debug\luma.exe`、并行会话又在原子写源码，命中任一个都会让 vite 退出、连带 `beforeDevCommand` 失败把整个 dev 拖死。


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
  - `node tools/audit/audit_ui.mjs` / `node tools/audit/audit_player_layout.mjs`：DOM/布局取证；
  - `node tools/probes/probe_*.mjs`：各功能窗口探针。

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

- 适配层只做协议与子进程执行：`spider.py` 交给 `pyspider.py` → `pyrun.py` 跑第三方脚本，脚本返回值**原样交回**，归一化在宿主 `src-tauri/src/domain/spider/cms_parse.rs::normalize_spider_result`。`sidecars/py/` 不再有 CMS 字段映射；离线审计脚本的副本在 `tools/audit/cms.py`（别从适配层 import）。
- 空详情（脚本返回 `{"list": []}`）由宿主记 `spider detailContent returned no video`（app 通道，带 `source_api` / `vod_id`），spider 通道只留脚本内的异常与 traceback。
- 诊断日志写 `logs/spider/spider.<UTC 日期>.log`（每行一条 JSON，含站点 `api`、脚本指纹、方法与完整 traceback）。宿主 spawn 时通过 `LUMA_ADAPTER_LOG` 注入这个路径，`LUMA_ADAPTER_LOG` 也可手动改；单个文件上限 10 MiB，超出滚成 `.1`。日志模块对 spider 协议尽力而为——缺失也不让 py 源整体失效。
- 临时切解释器：`$env:LUMA_PYTHON = <path>`。

### 3.4 QuickJS 侧载进程（JS 源）

- 改 `rquickjs` 后需重编：`cargo build --release --manifest-path sidecars/qjs-runner/Cargo.toml`，产物在 `sidecars/qjs-runner/target/release`。
- 直驱 JS 源前先确认 sidecar 已重编（mtime 晚于源码），否则跑的是旧副本。

## 4. 日志与诊断

```powershell
$env:LUMA_LOG = "debug"     # 重启后生效；排查 sidecar / 聚合细节用
$env:LUMA_SELFCHECK = "1"   # 启动自检并写 data/selfcheck.log（安装版实测 ping ok）
```

- 位置（三个通道，各自独立滚动、各自保留最近 7 天）：
  - `logs/app/luma.<UTC 日期>.log` —— 宿主（Rust）：网络、数据库、播放、配置导入；
  - `logs/ui/ui.<UTC 日期>.log` —— 前端（React，`tracing` target 固定 `ui`）；
  - `logs/spider/spider.<UTC 日期>.log` —— Python 适配层（第三方源脚本的异常与 traceback）。

  dev/安装模式在 `%APPDATA%\Luma\logs\`；便携模式（exe 同级 `data/`）为 `data/logs\`。每个通道上限 10 MiB，超出先删最旧的一整天，不切正在写的文件。
- 内容：启动摘要、前端关键操作、IPC 错误、未捕获异常；URL 只记 `scheme+host+path`，查询参数与播放直链不落盘。
- 反馈：设置页「复制诊断信息」（含版本/平台/目录/配置规模/日志列表 JSON，日志项带 `channel`）+「打开日志目录」+「导出反馈文件」（三类日志各取末尾 400 行）。

## 5. 验证与回归

### 5.1 离线（无需窗口）

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib
corepack pnpm test
python tests/offline/parse_check.py            # 解析池与配置字段
python tests/offline/py_compat_check.py        # TVBox py 脚本通用兼容 / 错误日志
python tests/offline/py_base_spider_check.py   # py 框架与原生对齐
python tools/prepare_runtime.py --check    # 随包 Python 依赖齐全度（JVM 运行时已移除，不再检查 JRE）
python tests/offline/contract_check.py         # 校验 contracts/tvbox.schema.json 与 TS 侧字段
```

### 5.2 需窗口（CDP 驱动真实窗口）

```powershell
python tests/acceptance/p0.py     # P0 基线（需 stub + 运行中的应用，可用 --offline）
python tests/acceptance/p1.py     # P1 子进程运行时
python tests/acceptance/p3.py     # P3 嗅探 / 打包
node tools/run_probes.mjs                 # 一条命令跑全部窗口探针
node tools/run_probes.mjs --with-ui       # 连 UI 冒烟（会切桩配置，放最后）
node tools/run_probes.mjs --only=flv,history
node tools/run_probes.mjs --list          # 列出全部探针及其标签
```

探针按用途分目录（都在 `tools/` 下）：`probes/` 50 个功能探针、`verify/` 8 个严格验收、`diag/` 7 个一次性排障、`audit/` 4 个（DOM/布局取证 + 全站扫描）。多数依赖 `run_probes.mjs` 拉起的应用 + Vite；`tools/run_probes.mjs` 是唯一入口，其余脚本顶部有 usage 头注释。

> 探针依赖桩服务 fixture（`strict_home` / `header_probe` 等）与临时内联配置，会自清理、不污染真实配置；`probe_ui` 会切到桩配置，默认不跑。
>
> 少数「真实源」探针（`probe_search_ui` / `probe_playability` / `probe_coverage` 等）默认指向一个**公开示例配置**；要测自己的配置，把它们顶部的 `CONFIG` 换成你的地址，或设 `LUMA_CONFIG`（支持的探针会优先读它）。仓库不内置任何配置地址。

## 6. 环境变量速查（`LUMA_*` 为文档拼写，`TVBOX_*` 仍被读取，仅供旧脚本沿用）

| 变量 | 用途 | 调试常用值 |
|---|---|---|
| `LUMA_PYTHON` | 覆盖 Python 解释器 | 临时切测试解释器 |

| `LUMA_PROXY_PORT` | 本地反代端口 | 默认 9978 |
| `LUMA_DATA_DIR` | 覆盖数据目录 | — |
| `LUMA_PROXY_ALLOW_LOCAL` | 允许反代访问 `127.0.0.1` | `1`（仅本地联调） |
| `LUMA_SELFCHECK` | 启动自检写日志 | `1` |
| `LUMA_LOG` | 日志级别 | `debug` |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` | WebView2 调试口 | `--remote-debugging-port=9222`（debug 默认已设；`=0` 关闭） |
| `NO_PROXY` | 本地访问绕过代理 | `localhost,127.0.0.1` |

## 7. 常见坑（踩过的，按出现频率）

1. **dev 加载旧 sidecar 副本** → `/proxy` 首次报 `unsupported method: proxy`。`paths::sidecar_roots()` 在 debug 构建优先源码根，避免静默加载 `target/debug/sidecars` 旧副本。
2. **Vite dev 样式入口（`src/styles/index.css`）返回空串** → 整站退化成无样式堆叠。解决：重启 `tauri dev`。
3. **Vite 转换缓存让探针连跑旧代码** → 误判"修复无效"。探针开头已加 `Network.setCacheDisabled` + reload `ignoreCache:true` + 拉 `PlayerPage.tsx` 自检特征，确保不把 stale 模块当产品 bug。
4. **CDP 9222 被残留 luma 占用** → WebView2 起不来；先清残留进程。
5. **嗅探窗口冲突**：dev 的 `--remote-debugging-port=9222` 会让第二个 WebView2 返 `0x8007139F`；嗅探窗口必须给独立 `data_directory` 且覆盖 `--remote-debugging-port=0`。
6. **F 盘空间不足** → cargo 链接报 `os error 112`。曾用 junction 把 `src-tauri/target`、`release` 指到 `E:\luma-build`，**现在已不使用**（两者都是本仓库内的普通目录，`release/` 旧便携产物也已删除）。再遇到空间问题优先清回收站，或临时 `CARGO_TARGET_DIR=<另一块盘>`，不要手搓 junction 掩盖问题。

## 8. 相关文档

- `README.md` —— 构建 / 测试 / 环境变量 / 日志与诊断 / 运行（安装版 + 便携模式）
- `AGENTS.md` —— 当前规范与决策（「工程铁律」「常用命令」「开发约定」）
- `CONTRIBUTING.md` —— 贡献流程、代码约定、PR 要求
- `docs/ARCHITECTURE.md` —— 进程模型 / 四类源 / 数据流 / 分层 / ADR
- `docs/MAINTENANCE.md` —— 契约变更、依赖升级、回归分层、工程债
- `docs/RELEASING.md` —— 版本同步清单、发版检查、打包与验收
- `docs/project-layout.md` —— 目录 / 产物 / 编码权威
- `docs/js-support.md` —— JS 源支持现状与限制
- `SECURITY.md` / `THIRD-PARTY-NOTICES.md` —— 安全模型、第三方组件与许可
- `CHANGELOG.md` —— 版本变更记录
