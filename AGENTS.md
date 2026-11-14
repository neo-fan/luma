# AGENTS.md — 给 AI 协作者与维护者的工作约定

> 本文件是**当前有效**的规范索引，目标 ≤ 20 KB。它不是历史记录：过程与决策的来龙去脉看 `CHANGELOG.md` 和 git history。
> 给人类贡献者的版本在 `CONTRIBUTING.md`；架构细节在 `docs/ARCHITECTURE.md`；本文只写「改动前必须知道的约束」。

## 项目是什么

Luma 是 Windows 11 x64 的 TVBox 配置兼容播放器（空壳框架）。用户自己导入配置（`api.json` / `box.json` 及变体），
应用负责点播浏览 / 搜索 / 详情 / 播放、直播，以及 CMS / Python / JS 三类源的调度。

- 不内置、不硬编码任何配置地址、片源、直播源、API Key。
- 交付形态：官方 `tauri build` 产出的 NSIS 安装器。
- 需求基线：`docs/` 下的设计文档 + `CHANGELOG.md`；实现与文档冲突时，先改文档再改代码。

## 当前状态

| 项 | 值 |
|---|---|
| 版本 | `1.0.3`（`package.json` 唯一来源；同步清单见 `docs/RELEASING.md` §1） |
| 交付物 | `src-tauri/target/release/bundle/nsis/Luma_<version>_x64-setup.exe` |
| 回归基线 | `python tools/check.py` 8/8；`pnpm test` 336（39 个文件）；`cargo test --lib` 159 passed / 1 ignored |
| 窗口探针 | `node tools/run_probes.mjs --list`（需要 debug 窗口 + CDP 9222） |
| 发布状态 | **本地私有，暂不发布**：无 remote、未 push；`LICENSE` 是占位（All rights reserved），不要当成已开源 |

## 技术栈

- 前端：React 18 + TS + Vite、react-router（hash）、zustand、ArtPlayer + hls.js / mpegts.js、Radix / cmdk / sonner / lucide。
- 宿主：Tauri v2 + Rust stable（`x86_64-pc-windows-msvc`）、`reqwest`(rustls)、`tokio`、`axum`(反代)、`rusqlite`(bundled)、`windows`(JobObjects)。
- 适配层：Python 3.11 embeddable（stdio JSON-RPC，线程池 8）、`qjs-runner`（QuickJS）、`sidecars/jre` + `runner.jar`（仅维护态）。
- 配置链与解析链全在 Rust：解密（`domain/config/decrypt.rs`）、归一化（`normalize.rs`）、导入（`import.rs`）、CMS 采集解析（`domain/spider/cms_parse.rs`）、M3U/XMLTV（`domain/live/{m3u,epg}.rs`）都是进程内纯函数，**不再走 sidecar**；sidecar 只负责执行第三方源脚本。外部字节一律经 `infra/textio.rs` 洗成 UTF-8 再解析。

## 架构

```text
前端 (React, Vite dev 1420) ── invoke（唯一 IPC 出口 src/lib/invoke.ts）
  → Rust 主进程：infra/（底座）+ domain/（业务）+ 本地反代 :9978
  → sidecar：Python 适配层 / JVM runner / qjs-runner（stdio JSON-RPC）
```

- **37 个 command 闭集**，注册在 `src-tauri/src/lib.rs`；新增 command 或错误码需先改文档与契约。
- **路由**：`src/routes.tsx` 8 条（`createHashRouter`，detail/player 大字段走 `history.state`，不进 URL）；布局壳 `src/AppShell.tsx`；`View` 联合类型是导航词汇表（`src/lib/nav.ts`）；zustand 只收跨页共享态。
- **Rust 分层是物理分层**：`infra/`、`domain/` 用 `#[path]` 映射，逻辑模块名仍是 `crate::config` 等，因此 37 个 command 路径零改动；`db↔store`、`proxy↔spider` 各自同层以规避环。
- **配置双快照**：`imported_json` 是导入原件，**永不被运行策略改写**；`runtime_json` 由 `derive_runtime()` 单向派生（含 `enabled`/`disabledReason`）。fan-out / 播放 / 前端缓存只读 runtime；`find_site` 查 imported 以兼容旧收藏，`spider_invoke` 单点补策略检查防绕过。
- **数据层**：`<data>/luma.db` 单库，WAL + 事务写，先提交再刷内存缓存；无迁移逻辑。便携模式 = exe 同级有 `data/`。
- **播放链路**：`playerContent` 取 playUrl + header → 反代重写 m3u8 → ArtPlayer/hls.js/mpegts.js → 失败依次：同片换线 → 跨站换源 → 第 4 级嗅探（隐藏 WebView2）→ mpv 兜底。

