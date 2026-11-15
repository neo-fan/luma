# Luma

Windows 11 x64 桌面端的 **配置兼容播放框架**（空壳播放器，产品名 Luma；兼容 TVBox 系配置格式）。

它本身**不内置、不托管、不分发**任何配置地址、影视源、直播源或 API Key —— 所有内容来自你自己导入的配置（`api.json` / `box.json` 及常见变体）。

- 前端：React 18 + TypeScript + Vite
- 宿主：Tauri v2（Rust）+ WebView2
- 适配层：Python 3.11 / QuickJS 两个随包 sidecar（JVM 运行时已移除）
- 交付：官方 `tauri build` 产出的 NSIS 安装器（Windows）

> **免责声明（先读这一段）**
> 本项目只是播放框架，不提供、不托管、不分发任何音视频内容或源站地址。
> 你导入的配置、脚本、jar 均为第三方内容，其合法性、安全性与可用性由你自行判断并承担全部责任。
> 请遵守所在地法律法规与源站服务条款；因使用第三方源产生的任何纠纷与本项目无关。
> 项目不收集遥测、不上传配置、不内置账号体系。

---

## 特性

- **配置导入**：URL / 本地文件 / 内联文本；支持 JSONC、图片种（base64 内嵌）、gzip/base64 包装等常见方言。
- **多配置**：命名、切换、删除，各自独立的收藏 / 历史 / 页面缓存作用域；可设定时刷新间隔。
- **三类源**：CMS（`api.php/provide/vod`）、Python（`.py`，`base.spider` 框架）、JavaScript（`.js`，独立 `qjs-runner` sidecar）。
- **聚合搜索**：一次关键词覆盖当前配置全部站点，按站分组流式上屏、可中断；失败源按原因分组并支持单站重试。
- **播放**：ArtPlayer + hls.js / mpegts.js（FLV），本地反代重写 m3u8 相对分片、透传 UA/Referer/Cookie；同片换线 → 跨站换源 → 隐藏 WebView2 嗅探三级降级；12 秒卡死看门狗；播放偏好记忆与自动下一集。
- **直播**：m3u/m3u8 解析与代理重写、多线路切换、XMLTV EPG 与台标。
- **数据**：SQLite 单库（配置快照 / active / 收藏 / 历史）；便携模式数据随文件夹移动。
- **诊断**：结构化日志（7 天轮转、URL 脱敏）、设置页一键复制诊断信息 / 打开日志目录 / 导出反馈文件。

## 支持范围

| 源类型 | 状态 | 说明 |
|---|---|---|
| CMS 采集（`api.php/provide/vod`） | ✅ 支持 | 主流配置的主体，直链 m3u8 |
| Python（TVBox `base.spider` 框架） | ✅ 支持 | 含直链型与 `proxy?do=py` 型 |
| `parses[]` 通用解析池 | ✅ 支持 | type 0 嗅探 / type 1 JSON 接口 / type 4 并行竞速 |
| 配置级 `headers[]` | ✅ 支持 | 按 host 注入 UA/Referer，防盗链 CDN 必需 |
| 直播（`lives`） | ✅ 支持 | m3u8 经本地代理重写后播放 |
| JavaScript（drpy2 / `var spider`） | ✅ 支持 | 独立 `qjs-runner` sidecar，内置 ESM 加载器与 8 个随包库 |
| jar（`csp_*` / 全局 `spider` jar） | ❌ 社区配置不支持 | 导入时自动屏蔽；JVM 运行时已移除，jar 站点仍被识别并屏蔽 |

### 为什么社区 jar 源不支持

社区配置里的 jar 绝大多数是 **Android dex jar**，在 Windows x64 上走不通：

- jar 内只有 `classes.dex`，而它继承的 `com.github.catvod.crawler.Spider` **不在 jar 里**（属于 Android 客户端本体）；
- 还依赖 ART、OkHttp、gson、NanoHTTPD、QuickJS binding 与整套 `android.util.*`，桩类无法补全；
- 这些站点的差异全在 jar 内部的 XPath 规则引擎里，无法绕开。

所以**导入阶段就把这些站点屏蔽掉**（`runtime=jvm` → `enabled=false` + `disabledReason`），不参与搜索聚合、不拖慢响应。JVM 运行时（随包 JRE / `runner.jar`）已于 2026-11-15 移除：jar 站点仍会被识别为 `jvm` 并屏蔽，但不再有任何 JVM 通道，你也不需要安装 JDK。

