# 开发调试指南（DEVELOPMENT）

> 单入口。环境/构建/测试命令也见 `README.md`；命令全集与开发约定见 `AGENTS.md`「常用命令 / 开发约定」。本文聚焦 **如何本地把项目跑起来并定位问题**。

## 0. 一句话流程

```text
clone → 装依赖 → 准备运行时 → pnpm dev:app → 改代码热更新
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
corepack pnpm dev:app          # 出窗口，前端热更新 + Rust 重编译
corepack pnpm build            # 仅前端产物（验证打包无误）
corepack pnpm test             # 前端单测：src 下与被测模块同目录 68 个 + tests/frontend 31 个跨文件约定
cargo check  --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml --lib
```

> 测试放哪、四层各自跑到什么程度，见 `docs/TESTING.md`。日常只需 `python tools/affected.py --run`（按改动半径挑测试）；完整 `python tools/check.py` 留到发版前跑一次。

**交付节奏**：改完**停在 debug 模式**（`pnpm dev:app`）确认即可，**不要每次都 `tauri build` 打包**；`tauri build` 编译 + 打包约 3~4 分钟、反馈回路过长，只在发版时打。发版统一用官方 `tauri build`，不手搓打包脚本。**出包由 CI 负责**：本地不重复构建安装包，需要冒烟时才例外。

### 2.1 三通道：stable / beta / dev

`dev` 是日常调试（`tauri dev`，不出安装包）；`beta` 按需启用（预发布时才出包）；`stable` 是常驻交付通道。通道由 identifier 后缀判定（`infra/channel.rs`），三者的身份与资源互不重叠：

| 资源 | stable | beta（按需） | dev（日常调试） |
|---|---|---|---|
| identifier | `app.luma` | `app.luma.beta` | `app.luma.dev` |
| 数据目录（库/日志/收藏） | `%APPDATA%\app.luma` | `%APPDATA%\app.luma.beta` | `%APPDATA%\app.luma.dev` |
| WebView2 用户数据目录 | `%LOCALAPPDATA%\app.luma` | `%LOCALAPPDATA%\app.luma.beta` | `%LOCALAPPDATA%\app.luma.dev` |
| 本地反代 | `127.0.0.1:9978` | `127.0.0.1:9977` | `127.0.0.1:9979` |
| 单实例锁（命名互斥体） | `app.luma-sim` | `app.luma.beta-sim` | `app.luma.dev-sim` |
| CDP | 不开 | 不开 | `127.0.0.1:9222` |
| 进程名 / 描述（任务管理器） | `Luma.exe` / `Luma` | `Luma Beta.exe` / `Luma Beta` | `Luma_dev.exe` / `Luma Dev` |
| 出包命令 | `pnpm build:app` | `pnpm build:beta` | 不出包 |

开发时**已安装的正式版常常还开着**（用户在用它看片）。不隔离会互相打死，而且报错很难懂。

**同通道重复启动**由 `tauri-plugin-single-instance` 挡住：锁名是 `{identifier}-sim` 命名互斥体，按 identifier 各一把，于是重复双击只会把已有窗口叫到前台（不开第二个进程、不二次打开 `luma.db`、不抢同一个反代端口），而三通道仍可同机并存、互不踢出。反代端口是 **fail-fast** 的：固定端口被占就中止启动并写明「哪个端口、可能被谁占着」（`proxy::bind_listener`），不再退回临时端口。

**并行开发注意**：`app.luma.dev`、9979、Vite 1420、CDP 9222 都是全局单值，`Luma_dev.exe` 的互斥体也只有一把——所以**同一时刻只允许一棵源码树跑 dev**。需要同时验证两条改动时用不同通道（`build:beta`），不要复制工作树。