## 支持范围

| 源类型 | 状态 | 说明 |
|---|---|---|
| CMS 采集 | ✅ 承诺 | 直链 m3u8 |
| Python（`base.spider`） | ✅ 承诺 | 直链型与 `proxy?do=py` 型；返回自有本地服务的源除外 |
| `parses[]` | ✅ 承诺 | type 0 嗅探 / 1 JSON / 4 竞速；type 2/3（jar 反射）不在范围 |
| JS（drpy2 / 经典 `var spider`） | ✅ 支持 | qjs-runner：ESM loader + `assets://` + 8 个随包依赖 |
| jar（jvm / `csp_*`） | ⏸ 仅维护态 | 社区配置是 Android dex jar，Win x64 无解，**导入即屏蔽** |
| 分组分隔条 | — | 归一化为 `enabled: false`，不参与扇出 |

jar 走不通是硬事实（父类 `com.github.catvod.crawler.Spider` 不在 jar 内 + 缺 Android 运行时），不是工作量问题。`sidecars/java` + `spider/jvm.rs` 保留只为 `p2.py` 回归与自编纯 class 模板 jar，**不要写成「部分支持」**。

## 工程铁律

1. **构建与打包只走 Tauri 官方工具链**：`tauri dev`（debug）/ `tauri build`（release）/ `tauri icon`（图标）。裸 `cargo build --release` 不会把 `frontendDist` 嵌进 exe，窗口会回退到 `devUrl` 报 `ERR_CONNECTION_REFUSED`。Cargo profile 用官方 [App Size](https://v2.tauri.app/concept/size/) 建议值，不要加项目私有 tweak。
2. **随包运行时优先**：sidecar 运行时一律走 `paths::sidecar_roots()`，优先级 = 显式环境变量（`LUMA_JAVA` / `LUMA_PYTHON` / `LUMA_QJS_RUNNER`）→ 随包 `sidecars/jre`、`sidecars/python-embed`、exe 同目录 `qjs-runner.exe` → 宿主兜底。用户无需安装 JDK；`prepare_runtime.py` 禁止硬编码本机路径。
3. **契约单一真源** `contracts/tvbox.schema.json`：改字段先改 schema → `src/types/tvbox.ts` → Rust 序列化与 `sidecars/py/normalize.py` → `python tests/offline/contract_check.py` 必须 `CONTRACT OK`。字段 camelCase、`additionalProperties: false`；不许删 TS 字段来「修」校验。
4. **双快照不可越过**：运行策略只改 `runtime_json`，`imported_json` 一个字段都不许动。
5. **换线只认证据**：`dead` 仅限 4xx/5xx、非 `#EXTM3U`、首分片是图片/HTML；超时算 `unknown`，连续 3 次才换。**慢 ≠ 死**。
6. **headers 优先级**：爬虫显式 UA/Referer/Cookie > 配置级 `headers[]`（host 精确 → 通配）> 默认值（`okhttp/3.15` + `{scheme}://{host}/`）。默认值必须由反代最后补，不能提前折进 proxyUrl 的 query。
7. **探针卫生**：会切后端 active 配置的探针，cleanup 必须 `location.reload()`，否则前端内存残留 stub 站点会让后续验收假失败；选择器加 `.content` 作用域（播放页常驻层也有 `.page-body`）。
8. **真实配置 / 密钥不入库**：fixture 必须脱敏且只指向 `127.0.0.1`。
9. **生产路径禁 `unwrap()`**（Rust 一律 `Result<T, AppError>`）；子进程超时必须进程级可强杀，退出用 Job Object 收尸。
10. **不替工具链管中间产物**：cargo 管 `target/`、Vite 管 `.vite`；不要手删锁文件、不要设 `CARGO_INCREMENTAL=0`。人工只补环境变量。

## 编码与 Git 约定

- 文本文件 **UTF-8 无 BOM**、**LF**（`core.autocrlf=false`、`core.safecrlf=true`）；禁止用 `-c core.safecrlf=false` 绕过提交失败，应先转 LF 再 `git add --renormalize .`。
- 源码与配置文件名 ASCII 小写蛇形 / kebab；文档标题中文、文件名 ASCII；JSON 保存中文用 `ensure_ascii=False`；Rust/TS 标识符 ASCII，注释可中文。
- 提交信息 `type(scope): 摘要`，正文写为什么。一个提交只做一件事。
- 产物（`dist/`、`src-tauri/target/`、运行时二进制）不入库；发版后工作区必须干净。
- 构建产物（安装器 / exe）由维护者自行确认，不重复校验版本串与安装冒烟。

## 常用命令

```powershell
# 离线回归（无窗口、无外网；改动的最低门槛）
python tools/check.py                 # 8 项：契约 / py 兼容 / py 框架 / 适配层车道 / py 语法 / 前端单测 / cargo test / 运行时候检
python tools/check.py --quick         # 跳过 cargo test
python tools/check.py --full          # 追加 pnpm build
python tools/check.py --ci            # 干净机器可跑的便携子集（CI job "checks"）

# Tauri 官方工具链
corepack pnpm install
corepack pnpm tauri dev               # debug：窗口 + CDP 9222
corepack pnpm tauri build             # release：嵌前端 + NSIS 安装器
corepack pnpm tauri icon <svg>        # 重生成图标

# 前端
corepack pnpm test                    # vitest
corepack pnpm build                   # tsc --noEmit + vite build

# 随包运行时
python tools/prepare_runtime.py            # 全量补齐（幂等）
python tools/prepare_runtime.py --check    # 只体检
cargo build --release --manifest-path sidecars/qjs-runner/Cargo.toml   # 改 rquickjs 后必重编

# Rust
cargo check --manifest-path src-tauri/Cargo.toml

# 窗口探针（需 debug 窗口 + CDP 9222）
node tools/run_probes.mjs             # 全套；--list / --only=a,b / --with-ui
```

## 开发约定

- 本地需求文档优先：任何与设计文档冲突的实现决策，先说明理由并改文档。
- 不臆造项目事实；改动前说明影响范围，改动后列出文件清单、跑过的命令与结果、未解决问题。
- 构建与测试通过再交付；密钥不入库、不回显；代码禁止硬编码本机绝对路径。
- 前端唯一 IPC 入口 `src/lib/invoke.ts`，禁止 `import` 任何 Node 内置模块。
- 单源默认 15s 墙钟超时、配置拉取 10s；fan-out 并发上限 20（`tokio::JoinSet`）。
- 「先别回归」= 需求全落地再测；环境缺失直接问维护者。

## 文档索引

| 我要… | 去哪 |
|---|---|
| 理解进程模型 / 四类源 / 数据流 / ADR | `docs/ARCHITECTURE.md` |
| 环境准备 / 四端调试 / 日志 / 常见坑 | `docs/DEVELOPMENT.md` |
| 测试分层 / 用例该放哪 / 各层命令 | `docs/TESTING.md` |
| 改项目要守什么规矩 / 已知工程债 | `docs/MAINTENANCE.md` |
| 升版本 / 打包 / 验收 | `docs/RELEASING.md` |
| 目录、产物归口、编码约定 | `docs/project-layout.md` |
| 贡献流程 | `CONTRIBUTING.md` |
| 安全模型与漏洞报告 | `SECURITY.md` |
| 第三方组件与许可 | `THIRD-PARTY-NOTICES.md` |
