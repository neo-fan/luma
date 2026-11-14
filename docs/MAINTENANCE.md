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
| 查历史决策与逐轮记录 | `docs/log/2026-11.md`、`docs/tasks/` |

## 2. 回归分层

| 层 | 命令 | 依赖 | 用途 |
|---|---|---|---|
| 离线（必过） | `python tools/check.py` | 无窗口、无外网 | 每次改动的**最低门槛** |
| 窗口探针 | `node tools/run_probes.mjs` | debug 窗口 + CDP 9222 + Vite 1420 | 改 UI / 播放 / 配置链路后 |
| 阶段断言 | `python tests/e2e/p0.py` ~ `p3.py` | stub + 运行中的应用 | 改 sidecar / 打包后 |
| 真实配置 | 导入 → 搜索 → 详情 → 播放 | 外网 | 源兼容结论（外网抖动不算回归） |

`check.py` 覆盖：契约、Python 兼容、py 框架、语法编译、前端单测、Rust 单测、运行时产物体检。加 `--full` 会额外跑 `pnpm build`。

## 3. 契约变更流程（最容易踩）

`contracts/tvbox.schema.json` 是**唯一真源**，TS / Rust / Python 三端同步：

1. 先改 `$defs` 里的字段（含 `description` 说明语义）。
2. 再改 `src/types/tvbox.ts` 的接口字段与注释。
3. 再改 Rust 序列化侧（`src-tauri/src/domain/spider/` 等）与 `sidecars/py/normalize.py`。
4. `python tests/e2e/contract_check.py` 必须 `CONTRACT OK`。
5. 字段名是 camelCase 且 `additionalProperties: false`，新增字段**必须**同步 schema，否则校验报 `in TS, missing in schema`。

> 1.0.0 修过一次真实漂移：`Site.searchableDeclared`、`SpiderRequest.stream/streamId` 三端早已在用，schema 却漏了。不要删 TS 字段来"修"校验。

## 4. 新增 Tauri command

1. 规格先行：新增 command 或错误码需改本地 `docs/spec-v1.1/` 文档。
2. Rust 侧一律 `Result<T, AppError>`，生产路径禁 `unwrap()`；错误码走 `code::*`。
3. `src-tauri/src/lib.rs` 的 `generate_handler!` 注册（当前 37 个）。
4. 前端唯一出口 `src/lib/invoke.ts`，禁止 `import` Node 内置模块。
5. 评估 `capabilities/default.json` 权限白名单（嗅探窗口**故意**不在 `windows: ["main"]` 内，零 command 权限）。
6. 探针卫生：会切换后端 active 配置的探针，cleanup 必须 `location.reload()`，否则前端残留 stub 站点让后续假失败。

## 5. 依赖与运行时产物升级

| 产物 | 重建命令 | 注意 |
|---|---|---|
| 随包 Python 第三方依赖 | `python tools/prepare_runtime.py` | 清单在 `tools/python-requirements.txt`；dev 与交付统一用 `sidecars/python-embed`，不要退回系统 python |
| 随包 JRE | `python tools/prepare_runtime.py --force` | 只在重建时需要 JDK 17（设 `LUMA_JDK17_HOME` / `JAVA_HOME` 或 PATH 上的 `jlink`）；**运行期用随包 JRE，用户无需装 JDK** |
| qjs-runner | `cargo build --release --manifest-path sidecars/qjs-runner/Cargo.toml` | 改 `rquickjs` 后必重编，直驱前确认 mtime |
| 前端依赖 | `corepack pnpm install` | pnpm 由 corepack 锁 9.15.4，`pnpm-lock.yaml` 入库 |
| JS 随包资源 | 只读校验 `prepare_runtime.py --check` | `sidecars/qjs-assets/` 是**入库源码资源**，8 个文件 + manifest 有 SHA256 校验，不下载、不可重建 |

**禁止**：硬编码本机绝对路径（盘符、SDK 目录、用户目录）；把运行时产物提交进 git；为凑体积删运行时产物。

## 6. 文档维护

- **规范与决策**写 `AGENTS.md`；**逐轮过程**写 `docs/log/YYYY-MM.md`；**阶段交付**写 `docs/tasks/`。
- `AGENTS.md` 里各交付段落的测试数字是**当时快照**，当前基线以 `docs/RELEASING.md` 与 `tools/check.py` 输出为准，不要拿旧数字改代码。
- 归档资产（`SPEC_REVIEW.md`、`DESIGN-SPEC.md`、`docs/ui-preview.html`、`docs/spec-v1.1/cloud-actions.json`）文件头已标注，**不是实现依据**；实现依据只有 `docs/spec-v1.1/CHANGELOG.md` + `replacements.md`。
- `docs/site-compat-report.md` 是 2026-11-12 冻结快照，表内「暂不支持」不代表当前支持范围。
- 每次发版更新 `CHANGELOG.md` 与 `docs/size-report.md`。

## 7. 日志与诊断

- 便携版 `data/logs/luma-YYYY-MM-DD.log`，dev `%APPDATA%\Luma-debug\logs\`；保留 7 天。
- `LUMA_LOG=debug` 看 sidecar / 聚合细节；`logs/spider.log` 记录第三方 py 脚本异常（每行 JSON，含 traceback）。
- URL 只记 `scheme + host + path`，token / 签名 / 播放直链不落盘。
- 设置页「复制诊断信息 / 打开日志目录 / 导出反馈文件」是用户侧取证入口。

## 8. Git 维护

- **换行**：`.gitattributes` 已定 `* text=auto eol=lf`，本地 `core.autocrlf=false` / `core.safecrlf=true`。三类文件**故意保留原字节**、禁止规范化：`docs/spec-v1.0/spec-v1.0-raw.md`（逐字节归档）、`tests/fixtures/media/**`（二进制）、`sidecars/qjs-assets/**`（SHA256 必须与 manifest 一致）。
- **不要用 `-c core.safecrlf=false` 绕过提交失败**：报 `CRLF would be replaced by LF` 说明有脚本用 `open(...,'w')` 未指定 `newline` 在 Windows 写出了 CRLF。正确做法是把工作区文件转回 LF，再 `git add --renormalize .`。写文件统一用 `Path.write_text(..., newline="\n")`。
- **提交前**：`python tools/check.py` 全绿；`git status --short` 应干净（发版后不留散落改动）。每轮自己写 commit、**不 push**；版本发布打本地 annotated tag `vX.Y.Z`。
- **工作区整洁**：`release/`、`dist/`、`target/`、`*.log`、`__pycache__`、`*.tsbuildinfo` 均由 `.gitignore` 覆盖，无需手工清理；若 `git status` 冒出这些，说明忽略规则被改坏。
- **产物可追溯**：release 包必须从已提交的工作区构建；若有未提交改动被编进 exe/前端，需在 `CHANGELOG.md` 显式记录，否则产物与 tag 不一致。

## 9. 已知工程债（按优先级）

1. **无 CI**：`tools/check.py` 已提供离线一键入口，但尚未接入持续集成；发版仍靠人工执行清单。
2. Rust `#[path]` 是物理分层，逻辑模块名仍是 `crate::config`，依赖方向不受编译器约束（刻意取舍，第二阶段再做前缀化）。
3. 超长文件：`domain/config.rs`、`proxy.rs`、`PlayerPage.tsx` + `usePlayerEngine.ts`。
4. `tools/` 71 个探针平铺，缺 `probes/` 子目录归类。
5. 四端协议靠约定 + 5 类结构校验，未做代码生成。