**WebView2 那条是硬约束**：Tauri 在 Windows 上把 webview 的 data dir 钉成 `app_local_data_dir()`（= `%LOCALAPPDATA%\<identifier>`），而 wry 明确要求「**browser args 不同的 webview 必须用不同的 data dir**」。debug 构建会额外注入 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`，于是：

- 先开 stable、再 `tauri dev` → dev 侧 `Failed to setup app: … WebView2 error: HRESULT(0x8007139F) "组或资源的状态不是执行请求操作的正确状态"`，窗口起不来；
- 反过来先 dev 再开安装版，**用户的安装版起不来**——这就是「开发影响本地使用」的真实机制。

隔离办法（overlay 配置，不改 Rust 逻辑）：

- 三份配置入库，身份由 `package.json` 的 `appId` + 通道后缀派生：`tauri.conf.json`（stable）、`tauri.beta.conf.json`、`tauri.dev.conf.json`。Tauri CLI 的 `--config` 按 JSON Merge Patch 合并，identifier 变了，`app_local_data_dir()`、数据目录与反代端口跟着变。
- `package.json`：`dev:app` 用 `tauri dev --config src-tauri/tauri.dev.conf.json`，`build:beta` 用 `tauri build --config src-tauri/tauri.beta.conf.json`。**日常调试一律 `corepack pnpm dev:app`**；裸 `tauri dev` 用的是 stable 身份，与安装版共用 profile。
- 三份 overlay 的 identifier 必须等于 `appId + 后缀`，由 `tools/version_check.py` 校验；不许只改一处。
- 验收：dev 窗口与安装版同时开着不打架，且 `%LOCALAPPDATA%` 下同时存在 `app.luma\EBWebView` 与 `app.luma.dev\EBWebView`。

> 顺带：`vite.config.ts` 的 `server.watch.ignored` 排除了 `src-tauri/`、`.agents/`、`.*.tmpdir/`、`.git/`。Node 24 把 `fs.watch` 的 EBUSY 当致命错误，而 `tauri dev` 正在写 `target\debug\Luma_dev.exe`、并行会话又在原子写源码，命中任一个都会让 vite 退出、连带 `beforeDevCommand` 失败把整个 dev 拖死。

### 2.2 窗口与安全配置（`tauri.conf.json`）

- **identifier 与通道**：三份 overlay 的 identifier 都由 `package.json` 的 `appId` + 后缀派生（stable `app.luma`、beta `app.luma.beta`、dev `app.luma.dev`），`tools/version_check.py` 负责守护。identifier 决定 `%LOCALAPPDATA%\<identifier>`（WebView2 profile：localStorage、缓存）、卸载注册表项与数据目录名（`%APPDATA%\<identifier>`）。**改 identifier 等于重置前端设置**，发版后不能随便动。`debug_assertions` 优先于 identifier——`tauri build --debug` 一律算 dev，不冒充正式包。
- **CSP**：`csp`（生产）与 `devCsp`（开发）分开。`img-src` / `media-src` / `connect-src` 放通 `http(s)` 是刻意的——封面与流地址来自用户导入的任意源，域名无法枚举；`style-src 'unsafe-inline'` 是 ArtPlayer 运行时注入 `<style>` 所需；`worker-src blob:` 是 hls.js 的 blob worker。真正收窄的是 `script-src`：生产 `'self'`，开发额外给 `'unsafe-inline' 'unsafe-eval'`（Vite HMR）。改 CSP 后必须开窗口走一遍「列表 → 详情 → 播放」，控制台不能出现 `Refused to`。
- **capabilities**：显式列出 `main-access`，不依赖 `capabilities/` 目录扫描——新增权限文件不会自动生效。
- **additionalBrowserArgs**：一旦设置就覆盖 wry 的默认值，必须自己补回 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`，否则 PDF / SmartScreen 组件会在 webview 里启用。

### 2.3 启动、停止与状态判定

进程名固定：**安装版 `Luma.exe`，dev `Luma_dev.exe`**。任务管理器「名称」列即文件名，「描述」列取 exe 的 `FileDescription`（由 `productName` 生成），所以 dev 显示 `Luma Dev`。

为什么不是 `Luma Dev.exe`：Cargo target 名只接受字母/数字/下划线（rustc 拒绝空格与 `.`），而 `tauri dev` 是 `cargo run` 直接跑产物、不走 `mainBinaryName` 的 build 期重命名（tauri-cli 2.12.4 源码：`rename_app` 只在 build 路径）。要文件名带空格只能绕开 `tauri dev` 自己起进程，得不偿失。dev 的 `[[bin]] name` 与 `tauri.dev.conf.json` 的 `mainBinaryName` 必须同为 `Luma_dev`，`productName` 必须区别于 stable，均由 `tools/version_check.py` 守护。