## 系统要求

| 用途 | 要求 |
|---|---|
| 运行 | Windows 11 x64；WebView2 常青版（系统自带，不随包分发） |
| 开发 | Node 20+ / pnpm 9；Rust stable ≥ 1.77.2（`x86_64-pc-windows-msvc`）；VS2022 Build Tools + Windows SDK |

## 安装（使用者）

1. 下载或自行构建 `Luma_<version>_x64-setup.exe`，双击按向导安装，从开始菜单启动。
2. 设置 → 粘贴配置地址或选择本地配置文件 → 导入。
3. 首页 / 分类 / 搜索浏览，进入详情选线路与剧集播放；直播页可导入 m3u 源。

未签名安装器首次运行可能触发 SmartScreen：点「更多信息」→「仍要运行」。正式分发需要 OV/EV 代码签名证书。

数据目录：`%APPDATA%\Luma\luma.db`（SQLite，含 `-wal` / `-shm`）。若安装目录整体可写且存在 `data/` 子目录，则自动进入**便携模式**，数据随文件夹移动；删除该目录即清空配置 / 收藏 / 历史。

## 构建（开发者）

构建与打包**全部使用 Tauri 官方工具链**，不手搓脚本：开发用 `tauri dev`，发版用 `tauri build`，图标用 `tauri icon`。

```powershell
corepack pnpm install                # 依赖（pnpm 版本由 package.json 的 packageManager 锁定）
python tools/prepare_runtime.py      # 一次性：准备随包运行时（见下）
corepack pnpm tauri dev              # debug：热重载窗口 + CDP 9222
corepack pnpm tauri build            # release：嵌前端 + 打包 NSIS 安装器
```

### 为什么还要 `prepare_runtime.py`

Tauri 官方只负责「把 `dist/` 嵌进 exe + 打包安装器」，它不会替你准备 Python embeddable / qjs-runner 这些 sidecar 运行时。这个脚本只产出 `tauri.conf.json` 里 `bundle.resources` / `bundle.externalBin` 指向的源文件；**构建本身仍 100% 交给 `tauri build`**。运行时产物不入库，可随时用 `python tools/prepare_runtime.py --check` 体检。

### 产物位置（Tauri 官方约定）

| 模式 | 命令 | 产物 |
|---|---|---|
| debug | `pnpm tauri dev` | `src-tauri/target/debug/luma.exe`（配合 Vite dev server） |
| release | `pnpm tauri build` | `src-tauri/target/release/luma.exe`，安装器在 `src-tauri/target/release/bundle/nsis/` |
| 前端 | `pnpm build` | `dist/`（`tauri.conf.json` 的 `frontendDist` 指向它） |

