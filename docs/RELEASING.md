# 发布流程（RELEASING）

> 发版唯一入口。调试见 `docs/DEVELOPMENT.md`，日常维护/升级见 `docs/MAINTENANCE.md`，目录约定见 `docs/project-layout.md`，架构见 `docs/ARCHITECTURE.md`。
> **构建与打包全部走 Tauri 官方工具链，不手搓**：本地 commit **不 push**；发版用官方 `tauri build` 产出 NSIS 安装器。

## 1. 版本单一来源与同步清单

`package.json` 的 `version` 是唯一来源，其余位置要么引用它、要么被工具链断言：

- **前端**：`vite.config.ts` 通过 `define` 注入 `__APP_VERSION__`。
- **安装器**：`src-tauri/tauri.conf.json` 的 `version` 写 `"../package.json"`（Tauri 官方支持版本字段指向 `package.json` 路径），不再抄数字。
- **Cargo 包版本**：`src-tauri/Cargo.toml` 的 `version` 只能写字面量，由 `src-tauri/build.rs` 在编译期断言与 `package.json` 一致——不一致直接编译失败，不会装出版本号对不上的包。
- **Python 适配层**：`sidecars/py/main.py` 不再写死版本，优先读宿主注入的 `LUMA_VERSION`（`infra/bridge.rs`，值 = cargo 包版本），离线直跑（测试 / 审计工具）时回退读 `package.json`。

| 位置 | 口径 | 由谁保证 |
|---|---|---|
| `package.json` `version` | 唯一来源 | **手工改** |
| `src-tauri/Cargo.toml` `version` | cargo 包版本 | **手工改**，`build.rs` 断言等于 `package.json` |
| `src-tauri/Cargo.lock` | `luma` 包版本 | `cargo` 自动同步（提交前确认） |
| `src-tauri/tauri.conf.json` `version` | 安装器元数据 | 写 `"../package.json"`，直接引用 |
| `sidecars/py/main.py` `VERSION` | 适配层 `ping` 返回值 | 宿主注入 `LUMA_VERSION`；离线回退 `package.json` |
| `AGENTS.md`「版本」行 | 文档快照 | `tools/version_check.py` 校验 |
| `CHANGELOG.md` / `README.md` | 发版说明 | 发版时人工 |

**升版本只需改两处**：`package.json` + `src-tauri/Cargo.toml`；`Cargo.lock` 随 cargo 自动，安装器元数据跟着路径引用走。改完一键核对（也内建在 `tools/check.py` 里）：

```bash
python tools/version_check.py
```

> 不要再硬编码版本号到探针或断言。`tools/probes/probe_settings_logs.mjs` 从 `../../package.json` 动态读 `EXPECTED_VERSION`，并按 `formatVersion()` 规则派生 `DISPLAY_VERSION`。UI 展示层 `src/lib/version.ts::formatVersion()` 把 prerelease 缩写成 `.a/.b/.rc`，正式版原样显示。

### 1.1 界面上的 build 号

侧栏与设置页显示的是**同一个 build 号 = 宿主进程本次的启动时刻**（`yyyyMMddHHmmss`，本地时区），不是构建时刻：

- 后端在 `run()` 最开始 `started::mark()`（`src-tauri/src/infra/started.rs`），从 `Diagnostics::started_at` 输出；
- 前端 `src/lib/appInfo.ts` 取一次诊断快照后缓存，侧栏和设置页共用（浏览器里没有宿主时回退前端构建时刻）。

`dev` 下前端（Vite）和后端（cargo）的构建时刻必然不同，所以早期「前端构建 / 后端构建」两行永远对不上；现在只留一行「构建号」。`buildHash` / `buildTime` 仍在诊断数据里供排障，界面不展示。

窗口验收：`node tools/probes/probe_build_stamp.mjs`（需 debug 窗口 + CDP 9222），会断言侧栏与设置页的 build 号相同且为 14 位时间戳。

## 2. 发版前检查清单（按顺序）

### 2.1 离线回归（无需窗口，必过）

```bash
python tools/check.py
```