**启动**（后台常驻，日志与 PID 落 `tools/.out/`）：

```powershell
New-Item -ItemType Directory -Force tools/.out | Out-Null          # 已在 .gitignore
$p = Start-Process pwsh -WindowStyle Hidden -PassThru -ArgumentList '-NoProfile','-Command',
  'corepack pnpm dev:app *> tools/.out/dev.log'
$p.Id | Set-Content tools/.out/dev.pid
"pid=$($p.Id) log=tools/.out/dev.log"
```

**状态判定**（单次、2 秒超时、立即返回，不循环）：

```powershell
$devPid  = Get-Content tools/.out/dev.pid -ErrorAction SilentlyContinue
$session = if ($devPid) { Get-Process -Id $devPid -ErrorAction SilentlyContinue }
$app     = Get-Process Luma_dev -ErrorAction SilentlyContinue
$cdp     = try { Invoke-RestMethod 'http://127.0.0.1:9222/json/list' -NoProxy -TimeoutSec 2 } catch { @() }
if (@($cdp | Where-Object url -like 'http://localhost:1420*').Count) { 'READY' }
elseif ($app) { 'BOOTING' }
elseif ($session) { 'BUILDING' }
elseif ($cdp) { 'STALE' }
else { 'DOWN' }
```

| 状态 | 含义 | 动作 |
|---|---|---|
| `READY` | 窗口与前端已就绪，可接探针 | 继续 |
| `BOOTING` | `Luma_dev.exe` 在跑，WebView2 / 前端还没挂上 | 30s 后再探 |
| `BUILDING` | dev 会话在，二进制还没产出（首编可能十几分钟） | 30~60s 后再探，期间做别的事 |
| `STALE` | 没有 dev 进程，9222 却被占：旧 `luma.exe` / `Luma_dev.exe` 残留 | 用下方命令清 `target\debug` 下的实例 |
| `DOWN` | 会话与进程都没了 | 看 `tools/.out/dev.log` 尾部 |

```powershell
# STALE：只结束 target\debug 下的实例（含改名前遗留的 luma.exe）
Get-Process luma, Luma_dev -ErrorAction SilentlyContinue |
  Where-Object Path -like '*\src-tauri\target\debug\*' | ForEach-Object { Stop-Process -Id $_.Id }
```

**禁止死等**：不在一条命令里写循环等 `READY`、不 `Start-Sleep 600`；每次只探一次，状态自己看。Rust 首编慢属正常，别把等待当失败。

**停止**（进程名唯一，不碰安装版）：交互终端里直接 `corepack pnpm dev:app` 时用 `Ctrl+C`；后台会话按下面三步收尾。

```powershell
Stop-Process -Name Luma_dev -ErrorAction SilentlyContinue        # app 退出后 tauri dev 自行收尾
Start-Sleep -Seconds 2
Get-Process Luma_dev -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count  # 应为 0
# 2s 后会话仍在（pid 文件里的进程还活着）才结束会话
$devPid = Get-Content tools/.out/dev.pid -ErrorAction SilentlyContinue
if ($devPid) { Stop-Process -Id $devPid -ErrorAction SilentlyContinue }
# 仅当 cargo test 报 os error 5 时：清 debug 目录下的 qjs-runner 残留
Get-Process qjs-runner -ErrorAction SilentlyContinue |
  Where-Object Path -like '*\src-tauri\target\debug\*' | ForEach-Object { Stop-Process -Id $_.Id }
```

- 不要删 `target` 解锁，不要用 `CARGO_TARGET_DIR` 绕。
- `qjs-runner` 正常由 Job Object 随主进程收尸，上面的清理只在构建报 `os error 5` 时用。
- `cargo test` / `cargo check` / `tools/check.py` 要独占 `target`，运行中的 `Luma_dev.exe`、`qjs-runner.exe` 还锁同名产物，**必须先停 dev**。

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
- **9222 被残留进程占用** → WebView2 起不来。先看 `Get-Process Luma_dev`；旧产物 `luma.exe` 只会是历史残留，按 `Path` 过滤到 `target\debug` 再结束。
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

