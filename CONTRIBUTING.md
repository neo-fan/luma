# 贡献指南（CONTRIBUTING）

感谢愿意花时间。这个项目的目标是「一个老实、可维护的 TVBox 配置播放框架」，
所以**能跑**只是底线，**不留下会误导下一个人（或下一个 AI）的痕迹**才是标准。

## 1. 先决条件

| 用途 | 要求 |
|---|---|
| 前端 | Node 20+ / pnpm 9（版本由 `package.json` 的 `packageManager` 锁定，用 `corepack pnpm` 即可） |
| 宿主 | Rust stable ≥ 1.77.2（`x86_64-pc-windows-msvc`）、VS2022 Build Tools + Windows SDK |
| 随包运行时 | `python tools/prepare_runtime.py`（JRE / Python embeddable / qjs-runner staging） |
| 窗口调试 | WebView2 常青版；debug 构建默认开 CDP 9222 |

一次性的准备工作：

```powershell
corepack pnpm install
python tools/prepare_runtime.py
```

## 2. 开发回路（Tauri 官方工具链）

```powershell
corepack pnpm tauri dev      # debug：热重载窗口 + CDP 9222
corepack pnpm tauri build    # release：嵌前端 + 打包 NSIS（发版才用）
```

- **不要**用裸 `cargo build --release` 加自写脚本打包：它不会把 `dist/` 嵌进 exe，启动会回退到 `devUrl` 并报连接被拒。
- 改完停在 debug 即可，不必每次打包；只有准备发版时才 `tauri build`。
- 编译前先停掉 `tauri dev`，否则 cargo 会等 target 目录锁。
- 图标用官方 `corepack pnpm tauri icon <svg>` 重生成，不要手搓 ICO/PNG/BMP。

## 3. 提交前必须跑

```powershell
python tools/check.py        # 7 项离线门禁：契约 / py 兼容 / py 框架 / py 语法 / 前端单测 / Rust 单测 / 运行时候检
```

`--quick` 跳过 Rust 单测、`--full` 追加 `pnpm build`、`--ci` 只跑干净机器能跑的便携子集。

改动涉及 UI / 播放 / 配置链路时，另外跑窗口探针（需要 debug 窗口 + CDP 9222）：

```powershell
node tools/run_probes.mjs            # 默认全套；--list 看清单，--only=a,b 跑子集
node tools/run_probes.mjs --with-ui  # 追加会切桩配置的 UI 冒烟，放最后跑
```

## 4. 代码约定

**通用**

- Rust 生产路径一律 `Result<T, AppError>`，**禁止 `unwrap()` / `expect()`**；
  子进程超时必须进程级可强杀，退出用 Job Object 收尸。
- 前端唯一 IPC 出口是 `src/lib/invoke.ts`，禁止 `import` 任何 Node 内置模块。
- 禁止硬编码本机绝对路径（盘符 / 用户目录 / SDK 路径），用相对路径或环境变量。
- 文本文件一律 **UTF-8 无 BOM + LF**；源码与配置文件名用 ASCII 小写蛇形 / kebab。
- 不内置、不硬编码任何配置地址、片源、直播源、API Key；测试的网络目标只能是 `127.0.0.1`。

**契约（最容易踩）**

`contracts/tvbox.schema.json` 是唯一真源，改字段的顺序是：
schema → `src/types/tvbox.ts` → Rust 序列化 / `sidecars/py/normalize.py` →
`python tests/offline/contract_check.py` 必须 `CONTRACT OK`。
新增 Tauri command 或错误码需要先在文档里写清楚，`contract_check` 与 capabilities 也要同步。

**配置快照**

`imported_json` 是导入原件，**任何运行策略都不许改写它**；只改 `runtime_json`（由 `derive_runtime()` 单向派生）。
手动禁用、源屏蔽、GitHub 加速切换都按这一条走。

**前端**

- 状态：跨页共享态放 `src/stores/appStore.ts`（zustand），页面局部态与 pageCache 不进 store。
- 样式：全站一套设计 token（`src/styles.css` 顶部），不要在组件里写字面量颜色 / 圆角。
- 提示分层：事件 → toast；需要用户决策的错误 → `ErrorBar`；长期说明 → `.tip`。

## 5. 提交与 PR

- 提交信息用 `type(scope): 摘要`（`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `ci`），正文写**为什么**改，而不是复述 diff。
- 一个 PR 只做一件事；顺手修的东西单独提交。
- PR 描述里写：改动文件清单、跑过的命令与结果、未解决的问题。**没跑门禁的 PR 会被打回**，这比写得难看严重得多。
- 不要提交：`dist/`、`src-tauri/target/`、`sidecars/{jre,python-embed}/`、`node_modules/`、真实配置样本、日志。`.gitignore` 已经覆盖，若 `git status` 冒出它们说明忽略规则被改坏。

## 6. 明确不接受的改动

- 内置或硬编码任何源的地址 / 片源 / 直播源 / API Key。
- 绕过 `contracts/tvbox.schema.json` 或双快照隔离（直接改 `imported_json`）。
- 声称「支持社区 jar 源」——原因见 README「为什么社区 jar 源不支持」，这是运行时依赖问题，不是工作量问题。
- 为了让测试变绿而放宽断言、删测试、或把 `FAIL` 改成 `N/A`。

## 7. 行为准则

对事不对人。技术分歧用可复现的证据解决（日志、cdp 抓包、最小复现），不要用音量。