`check.py` 串行执行并汇总（11 项）：契约校验、版本一致性、Python 兼容、py 框架、适配层健壮性、`py_compile`、`prepare_runtime.py --check`、qjs-runner 单测、qjs 引擎帧校验、前端单测、`cargo test --lib`。任一失败即非零退出。

**当前基线（2.0.0 开发中）**：`python tools/check.py` **11/11 全绿**；其中 `pnpm test` 692（81 个文件）、`cargo test --lib` 265 passed / 2 ignored、`qjs-runner cargo test` 7 passed（GBK 编解码纯函数）、`py_compat_check` 19/19、`adapter_isolation` 15/15、`contract_check` 8 类型 + 8 方法对齐、`version_check` 版本全链一致（`tauri.conf.json` 指回 `package.json`、sidecar ping 回报注入的 2.0.0）、`prepare_runtime --check` 8 个 JS 依赖齐全 + 9 个资源字节数/SHA256 通过、`qjs engine` 13/13（GBK 编解码 + ds 真实现 + STUBS 兜底）。`tsc --noEmit` 零错误（不在 `check.py` 内，单独跑）。

### 2.2 窗口回归（需要 debug 窗口）

```bash
corepack pnpm tauri dev            # 官方开发模式，默认开 CDP 9222
node tools/run_probes.mjs          # 默认全套，不含会切桩配置的 UI 冒烟
node tools/run_probes.mjs --with-ui
```

> 顺序约束见脚本头注释。`probe_search_ui` 最前、`probe_ui` 最后且默认跳过、`probe_sidebar` 靠后。探针自清理，不污染真实配置。外网抖动（chips=0 / 播放无画面且无报错）先看日志是否成片 SSL EOF，别当回归改代码。

### 2.3 构建安装器（官方 `tauri build`）

```bash
# 1) 先准备随包运行时（python-embed / qjs-runner 二进制 / qjs 资源校验；JVM 运行时已移除）
python tools/prepare_runtime.py
# 2) 官方构建：自动 pnpm build + cargo build + 嵌入前端 + 打包 NSIS 安装器
corepack pnpm tauri build
```

> **为什么两步**：Tauri 官方只负责「把 `dist/` 嵌入 exe + 打包安装器」，它不会替你构建 Python embeddable / qjs-runner 这些 sidecar 运行时。这一步是项目特有的，不是重新造 Tauri 的轮子——`prepare_runtime.py` 只产出 `tauri.conf.json` 里 `bundle.resources` / `bundle.externalBin` 指向的源文件，构建本身仍 100% 交给 `tauri build`。

产物：`src-tauri/target/release/bundle/nsis/Luma_<version>_x64-setup.exe`（NSIS 安装器，版本号来自 `package.json`）。

### 2.4 安装器外观（官方 `bundle.windows.nsis`）

安装界面由 Tauri 官方 `bundle.windows.nsis` 配置驱动。**没有手写 NSIS 逻辑**：1.1.0 起为了做「一键安装」把官方模板 vendor 了一份（`src-tauri/nsis/installer.nsi`，取自 `@tauri-cli` v2.12.4），只删掉「欢迎」和「选择安装目录」两页，其余页面、函数、卸载逻辑都是官方原文。当前配置：

| 字段 | 值 | 作用 |
|---|---|---|
| `installMode` | `currentUser` | 装到 `%LOCALAPPDATA%\Luma`，不需要管理员；升级沿用上次目录 |
| `template` | `nsis/installer.nsi` | vendor 的官方模板（只删 Welcome / Directory 两页） |
| `compression` | `lzma` | 安装包压缩（构建期慢一点、体积更小） |
| `installerIcon` / `uninstallerIcon` | `icons/icon.ico` | 安装器 / 卸载器 exe 图标（品牌图标，不是 NSIS 默认图标） |
| `sidebarImage` | `icons/nsis-sidebar.bmp` | 完成页左侧竖图，官方推荐 **164×314** |
| `headerImage` | `icons/nsis-header.bmp` | 各安装页顶部横图，官方推荐 **150×57** |
| `languages` | `["SimpChinese"]` | 只出简体中文，不跟随英文 |
| `displayLanguageSelector` | `false` | 不弹语言选择框 |
| `webviewInstallMode`（`bundle.windows`） | `downloadBootstrapper` + `silent` | WebView2 缺失时在线引导装运行时，安装包不背离线包 |