- 适配层只做协议与脚本执行：协议面就是 `ping` + `spider.py`（外加 `LUMA_ADAPTER_DEBUG=1` 时的 `debug.*`），`spider.py` 交给 `pyspider.py` 在适配层进程内跑第三方脚本（每源一个常驻实例，逐实例加锁串行），脚本返回值**原样交回**，归一化在宿主 `src-tauri/src/domain/spider/cms_parse.rs::normalize_spider_result`。`pyrun.py` 现在是共享的契约助手（`to_args` / `json_safe` / `proxy_result`）与独立自测入口，不再是每次调用的子进程。
- 配置解密 / 归一化 / CMS 解析 / M3U / XMLTV 的参考实现全在 Rust（`domain/config/{decrypt,normalize}.rs`、`domain/spider/cms_parse.rs`、`domain/live/{m3u,epg}.rs`）；`sidecars/py/` 里没有这些模块的副本。开发工具要复用旧 Python 实现时去 `tools/audit/`（`cms.py` / `decrypt.py` / `normalize.py`），不要从适配层 import。
- 调用任何已删方法（`config.decrypt`、`config.normalize`、`config.mergeRepos`、`site.route`、`live.parseM3u`、`live.parseEpg`、`parse.resolve`、`site.parse*`）会明确回 `{"code":"INTERNAL","message":"unknown method: …"}`，不会静默成功。
- 空详情（脚本返回 `{"list": []}`）由宿主记 `spider detailContent returned no video`（app 通道，带 `source_api` / `vod_id`），spider 通道只留脚本内的异常与 traceback。
- 诊断日志写 `logs/spider/spider.<本地日期>.log`（每行一条 JSON，含站点 `api`、脚本指纹、方法与完整 traceback）。宿主 spawn 时通过 `LUMA_ADAPTER_LOG` 注入这个路径，`LUMA_ADAPTER_LOG` 也可手动改；单个文件上限 10 MiB，超出滚成 `.1`。日志模块对 spider 协议尽力而为——缺失也不让 py 源整体失效。
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
  - `logs/app/luma.<本地日期>.log` —— 宿主（Rust）：网络、数据库、播放、配置导入；
  - `logs/ui/ui.<本地日期>.log` —— 前端（React，`tracing` target 固定 `ui`）；
  - `logs/spider/spider.<本地日期>.log` —— Python 适配层（第三方源脚本的异常与 traceback）。

  行首时间戳与文件名日期**都按系统时区**（`2026-11-21T01:15:52.905780+08:00`），两者同一口径：`tracing-subscriber` 默认 UTC 会让 UTC+8 凌晨的日志落进「前一天」的文件。宿主两个通道由 `infra/logging` 的 `DailyFile` 自己按本地日期跨天换句柄（`tracing-appender` 的 `Rotation::DAILY` 固定按 UTC 算日期且无可覆写钩子）。

  日志落在 `%APPDATA%\<identifier>\logs\`（dev 为 `app.luma.dev`），`LUMA_DATA_DIR` 覆盖时改写到该目录的 `logs\`。每个通道上限 10 MiB，超出先删最旧的一整天，不切正在写的文件。
- 内容：启动摘要、前端关键操作、IPC 错误、未捕获异常；URL 只记 `scheme+host+path`，查询参数与播放直链不落盘。
- 反馈：设置页「复制诊断信息」（含版本/平台/目录/配置规模/日志列表 JSON，日志项带 `channel`）+「打开日志目录」+「导出反馈文件」（三类日志各取末尾 400 行）。
- 存储：设置页「存储与清理」分项显示日志 / 反馈报告 / 封面与页面缓存的占用并可手动清理（`domain/storage.rs`）。日志的当天文件被 writer 持有，删不掉时改为清空内容；用户报「占空间」时的第一现场就是这里，不必再去数据目录手删。

## 5. 验证与回归

### 5.1 离线（无需窗口）

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib
corepack pnpm test
python tools/check.py                          # 12 项一键（契约 / 版本 / 发布收口 / 文档一致性 / py 兼容 / py 框架 / 适配层 / qjs 引擎 / 语法 / 前端类型 / 前端单测 / cargo）
python tests/offline/py_compat_check.py        # TVBox py 脚本通用兼容 / 子进程信封
python tests/offline/py_base_spider_check.py   # py 框架与原生对齐
python tools/prepare_runtime.py --check        # 随包 Python 依赖齐全度（JVM 运行时已移除，不再检查 JRE）
python tests/offline/contract_check.py         # 校验 contracts/luma.schema.json 与 TS 侧字段
```

