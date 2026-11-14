# 发布流程（RELEASING）

> 发版唯一入口。调试见 `docs/DEVELOPMENT.md`，日常维护/升级见 `docs/MAINTENANCE.md`，目录约定见 `docs/project-layout.md`，架构见 `docs/ARCHITECTURE.md`。
> **构建与打包全部走 Tauri 官方工具链，不手搓**：本地 commit **不 push**；发版用官方 `tauri build` 产出 NSIS 安装器。

## 1. 版本单一来源与同步清单

`package.json` 的 `version` 是唯一来源，`vite.config.ts` 通过 `define` 注入 `__APP_VERSION__`。升级版本时**以下文件必须同步**，缺一即版本漂移：

| 文件 | 字段 | 校验 |
|---|---|---|
| `package.json` | `version` | 唯一来源 |
| `src-tauri/Cargo.toml` | `version` | `cargo` 包版本 |
| `src-tauri/Cargo.lock` | `name = "luma"` 下的 `version` | `cargo build` 自动改，提交前确认 |
| `src-tauri/tauri.conf.json` | `version` | 安装器元数据；`bundle.targets` 控制产物形态 |
| `sidecars/py/main.py` | `VERSION` | Python sidecar `ping` 返回值 |
| `README.md` / `CHANGELOG.md` | 版本号 | 文档一致性 |

**不要再硬编码版本号到探针**。`tools/probes/probe_settings_logs.mjs` 从 `../../package.json` 动态读 `EXPECTED_VERSION`，并按 `formatVersion()` 规则派生 `DISPLAY_VERSION`。UI 展示层 `src/lib/version.ts::formatVersion()` 把 prerelease 缩写成 `.a/.b/.rc`，正式版原样显示。

一键核对：

```bash
grep -rn "1\.0\.0" package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json sidecars/py/main.py README.md
# 应与 package.json 的 version 完全一致（把 1.0.0 换成目标版本号）
```

## 2. 发版前检查清单（按顺序）

### 2.1 离线回归（无需窗口，必过）

```bash
python tools/check.py
```

`check.py` 串行执行并汇总：契约校验、Python 兼容、py 框架、适配层车道隔离、`py_compile`、前端单测、`cargo test --lib`、`prepare_runtime.py --check`。任一失败即非零退出。

**当前基线（1.0.3）**：`python tools/check.py` **8/8 全绿**；其中 `pnpm test` 326/326、`cargo test --lib` 117 passed / 1 ignored、`py_compat_check` 37/37、`adapter_isolation` 14/14、`contract_check` 8 类型 + 7 方法对齐、`prepare_runtime --check` 依赖齐全 + 8/8 JS 资源 SHA256 通过。

### 2.2 窗口回归（需要 debug 窗口）

```bash
corepack pnpm tauri dev            # 官方开发模式，默认开 CDP 9222
node tools/run_probes.mjs          # 默认全套，不含会切桩配置的 UI 冒烟
node tools/run_probes.mjs --with-ui
```

> 顺序约束见脚本头注释。`probe_search_ui` 最前、`probe_ui` 最后且默认跳过、`probe_sidebar` 靠后。探针自清理，不污染真实配置。外网抖动（chips=0 / 播放无画面且无报错）先看日志是否成片 SSL EOF，别当回归改代码。

### 2.3 构建安装器（官方 `tauri build`）

```bash
# 1) 先准备随包运行时（jre / python-embed / qjs-runner 二进制 / qjs 资源校验）
python tools/prepare_runtime.py
# 2) 官方构建：自动 pnpm build + cargo build + 嵌入前端 + 打包 NSIS 安装器
corepack pnpm tauri build
```

> **为什么两步**：Tauri 官方只负责「把 `dist/` 嵌入 exe + 打包安装器」，它不会替你构建 JRE / Python embeddable / qjs-runner 这些 sidecar 运行时。这一步是项目特有的，不是重新造 Tauri 的轮子——`prepare_runtime.py` 只产出 `tauri.conf.json` 里 `bundle.resources` / `bundle.externalBin` 指向的源文件，构建本身仍 100% 交给 `tauri build`。

产物：`src-tauri/target/release/bundle/nsis/Luma_1.0.3_x64-setup.exe`（NSIS 安装器）。

