# 维护与升级（MAINTENANCE）

> 日常维护入口。四类流程各自单一入口：**调试** `docs/DEVELOPMENT.md`、**架构** `docs/ARCHITECTURE.md`、**发布** `docs/RELEASING.md`、**目录** `docs/project-layout.md`。本文只讲「改项目时该守什么规矩」。

## 1. 入口速查

| 我要… | 去哪 |
|---|---|
| 本地跑起来 / 排查 UI / 看日志 | `docs/DEVELOPMENT.md` |
| 理解进程模型、四类源、数据流 | `docs/ARCHITECTURE.md`（含 ADR） |
| 升版本 / 打包 / 验收 | `docs/RELEASING.md` |
| 改动后判断有没有破坏基线 | `python tools/check.py` |
| 找某类文件放哪、是否入库 | `docs/project-layout.md` |
| 查历史决策与逐轮记录 | git history、`CHANGELOG.md` |

## 2. 回归分层

| 层 | 命令 | 依赖 | 用途 |
|---|---|---|---|
| 离线（必过） | `python tools/check.py` | 无窗口、无外网 | 每次改动的**最低门槛** |
| CI | `.github/workflows/check.yml` | 干净 runner（GitHub Actions） | 推送/PR 自动跑：`--ci` 子集 + rust 单测 + py 适配层 |
| 窗口探针 | `node tools/run_probes.mjs` | debug 窗口 + CDP 9222 + Vite 1420 | 改 UI / 播放 / 配置链路后 |
| 阶段断言 | `python tests/acceptance/p0.py` ~ `p3.py` | stub + 运行中的应用 | 改 sidecar / 打包后 |
| 真实配置 | 导入 → 搜索 → 详情 → 播放 | 外网 | 源兼容结论（外网抖动不算回归） |

`check.py` 覆盖：契约、版本一致性、Python 兼容、py 框架、语法编译、前端单测、Rust 单测、运行时产物体检。加 `--full` 会额外跑 `pnpm build`。

新增/调整用例前先看 `docs/TESTING.md`：单测（`src/**`、Rust 内联）/ 离线检查（`tests/offline/`）/ 阶段验收（`tests/acceptance/`）/ 窗口探针（`tools/`）的边界与命令都在那一份里，加进 `check.py` 要同步本表与那里的清单。

`--ci` 是**便携子集**（契约 + Python 语法 + 前端单测），只挑「任何干净机器都能跑」的检查：

- py 适配层断言要 pip 依赖（lxml / pyquery / pycryptodome）→ 由 CI 的 `py-adapter` job 单独装 `tools/python-requirements.txt` 后跑；
- Rust 单测需要 `dist/` 与 `bundle.resources` 路径（`tauri-build` 每次构建都复制，缺路径直接失败）→ 由 `rust` job 先 `pnpm build`、再用空目录/空文件补齐 `sidecars/python-embed` 与 `src-tauri/binaries/qjs-runner-<triple>.exe` 后跑；
- 运行时产物体检只对**本机已 prepare 过**的仓库有意义，CI 里没有这些产物。

**窗口探针不进 CI**：需要 debug 窗口 + CDP 9222，仍留在发版手工清单（`docs/RELEASING.md` §2.2）。

## 3. 契约变更流程（最容易踩）

`contracts/luma.schema.json` 是**唯一真源**，TS / Rust / Python 三端同步：

1. 先改 `$defs` 里的字段（含 `description` 说明语义）。
2. 再改 `src/types/luma.ts` 的接口字段与注释。
3. 再改 Rust 序列化侧（`src-tauri/src/domain/spider/`、`src-tauri/src/domain/config/`）。
4. `python tests/offline/contract_check.py` 必须 `CONTRACT OK`。
5. 字段名是 camelCase 且 `additionalProperties: false`，新增字段**必须**同步 schema，否则校验报 `in TS, missing in schema`。

> 1.0.0 修过一次真实漂移：`Site.searchableDeclared`、`SpiderRequest.stream/streamId` 三端早已在用，schema 却漏了。不要删 TS 字段来"修"校验。

## 4. 新增 Tauri command

1. 规格先行：新增 command 或错误码需改 `docs/spec.md`。
2. Rust 侧一律 `Result<T, AppError>`，生产路径禁 `unwrap()`；错误码走 `code::*`。
3. `src-tauri/src/lib.rs` 的 `generate_handler!` 注册（当前 37 个）。
4. 前端唯一出口 `src/lib/invoke.ts`，禁止 `import` Node 内置模块。
5. 评估 `capabilities/default.json` 权限白名单（嗅探窗口**故意**不在 `windows: ["main"]` 内，零 command 权限）。
6. 探针卫生：会切换后端 active 配置的探针，cleanup 必须 `location.reload()`，否则前端残留 stub 站点让后续假失败。

## 5. 依赖与运行时产物升级

| 产物 | 重建命令 | 注意 |
|---|---|---|
| 随包 Python 第三方依赖 | `python tools/prepare_runtime.py` | 清单在 `tools/python-requirements.txt`；dev 与交付统一用 `sidecars/python-embed`，不要退回系统 python |
| qjs-runner | `cargo build --release --manifest-path sidecars/qjs-runner/Cargo.toml` | 改 `rquickjs` 后必重编，直驱前确认 mtime |
| 前端依赖 | `corepack pnpm install` | pnpm 由 corepack 锁 9.15.4，`pnpm-lock.yaml` 入库 |
| JS 随包资源 | 只读校验 `prepare_runtime.py --check` | `sidecars/qjs-assets/` 是**入库源码资源**，8 个文件 + manifest 有 SHA256 校验，不下载、不可重建 |