`src-tauri/target/`、`dist/`、`sidecars/python-embed/` 均为可重建产物，已 gitignore。Release profile 与 `Cargo.toml` 的 `[profile.dev]` / `[profile.release]` 按 Tauri 官方 [App Size](https://v2.tauri.app/concept/size/) 建议设置。

> 注意：裸 `cargo build --release` **不会**把前端嵌入 exe，启动会回退到 `devUrl` 并报连接被拒。发版一律走 `tauri build`。

### 运行期环境变量

变量统一 `LUMA_*` 前缀。

| 变量 | 用途 |
|---|---|
| `LUMA_PYTHON` | 覆盖 Python 解释器（缺省用随包 `python-embed`，再缺省 `python`） |
| `LUMA_QJS_RUNNER` | 覆盖 `qjs-runner.exe` 路径 |

| `LUMA_PROXY_PORT` | 本地反代端口，默认 `9978` |
| `LUMA_DATA_DIR` | 覆盖数据目录（默认 `%APPDATA%\Luma`；exe 同级有 `data/` 时自动便携） |
| `LUMA_RESOURCE_DIR` | 宿主发布给 sidecar 的资源目录，通常无需手工设置 |
| `LUMA_PROXY_ALLOW_LOCAL` | `1` 时允许反代访问 `127.0.0.1`（仅本地联调） |
| `LUMA_SELFCHECK` | `1` 时启动自检并写 `data/selfcheck.log` |
| `LUMA_LOG` | 日志级别：`trace` / `debug` / `info` / `warn` / `error` / `off`，默认 `info` |

### 安装后布局

由 `tauri.conf.json` 的 `bundle.resources` / `bundle.externalBin` 决定：

```text
安装目录/
  Luma.exe
  qjs-runner.exe        JS 源侧载进程（exe 同目录，运行时首选命中点）
  resources/
    sidecars/
      py/                 适配层源码
      python-embed/       嵌入式 Python 3.11 + 第三方包
      qjs-assets/         JS 源内置依赖（8 个模块 + manifest，见 THIRD-PARTY-NOTICES.md）
```

## 日志与诊断

- 位置：安装模式 `%APPDATA%\Luma\logs\luma-YYYY-MM-DD.log`（dev 为 `Luma-debug`），便携模式 `data/logs/`；保留 7 天。
- 级别：默认 `info`，设 `LUMA_LOG=debug` 后重启看 sidecar / 聚合细节。
- 隐私：URL 只记 `scheme + host + path`，query（token / 签名）与播放直链不落盘；日志只写本机。
- 反馈：设置页「复制诊断信息」生成版本 / 平台 / 目录 / 配置规模 / 日志清单的 JSON。

## 测试

```powershell
python tools/check.py                  # 离线一键回归（推荐，无需窗口与外网）
corepack pnpm test                     # 前端单测
cargo test --manifest-path src-tauri/Cargo.toml --lib   # Rust 单测
node tools/run_probes.mjs --list       # 窗口探针清单（需要 debug 窗口 + CDP 9222）
```

阶段断言（`tests/acceptance/p0.py` / `p1.py` / `p3.py`；`p2.py` 的 jar/JVM 回归已随运行时删除）采用累积断言：未交付能力标 `N/A`，`FAIL = 0` 即通过。CI 入口见 `.github/workflows/check.yml`。

## 项目结构

```text
src/                前端（routes / pages / components / hooks / lib / stores / types）
src-tauri/          Rust 宿主（infra/ 底座 + domain/ 业务，#[path] 映射）
sidecars/           Python 适配层 · qjs-runner · 随包 js 资源
contracts/          归一化契约唯一真源（TS / Rust / Python 三端校验）
tests/              e2e 阶段断言 · 兼容检查 · 前端跨模块单测 · fixture
tools/              离线回归（check.py）· 运行时准备 · CDP 探针（probes/ diag/ verify/ audit/）
docs/               架构 · 开发 · 维护 · 发布 · 目录约定 · JS 支持 · 体积
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 进程模型、四类源、数据流、分层与 ADR |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 环境准备、四端调试、日志、常见坑 |
| [docs/MAINTENANCE.md](docs/MAINTENANCE.md) | 契约变更流程、依赖升级、回归分层、工程债 |
| [docs/RELEASING.md](docs/RELEASING.md) | 版本同步清单、发版检查、打包与验收 |
| [docs/project-layout.md](docs/project-layout.md) | 目录 / 产物归口 / 编码约定 |
| [docs/js-support.md](docs/js-support.md) | JS 源机制与随包资源清单 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程与代码约定 |
| [SECURITY.md](SECURITY.md) | 安全模型与漏洞报告 |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | 第三方组件来源与许可 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |

## 已知限制

- 返回**自有本地服务**地址（如 `127.0.0.1:10010`）的 py 源不可用。
- `parses[]` 只实现 type 0 / 1 / 4；type 2/3 依赖 jar 反射（JVM 运行时已移除），直接返回「不支持」而不是卡住。
- 公开的 jx 解析接口存活期普遍很短，解析池失败是常态；失败会保留原地址，由内置嗅探兜底。
- JS 源尚未覆盖 drpy2 `initEnv` 完整 polyfill 与 FongMi 新版 class-based `Spider`。
- T-31（`luma://` 协议关联、JumpList、全屏勿扰）未实现。
- 外部播放与随包 mpv 已移除（2026-11-14）：解码失败只走换线路 / 换源。
- jar 站点（`runtime=jvm`）仍被识别并在导入时屏蔽，但 JVM 运行时已移除（2026-11-15）：社区 Android dex jar 在任何情况下都不会被执行。
- 公开源失效频繁，属正常现象；自动换源与源级原因提示是必需能力。

## 许可证

**尚未选定**（当前 All rights reserved）。详见 [LICENSE](LICENSE)。
在正式许可证写入前，本仓库不授予复制、分发、修改或再许可的权利。
仓库内第三方组件的授权见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)，其中 `drpy2.min.js` / `template.js` 的上游未声明许可证，仍在确认中。
