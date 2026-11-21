# 发布流程（RELEASING）

> 发版唯一入口。调试见 `docs/DEVELOPMENT.md`，日常维护/升级见 `docs/MAINTENANCE.md`，目录约定见 `docs/project-layout.md`，架构见 `docs/ARCHITECTURE.md`。
> **构建与打包全部走 Tauri 官方工具链，不手搓**：发版用官方 `tauri build` 产出 NSIS 安装器；CI 侧由 `.github/workflows/release.yml` 承担同样的链路并挂到 GitHub Release。

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

**升版本用一条命令收口**（`tools/release_prep.py`）：依次做预检 → 改 `package.json` / `Cargo.toml` / `Cargo.lock` 三处 → 把 CHANGELOG 的 Unreleased 提升为版本段 → 提交 `chore(release): 版本升至 X.Y.Z` → 打 annotated tag。任一步失败则整体不落盘，**版本号与 tag 在同一次操作里产生**，不存在「tag 已推、CHANGELOG 还写未发布」的窗口。

```bash
python tools/release_prep.py 2.1.0 --dry-run   # 预览 diff 与将要改动的文件
python tools/release_prep.py 2.1.0             # 落盘 + commit + tag（不 push）
```

发布前先往 `## [Unreleased]` 写条目：脚本只搬运、不生成内容（中文条目的根因与取舍是人写的）。`CHANGELOG` 已有该版本段时脚本原样沿用并校验正文非空——`latest.json` 的 `notes` 正是从这一段截取的。

也可以手工改：`package.json` + `src-tauri/Cargo.toml` 两处，`Cargo.lock` 随之更新，改完一键核对（也内建在 `tools/check.py` 里）：

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

### 1.2 发布通道与身份

通道身份由 `package.json` 的 `appId` + 后缀派生，三份配置作为可审计副本入库（`tauri.conf.json` / `tauri.beta.conf.json` / `tauri.dev.conf.json`，`tools/version_check.py` 守护一致），数据目录、反代端口、安装身份互不重叠：

| 通道 | identifier | productName | 数据目录 | 反代 | 出包 |
|---|---|---|---|---|---|
| stable | `app.luma` | `Luma` | `%APPDATA%\app.luma` | 9978 | `pnpm build:app` |
| beta | `app.luma.beta` | `Luma Beta` | `%APPDATA%\app.luma.beta` | 9977 | `pnpm build:beta`（按需） |
| dev | `app.luma.dev` | 不出包 | `%APPDATA%\app.luma.dev` | 9979 | `pnpm dev:app` |

- `dev` 是日常调试，不产安装包；`beta` 只在需要预发布时启用，平时不构建。身份与版本以 `package.json` 为准（`appId` / `productName` / `version`）；三份 overlay 的 identifier 必须等于 `appId + 后缀`，改一处就要同步改三处并由 `version_check.py` 验过。
- 版本号仍只有一个来源（`package.json`）。预发布用 semver：`2.0.0-beta.1`、`2.0.0-beta.2`。**同一版本号不要重复发布**——NSIS 允许同版本覆盖安装，产物与已安装版本将无法区分。
- identifier 是系统身份：改它等于换应用（WebView2 profile、卸载注册表项、数据目录全变）。发版后只在引入新的长期通道时才动。
- 2.0.0 起数据目录就是 identifier 本身；1.x 的 `%APPDATA%\Luma` 不再读取（不兼容旧数据）。

## 2. 发版前检查清单（按顺序）

### 2.1 离线回归（无需窗口，必过）

```bash
python tools/check.py
```

`check.py` 串行执行并汇总（12 项）：契约校验、版本一致性、发布收口、Python 兼容、py 框架、适配层健壮性、`py_compile`、`prepare_runtime.py --check`、qjs-runner 单测、qjs 引擎帧校验、前端单测、`cargo test --lib`。任一失败即非零退出。