**禁止**：硬编码本机绝对路径（盘符、SDK 目录、用户目录）；把运行时产物提交进 git；为凑体积删运行时产物。

## 6. 文档维护

- 分工：**当前规范**写 `AGENTS.md`；**对外说明**写 `README.md`；**贡献流程**写 `CONTRIBUTING.md`；**逐轮过程**留在 git history 与 `CHANGELOG.md`（本仓库不设内部日志目录）。
- **`AGENTS.md` 有硬预算：≤ 20 KB**。它是给 AI 协作者的指令文件，超过 65 KB 的指令预算就会被截断（旧版曾膨胀到 95,925 字节，实测第 298 行之后全部读不到）。写新内容前先问「这是当前规范，还是一条决策记录？」：决策记录写进 `CHANGELOG.md` 或提交信息，`AGENTS.md` 只留一句结论。
- `AGENTS.md` 里的测试数字是**当时快照**，当前基线以 `docs/RELEASING.md` 与 `tools/check.py` 输出为准，不要拿旧数字改代码。
- 本仓库**只保留活文档**（`docs/` 下 7 份）；冻结快照（竞品评估、UI 走查、逐站实测等）不再随仓库分发，需要的读者看 git 历史。
- 每次发版更新 `CHANGELOG.md` 与 `docs/size-report.md`。

## 7. 日志与诊断

- 安装模式 `%APPDATA%\Luma\logs\luma-YYYY-MM-DD.log`，dev `%APPDATA%\Luma-debug\logs\`；便携模式（exe 同级 `data/`）为 `data/logs\`。保留 7 天。
- `LUMA_LOG=debug` 看 sidecar / 聚合细节；`logs/spider/spider.<日期>.log` 记录第三方 py 脚本异常（每行 JSON，含 traceback），宿主与前端各有 `logs/app`、`logs/ui`。
- URL 只记 `scheme + host + path`，token / 签名 / 播放直链不落盘。
- 设置页「复制诊断信息 / 打开日志目录 / 导出反馈文件」是用户侧取证入口。

## 8. Git 维护

- **换行**：`.gitattributes` 已定 `* text=auto eol=lf`，本地 `core.autocrlf=false` / `core.safecrlf=true`。两类文件**故意保留原字节**、禁止规范化：`tests/fixtures/media/**`（二进制）、`sidecars/qjs-assets/**`（SHA256 必须与 manifest 一致）。
- **不要用 `-c core.safecrlf=false` 绕过提交失败**：报 `CRLF would be replaced by LF` 说明有脚本用 `open(...,'w')` 未指定 `newline` 在 Windows 写出了 CRLF。正确做法是把工作区文件转回 LF，再 `git add --renormalize .`。写文件统一用 `Path.write_text(..., newline="\n")`。
- **提交前**：`python tools/check.py` 全绿；`git status --short` 应干净（发版后不留散落改动）。每轮自己写 commit、**不 push**；版本发布打本地 annotated tag `vX.Y.Z`。
- **工作区整洁**：`release/`、`dist/`、`target/`、`*.log`、`__pycache__`、`*.tsbuildinfo` 均由 `.gitignore` 覆盖，无需手工清理；若 `git status` 冒出这些，说明忽略规则被改坏。
- **产物可追溯**：release 包必须从已提交的工作区构建；若有未提交改动被编进 exe/前端，需在 `CHANGELOG.md` 显式记录，否则产物与 tag 不一致。

## 9. 已知工程债（按优先级）

1. **CI 首次远端运行待验证**：`.github/workflows/check.yml` 已落地（`checks` / `rust` / `py-adapter` 三个 job），但本机没有远端仓库，尚未在 GitHub runner 上实跑过；首次推送后要按实际报错调（重点看 `rust` job 的 `pnpm build` + 资源桩是否够用）。
2. Rust `#[path]` 是物理分层，逻辑模块名仍是 `crate::config`，依赖方向不受编译器约束（刻意取舍，第二阶段再做前缀化）。
3. 超长文件：`domain/spider/mod.rs`、`domain/spider/quickjs.rs`、`PlayerPage.tsx` + `usePlayerEngine.ts`（`domain/config`、`domain/proxy`、`infra/db`、`infra/logging` 已按职责拆分，见 §10）。
4. 四端协议靠约定 + 5 类结构校验，未做代码生成。

## 10. 已还的债（留档，避免重复讨论）

- `tools/` 71 个脚本平铺 → 已按用途分 `probes/` / `diag/` / `verify/` / `audit/` 四个子目录，`tools/run_probes.mjs` 仍是唯一入口。
- `domain/config.rs`（2,154 行 god module）→ 已拆为 `config/{mod,derive,naming,import,github,refresh}.rs`，命令层与实现分离。
- `domain/proxy.rs`（1,105 行）→ 已拆为 `proxy/{mod,handlers,guard,playlist}.rs` + `proxy/tests.rs`；`mod.rs` 留状态/路由/命令层，handler、目标校验、播放列表改写各自成文件。
- `infra/db.rs`（1,026 行）→ 已拆为 `db/{mod,schema,meta,configs,favorites,history}.rs` + `db/tests.rs`；行结构体留 `mod.rs`，每个子模块一个 `impl Db`，schema 迁移与四类仓储互不牵连。
- `infra/logging.rs`（587 行）→ 已拆为 `logging/{mod,writer,redact,ui,diagnostics,report}.rs` + `logging/tests.rs`；`mod.rs` 留目录解析/初始化/级别解析与 4 个命令，按日滚动、脱敏规则、诊断采集、反馈文件各成文件。