注意：配置解密 / 归一化 / CMS 采集解析 / M3U / XMLTV 的参考实现都在 Rust
（`domain/config/`、`domain/spider/cms_parse.rs`、`domain/live/`），`sidecars/py/`
只剩「执行第三方脚本」这一条职责；`tests/offline/` 也不再保留这些解析的 Python 副本。

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

探针按用途分目录（都在 `tools/` 下）：`probes/` 31 个功能探针（注册 27 支，`ui` 为 optIn、默认跳过）、`verify/` 6 个严格验收、`diag/` 21 个排障与取样、`audit/` 3 个取证脚本（DOM/布局 + 全站扫描）+ 4 个 py 解析参考实现。多数依赖 `run_probes.mjs` 拉起的应用 + Vite；`tools/run_probes.mjs` 是唯一入口，其余脚本顶部有 usage 头注释。

> 探针依赖桩服务 fixture（`strict_home` / `header_probe` 等）与临时内联配置，会自清理、不污染真实配置；`probe_ui` 会切到桩配置，默认不跑。
>
> 少数「真实源」探针（`probe_search_ui` 等）默认指向一个**公开示例配置**；要测自己的配置，把它们顶部的 `CONFIG` 换成你的地址，或设 `LUMA_CONFIG`（支持的探针会优先读它）。仓库不内置任何配置地址。源可达性采样工具已移到 `tools/diag/diag_coverage.mjs` / `diag_playability.mjs`，不再混进默认探针。

## 6. 环境变量速查（统一 `LUMA_*` 前缀）

| 变量 | 用途 | 调试常用值 |
|---|---|---|
| `LUMA_PYTHON` | 覆盖 Python 解释器 | 临时切测试解释器 |

| `LUMA_PROXY_PORT` | 本地反代端口（宿主 `proxy::start` 绑定后**写入并注入子进程**，非手填） | stable 9978 / beta 9977 / dev 9979 |
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
4. **CDP 9222 被残留 luma 占用** → WebView2 起不来；按 §2.3 的 `STALE` 处理。
5. **嗅探窗口冲突**：dev 的 `--remote-debugging-port=9222` 会让第二个 WebView2 返 `0x8007139F`；嗅探窗口必须给独立 `data_directory` 且覆盖 `--remote-debugging-port=0`。
6. **F 盘空间不足** → cargo 链接报 `os error 112`。曾用 junction 把 `src-tauri/target`、`release` 指到 `E:\luma-build`，**现在已不使用**（两者都是本仓库内的普通目录，`release/` 旧便携产物也已删除）。再遇到空间问题优先清回收站或挪走其它大文件；**不要**用 junction、也**不要**用 `CARGO_TARGET_DIR` 指向别的盘（铁律 11 无例外条款），清理产物只用 `cargo clean`。

## 8. 相关文档

- `README.md` —— 构建 / 测试 / 环境变量 / 日志与诊断 / 运行（安装版）
- `AGENTS.md` —— 当前规范与决策（「工程铁律」「常用命令」「开发约定」）
- `CONTRIBUTING.md` —— 贡献流程、代码约定、PR 要求
- `docs/ARCHITECTURE.md` —— 进程模型 / 四类源 / 数据流 / 分层 / ADR
- `docs/MAINTENANCE.md` —— 契约变更、依赖升级、回归分层、工程债
- `docs/RELEASING.md` —— 版本同步清单、发版检查、打包与验收
- `docs/project-layout.md` —— 目录 / 产物 / 编码权威
- `docs/js-support.md` —— JS 源支持现状与限制
- `SECURITY.md` / `THIRD-PARTY-NOTICES.md` —— 安全模型、第三方组件与许可
- `CHANGELOG.md` —— 版本变更记录