**当前基线（2.0.3 开发中）**：`python tools/check.py` **12/12 全绿**；其中 `pnpm test` 724（89 个文件）、`cargo test --lib` 279 passed / 2 ignored、`qjs-runner cargo test` 7 passed（GBK 编解码纯函数）、`py_compat_check` 19/19、`adapter_isolation` 15/15、`contract_check` 8 类型 + 8 方法对齐、`version_check` 版本全链一致（`tauri.conf.json` 指回 `package.json`、sidecar ping 回报注入的 2.0.3）、`release_prep_check` 43 断言（semver 比较 / 三处载体改写 / CHANGELOG 提升与阻断）、`prepare_runtime --check` 8 个 JS 依赖齐全 + 9 个资源字节数/SHA256 通过、`qjs engine` 13/13（GBK 编解码 + ds 真实现 + STUBS 兜底）。`tsc --noEmit` 零错误（不在 `check.py` 内，单独跑）。

### 2.2 窗口回归（需要 dev 窗口）

```bash
corepack pnpm dev:app              # 官方开发模式，默认开 CDP 9222
node tools/run_probes.mjs          # 默认全套，不含会切桩配置的 UI 冒烟
node tools/run_probes.mjs --with-ui
```

> 顺序约束见脚本头注释。`probe_search_ui` 最前、`probe_ui` 最后且默认跳过、`probe_sidebar` 靠后。探针自清理，不污染真实配置。外网抖动（chips=0 / 播放无画面且无报错）先看日志是否成片 SSL EOF，别当回归改代码。

### 2.3 构建安装器（官方 `tauri build`）

```bash
# 1) 先准备随包运行时（python-embed / qjs-runner 二进制 / qjs 资源校验；JVM 运行时已移除）
python tools/prepare_runtime.py
# 2) 官方构建：自动 pnpm build + cargo build + 嵌入前端 + 打包 NSIS 安装器
corepack pnpm build:app        # stable（app.luma）
corepack pnpm build:beta       # beta（app.luma.beta），只在预发布时用
```

> **为什么两步**：Tauri 官方只负责「把 `dist/` 嵌入 exe + 打包安装器」，它不会替你构建 Python embeddable / qjs-runner 这些 sidecar 运行时。这一步是项目特有的，不是重新造 Tauri 的轮子——`prepare_runtime.py` 只产出 `tauri.conf.json` 里 `bundle.resources` / `bundle.externalBin` 指向的源文件，构建本身仍 100% 交给 `tauri build`。

产物：`src-tauri/target/release/bundle/nsis/Luma_<version>_x64-setup.exe`（NSIS 安装器，版本号来自 `package.json`）。

同目录还会生成 `latest.json`：自动升级的版本清单（`version` / `tag` / `notes` / `asset{name,size,sha256}`），与安装包一起挂到 Release。客户端只读这个静态文件——加速前缀不支持 `api.github.com`，所以版本信息不能靠 API。`notes` 从 `CHANGELOG.md` 对应版本段落截取。客户端点「安装并退出」会先记下目标版本；`/S` 静默安装结束前应用已退出，结果在**下次启动**按当前版本核对后提示「已更新到 X」或「更新未完成，可重试」。

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
4. **日志**：确认 `data/logs/app|luma.<本地日期>.log`、`ui/ui.<本地日期>.log`、`spider/spider.<本地日期>.log` 三个通道都有生成（行首时间戳同为系统时区），且 URL 无查询参数落盘。

### 2.6 记录与提交

- 更新 `CHANGELOG.md`（能力变更 / 已知限制 / 工程改动），条目写在 `## [Unreleased]` 下。
- 推荐直接跑 `python tools/release_prep.py X.Y.Z`：一次完成「改三处版本 → 提升 CHANGELOG → 提交 → 打 tag」，要求工作区干净，**不 push**；只想做其中一段时用 `--no-commit` / `--no-tag`。
- 手工等价步骤：`git add` 只本次改动的文件；`git commit` 用 `chore(release): 版本升至 X.Y.Z`；本地 `git tag -a vX.Y.Z -m "release X.Y.Z"`。
- **推送**：`git push && git push origin vX.Y.Z`。推 tag 会触发 `.github/workflows/release.yml`，由 CI 构建 NSIS 安装器并挂到同名 GitHub Release（也可在 Actions 手动 `workflow_dispatch`，留空 tag 则按 `package.json` 版本补发）。CI 会拒绝与 `package.json` 版本不一致的 tag。

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
