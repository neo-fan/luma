# AGENTS.md — 给 AI 协作者与维护者的工作约定

> 本文件是**当前有效**的规范索引，目标 ≤ 20 KB。它不是历史记录：过程与决策的来龙去脉看 `CHANGELOG.md` 和 git history。
> 给人类贡献者的版本在 `CONTRIBUTING.md`；架构细节在 `docs/ARCHITECTURE.md`；本文只写「改动前必须知道的约束」。

## 项目是什么

Luma 是 Windows 11 x64 的配置兼容播放框架（空壳框架，兼容 TVBox 系配置）。用户自己导入配置（`api.json` / `box.json` 及变体），
应用负责点播浏览 / 搜索 / 详情 / 播放、直播，以及 CMS / Python / JS 三类源的调度。

- 不内置、不硬编码任何配置地址、片源、直播源、API Key。
- 交付形态：官方 `tauri build` 产出的 NSIS 安装器。
- 需求基线：`docs/` 下的设计文档 + `CHANGELOG.md`；实现与文档冲突时，先改文档再改代码。

## 当前状态

| 项 | 值 |
|---|---|
| 版本 | `2.0.7`（`package.json` 唯一来源；`tauri.conf.json` 直接指向它，`build.rs` 断言 Cargo 版本，`python tools/version_check.py` 一键核对） |
| 交付物 | `src-tauri/target/release/bundle/nsis/Luma_<version>_x64-setup.exe` |
| 回归基线 | `python tools/check.py` 12/12；`pnpm test` 740（91 个文件）；`cargo test --lib` 296 passed / 2 ignored；`qjs-runner` cargo test 7 passed |
| 窗口探针 | `node tools/run_probes.mjs --list`（需要 debug 窗口 + CDP 9222） |
| 发布状态 | `LICENSE` 为 **GPL-3.0-or-later**；仓库已公开并推送至 `neo-fan/luma`；发布记录见 [GitHub Releases](https://github.com/neo-fan/luma/releases) 与 `git tag`，安装包只由 CI 出、本地 `target/` 不保留；升版本用 `python tools/release_prep.py X.Y.Z` 一笔提交收口，推 tag 即触发 `release.yml` 出包 |

## 技术栈

- 前端：React 18 + TS + Vite、react-router（hash）、zustand、ArtPlayer + hls.js / mpegts.js、Radix / cmdk / sonner / lucide。
- 宿主：Tauri v2 + Rust stable（`x86_64-pc-windows-msvc`）、`reqwest`(rustls)、`tokio`、`axum`(反代)、`rusqlite`(bundled)、`windows`(JobObjects)。
- 适配层：Python 3.11 embeddable（stdio JSON-RPC，单车道 8 线程），**只执行第三方源脚本**（`ping` + `spider.py`）；`qjs-runner`（QuickJS）同理只执行 JS 源；jar 站点只保留分类，JVM 运行时已移除。
- 配置链与解析链全在 Rust：解密（`domain/config/decrypt.rs`）、归一化（`normalize.rs`）、导入（`import.rs`）、CMS 采集解析（`domain/spider/cms_parse.rs`）、M3U/XMLTV（`domain/live/{m3u,epg}.rs`）都是进程内纯函数，**不再走 sidecar**；sidecar 只负责执行第三方源脚本。外部字节一律经 `infra/textio.rs` 洗成 UTF-8 再解析。

## 架构

```text
前端 (React, Vite dev 1420) ── invoke（唯一 IPC 出口 src/lib/invoke.ts）
  → Rust 主进程：infra/（底座）+ domain/（业务）+ 本地反代 :9978
  → sidecar：Python 适配层 / qjs-runner（stdio JSON-RPC）
```

- **40 个 command 闭集**，注册在 `src-tauri/src/lib.rs`；新增 command 或错误码需先改文档与契约。
- **路由**：`src/routes.tsx` 8 条（`createHashRouter`，detail/player 大字段走 `history.state`，不进 URL）；布局壳 `src/AppShell.tsx`；`View` 联合类型是导航词汇表（`src/lib/nav.ts`）；zustand 只收跨页共享态。
- **Rust 分层是物理分层**：`infra/`、`domain/` 用 `#[path]` 映射，逻辑模块名仍是 `crate::config` 等，因此 40 个 command 路径零改动；`db↔store`、`proxy↔spider` 各自同层以规避环。
- **配置双快照**：`imported_json` 是导入原件，**永不被运行策略改写**；`runtime_json` 由 `derive_runtime()` 单向派生（含 `enabled`/`disabledReason`）。fan-out / 播放 / 前端缓存只读 runtime；`find_site` 查 imported 以兼容旧收藏，`spider_invoke` 单点补策略检查防绕过。
- **数据层**：`<data>/luma.db` 单库，WAL + 事务写，先提交再刷内存缓存；无迁移逻辑。数据目录 = `%APPDATA%\<identifier>`，`LUMA_DATA_DIR` 可覆盖，无便携布局。
- **播放链路**：`playerContent` 取 playUrl + header → 反代重写 m3u8 → ArtPlayer/hls.js/mpegts.js → 失败依次：就地重连同一地址（800/1600/3200/6400ms，共 4 次）→ 仍失败则上报（换线 / 换源由 UI 选择发起，**不自动切换**）→ 第 4 级嗅探（隐藏 WebView2）；没有外部播放兜底。反代上游超时只看建连 10s 与读空闲 20s，**不得用整体墙钟截止**（会掐断慢分片）。
- **切换编排只有一份真源**：`src/hooks/playback/`（`intent ?? committed` + 代次令牌 + 串行提交门 + 手动持有）。换集 / 换源 / 换线的落地都必须经 controller 的同一个提交口；**禁止再引入第二套「当前播放目标」状态**（历史上四套状态互相覆盖，是切换错乱的结构性原因）。

## 支持范围

| 源类型 | 状态 | 说明 |
|---|---|---|
| CMS 采集 | ✅ 承诺 | 直链 m3u8 |
| Python（`base.spider`） | ✅ 承诺 | 直链型与 `proxy?do=py` 型；返回自有本地服务的源除外 |
| `parses[]` | ✅ 承诺 | type 0 嗅探 / 1 JSON / 4 竞速；type 2/3（jar 反射）不在范围 |
| JS（drpy2 / 经典 `var spider`） | ✅ 支持 | qjs-runner：ESM loader + `assets://` + 8 个随包依赖 |
| jar（jvm / `csp_*`） | ⛔ 运行时已移除 | 社区配置是 Android dex jar，Win x64 无解；站点仍识别为 `jvm` 并**导入即屏蔽**，但 JVM 运行时（`sidecars/jre` + `runner.jar`）已删除 |
| 分组分隔条 | — | 归一化为 `enabled: false`，不参与扇出 |

jar 走不通是硬事实（父类 `com.github.catvod.crawler.Spider` 不在 jar 内 + 缺 Android 运行时），不是工作量问题。JVM 运行时（`spider/jvm.rs` + `sidecars/java` + `sidecars/jre` + 打包 resources）已在 1.0.3 整体移除；契约里的 `jvm` 分类与屏蔽原因**必须保留**，配置里的 jar 站点仍要识别为 `jvm` 并屏蔽。**不要写成「部分支持」，也不要重新引入 JVM 通道。**

## 工程铁律

1. **构建与打包只走 Tauri 官方工具链**：`pnpm dev:app`（dev，= `tauri dev` + `app.luma.dev`）/ `pnpm build:app`（stable）/ `pnpm build:beta`（beta，按需）/ `tauri icon`（图标）。裸 `cargo build --release` 不会把 `frontendDist` 嵌进 exe，窗口会回退到 `devUrl` 报 `ERR_CONNECTION_REFUSED`。Cargo profile 用官方 [App Size](https://v2.tauri.app/concept/size/) 建议值，不要加项目私有 tweak。
2. **随包运行时优先**：sidecar 运行时一律走 `paths::sidecar_roots()`，优先级 = 显式环境变量（`LUMA_PYTHON` / `LUMA_QJS_RUNNER`）→ 随包 `sidecars/python-embed`、exe 同目录 `qjs-runner.exe` → 宿主兜底。用户无需安装 Python；`prepare_runtime.py` 禁止硬编码本机路径。
3. **契约单一真源** `contracts/luma.schema.json`：改字段先改 schema → `src/types/luma.ts` → Rust 序列化（`domain/spider/*`、`domain/config/*`）→ `python tests/offline/contract_check.py` 必须 `CONTRACT OK`。字段 camelCase、`additionalProperties: false`；不许删 TS 字段来「修」校验。
4. **双快照不可越过**：运行策略只改 `runtime_json`，`imported_json` 一个字段都不许动。
5. **换线只认证据**：`dead` 仅限 4xx/5xx、非 `#EXTM3U`、首分片是图片/HTML；超时算 `unknown`，连续 3 次才换。**慢 ≠ 死**。
6. **headers 优先级**：爬虫显式 UA/Referer/Cookie > 配置级 `headers[]`（host 精确 → 通配）> 默认值（`okhttp/3.15` + `{scheme}://{host}/`）。默认值必须由反代最后补，不能提前折进 proxyUrl 的 query。
7. **探针卫生**：会切后端 active 配置的探针，cleanup 必须 `location.reload()`，否则前端内存残留 stub 站点会让后续验收假失败；选择器加 `.content` 作用域（播放页常驻层也有 `.page-body`）。
8. **真实配置 / 密钥不入库**：fixture 必须脱敏且只指向 `127.0.0.1`。
9. **生产路径禁 `unwrap()`**（Rust 一律 `Result<T, AppError>`）；子进程超时必须进程级可强杀，退出用 Job Object 收尸。
10. **不替工具链管中间产物**：cargo 管 `target/`、Vite 管 `.vite`；不要手删锁文件、不要设 `CARGO_INCREMENTAL=0`。人工只补环境变量。
11. **清理与构建只走官方命令，禁止绕过、禁止手搓**：清理编译产物一律 `cargo clean`（可用 `--release` / `--dry-run` / `-p` 等官方选项），**严禁 `rm -rf` / `del` 手删 `target/`**；构建、启动、打包一律 `pnpm dev:app` / `tauri build` / `tauri icon`，**严禁用裸 `cargo build` 绕过**，也**禁止用 `CARGO_TARGET_DIR` 指向新目录、复制预编译产物、关调试信息（D8050 之类）等手搓命令绕开构建锁或环境限制**。锁被占用只有一条正路：先停 dev（第 12 条），再跑官方命令——**`CARGO_TARGET_DIR` 没有例外条款**，包括 agent 与 CI（`.gitignore` 里的根 `/target/` 仅为兜底忽略，不代表允许产生）。
12. **dev 后台常驻、CDP 探活、按名收尾**：`pnpm dev:app` 放后台跑并落盘日志，用 CDP `:9222` 探测状态，**禁止前台死等**（命令与五态判定见 `docs/DEVELOPMENT.md` §2.3）。**启动命令照抄 §2.3 的 `Start-Process pwsh …`，禁止 `cmd &` / `nohup` / `setsid`**：父 shell 退出会连带结束 Vite 与编译进程，表现为日志已打印 `VITE ready`、端口却无人监听。dev 进程名是 `Luma_dev.exe`、安装版是 `Luma.exe`，停止直接 `Stop-Process -Name Luma_dev`；`cargo test` / `cargo check` / `check.py` 前必须先停 dev——`target` 锁与 `Luma_dev.exe`/`qjs-runner.exe` 的产物占用都会让构建失败，不等锁、不绕行。**同一时刻只允许一棵源码树跑 dev**：`app.luma.dev` 数据目录、9979 反代、1420 Vite、9222 CDP 与 `Luma_dev` 单实例互斥体都是全局单值，复制工作树必然互抢；需要并行验证就换通道（`build:beta`），不要复制工作树。

## 编码与 Git 约定

- 文本文件 **UTF-8 无 BOM**、**LF**（`core.autocrlf=false`、`core.safecrlf=true`）；禁止用 `-c core.safecrlf=false` 绕过提交失败，应先转 LF 再 `git add --renormalize .`。
- 源码与配置文件名 ASCII 小写蛇形 / kebab；文档标题中文、文件名 ASCII；JSON 保存中文用 `ensure_ascii=False`；Rust/TS 标识符 ASCII，注释可中文。
- 提交信息 `type(scope): 摘要`，正文写为什么。一个提交只做一件事。
- 产物（`dist/`、`src-tauri/target/`、运行时二进制）不入库；发版后工作区必须干净。
- 构建产物（安装器 / exe）由维护者自行确认，不重复校验版本串与安装冒烟。

## 常用命令

```powershell
# 离线回归（无窗口、无外网；改动的最低门槛）
python tools/check.py                 # 12 项：契约 / 版本一致性 / 发布收口 / py 兼容 / py 框架 / 适配层健壮性 / py 语法 / 前端单测 / cargo test / 运行时候检 / qjs-runner 单测 / qjs 引擎(GBK+ds)
python tools/check.py --quick         # 跳过 cargo test
python tools/check.py --full          # 追加 pnpm build
python tools/check.py --ci            # 便携子集（5 项，不依赖随包 python-embed）

# Tauri 官方工具链
corepack pnpm install
corepack pnpm dev:app                 # dev：窗口 + CDP 9222（app.luma.dev）
corepack pnpm build:app               # stable 安装包（app.luma）
corepack pnpm build:beta              # beta 安装包（app.luma.beta，按需）
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
- 样式集中在 `src/styles/`：**级联顺序由 `index.css` 的 `@import` 决定**（`polish.css` 是后置覆盖层，必须最后），新增规则加到对应模块的末尾，不要随手调整顺序；颜色 / 间距 / 圆角 / 字号统一用 `base.css` 的 `:root` 变量，不写死数值，也不用内联 `style`（需要按数据算尺寸的除外）。
- 单源默认 15s 墙钟超时、配置拉取 10s；fan-out 并发上限 20（`tokio::JoinSet`）。
- 「先别回归」= 需求全落地再测；环境缺失直接问维护者。

## 文档索引

| 我要… | 去哪 |
|---|---|
| 理解实现基线 / 规格（现状唯一依据） | `docs/spec.md` |
| 理解进程模型 / 四类源 / 数据流 / ADR | `docs/ARCHITECTURE.md` |
| 环境准备 / 四端调试 / 日志 / 常见坑 | `docs/DEVELOPMENT.md` |
| 测试分层 / 用例该放哪 / 各层命令 | `docs/TESTING.md` |
| 改项目要守什么规矩 / 已知工程债 | `docs/MAINTENANCE.md` |
| 升版本 / 打包 / 验收 | `docs/RELEASING.md` |
| 目录、产物归口、编码约定 | `docs/project-layout.md` |
| 贡献流程 | `CONTRIBUTING.md` |
| 安全模型与漏洞报告 | `SECURITY.md` |
| 第三方组件与许可 | `THIRD-PARTY-NOTICES.md` |