### 2.4 安装器外观（官方 `bundle.windows.nsis`）

安装界面全部由 Tauri 官方 `bundle.windows.nsis` 配置驱动，**没有自定义 `.nsi` 模板、没有手搓 NSIS 脚本**。当前配置：

| 字段 | 值 | 作用 |
|---|---|---|
| `installerIcon` / `uninstallerIcon` | `icons/icon.ico` | 安装器 / 卸载器 exe 图标（品牌图标，不是 NSIS 默认图标） |
| `sidebarImage` | `icons/nsis-sidebar.bmp` | 欢迎页 / 完成页左侧竖图，官方推荐 **164×314** |
| `headerImage` | `icons/nsis-header.bmp` | 各安装页顶部横图，官方推荐 **150×57** |
| `languages` | `["SimpChinese", "English"]` | 中文优先、英文兜底；Tauri 内置 `SimpChinese.nsh` |
| `displayLanguageSelector` | `false` | 直接跟随 OS 语言，不弹语言选择框 |

位图约束与维护：

- 必须是 **24-bit RGB BMP**（NSIS MUI2 的 `MUI_WELCOMEFINISHPAGE_BITMAP` / `MUI_HEADERIMAGE_BITMAP` 要求），PNG/ICO 不能用于这两个字段。
- 两张 BMP 沿用 `public/icon.svg` 的品牌几何（深墨底 `#10131A`、细圆环、`#6E8BFF→#9A8CFF` 渐变播放三角），改品牌色时需同步重生成；`.gitattributes` 已把 `src-tauri/icons/*.bmp` 标为 `binary`，避免换行规范化破坏位图。
- 改配置后必须重新 `tauri build` 才生效（安装器是构建期产物）。

> 更重度的定制（自定义页面、勾选协议、安装路径预设等）需要官方 `template` / `installerHooks` 字段，按需再评估，当前不需要。

### 2.5 产物验收

1. **嵌入校验**：`tauri build` 已把前端嵌入 exe；验收可在解压后的安装目录用 `grep -a "usePlayerEngine" Luma.exe` 确认（应有命中），或直接跑安装器看 UI 是否正常出画。
2. **安装器冒烟**：安装到任意目录 → 启动 → 导入配置 → 搜索 → 详情 → 播放出画（`videoWidth/Height > 0`）。
3. **自检**：`LUMA_SELFCHECK=1` 启动，检查日志里 `ping ok`，且子进程指向安装目录内的 `sidecars/python-embed`、`sidecars/jre`。
4. **日志**：确认 `data/logs/luma-YYYY-MM-DD.log` 生成、URL 无查询参数落盘。

### 2.6 记录与提交

- 更新 `CHANGELOG.md`（能力变更 / 已知限制 / 工程改动）。
- `git add` 只本次改动的文件；`git commit` 由开发者自己写，**不 push**。
- **tag**：本地 `git tag -a vX.Y.Z -m "release X.Y.Z"`，**tag 与 commit 都不 push，不上传任何云端资源**；需要发布到远端时由发布者手工决定。

## 3. 回滚

版本升级只改第 1 节 5 处 + 文档，代码无迁移逻辑（无旧数据兼容负担）。回滚 = 还原版本字符串并重新 `tauri build`；`data/luma.db` 不随版本变更，无需迁移脚本。

## 4. 常见失败与对策

| 现象 | 原因 | 处理 |
|---|---|---|
| `contract_check` MISMATCH | 新增字段只加了 TS 没补 schema | schema 是唯一真源，补 `contracts/tvbox.schema.json`，不要删 TS 字段 |
| 版本探针失败 | 曾把版本号硬编码进断言 | 改为动态读 `package.json`（已在 1.0.0 修复） |
| 构建时 `resource path ... doesn't exist` | `bundle.externalBin` 指向的二进制未按 `<name>-<triple>.exe` 命名 | 先跑 `prepare_runtime.py` 把 sidecar 二进制 staging 到 `src-tauri/binaries/` |
| 窗口 `ERR_CONNECTION_REFUSED` | 前端没嵌入 exe（手搓 `cargo build` 不会嵌入） | 一律用 `tauri build`，不要 `cargo build --release` 直接打包 |
| `cargo` 等待 target 锁 | dev 进程在跑 | 编译/打包前先停干净 `tauri dev` |