模板升级流程：换 Tauri CLI 时从官方仓库重新取 `crates/tauri-cli/templates/installer.nsi`，覆盖 `src-tauri/nsis/installer.nsi`，再照开头的两处删除各做一次（模板文件头有说明），不要顺手改其它逻辑。

位图约束与维护：

- 必须是 **24-bit RGB BMP**（NSIS MUI2 的 `MUI_WELCOMEFINISHPAGE_BITMAP` / `MUI_HEADERIMAGE_BITMAP` 要求），PNG/ICO 不能用于这两个字段。
- 两张 BMP 沿用 `public/icon.svg` 的品牌几何（深墨底 `#10131A`、细圆环、`#6E8BFF→#9A8CFF` 渐变播放三角），改品牌色时需同步重生成；`.gitattributes` 已把 `src-tauri/icons/*.bmp` 标为 `binary`，避免换行规范化破坏位图。
- 改配置后必须重新 `tauri build` 才生效（安装器是构建期产物）。

> 再重度的定制（勾选协议、安装路径预设、自定义页面）优先用官方 `template` / `installerHooks` 字段；仍不建议在模板里写自己的 NSIS 函数。

### 2.5 产物验收

1. **嵌入校验**：`tauri build` 已把前端嵌入 exe；验收可在解压后的安装目录用 `grep -a "usePlayerEngine" Luma.exe` 确认（应有命中），或直接跑安装器看 UI 是否正常出画。
2. **安装器冒烟**：安装到任意目录 → 启动 → 导入配置 → 搜索 → 详情 → 播放出画（`videoWidth/Height > 0`）。
3. **自检**：`LUMA_SELFCHECK=1` 启动，检查日志里 `ping ok`，且子进程指向安装目录内的 `sidecars/python-embed`。
4. **日志**：确认 `data/logs/app|luma.<UTC 日期>.log`、`ui/ui.<UTC 日期>.log`、`spider/spider.<UTC 日期>.log` 三个通道都有生成，且 URL 无查询参数落盘。

### 2.6 记录与提交

- 更新 `CHANGELOG.md`（能力变更 / 已知限制 / 工程改动）。
- `git add` 只本次改动的文件；`git commit` 由开发者自己写，**不 push**。
- **tag**：本地 `git tag -a vX.Y.Z -m "release X.Y.Z"`，**tag 与 commit 都不 push，不上传任何云端资源**；需要发布到远端时由发布者手工决定。

## 3. 回滚

版本升级只改 `package.json` + `src-tauri/Cargo.toml` 两处（其余引用/断言自动跟随），代码无迁移逻辑（无旧数据兼容负担）。回滚 = 还原版本字符串并重新 `tauri build`；`data/luma.db` 不随版本变更，无需迁移脚本。

## 4. 常见失败与对策

| 现象 | 原因 | 处理 |
|---|---|---|
| `contract_check` MISMATCH | 新增字段只加了 TS 没补 schema | schema 是唯一真源，补 `contracts/luma.schema.json`，不要删 TS 字段 |
| 版本探针失败 | 曾把版本号硬编码进断言 | 改为动态读 `package.json`（已在 1.0.0 修复） |
| 构建时 `resource path ... doesn't exist` | `bundle.externalBin` 指向的二进制未按 `<name>-<triple>.exe` 命名 | 先跑 `prepare_runtime.py` 把 sidecar 二进制 staging 到 `src-tauri/binaries/` |
| 窗口 `ERR_CONNECTION_REFUSED` | 前端没嵌入 exe（手搓 `cargo build` 不会嵌入） | 一律用 `tauri build`，不要 `cargo build --release` 直接打包 |
| `cargo` 等待 target 锁 | dev 进程在跑 | 编译/打包前先停干净 `tauri dev` |
