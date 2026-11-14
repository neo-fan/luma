# 发布流程（RELEASING）

> 发版唯一入口。调试见 `docs/DEVELOPMENT.md`，日常维护/升级见 `docs/MAINTENANCE.md`，目录约定见 `docs/project-layout.md`。
> **交付形态固定**：解压即用的便携 zip，不做安装包；本地 commit **不 push**；不发版时只交付 debug 构建。

## 1. 版本单一来源与同步清单

`package.json` 的 `version` 是唯一来源，`vite.config.ts` 通过 `define` 注入 `__APP_VERSION__`。升级版本时**以下文件必须同步**，缺一即版本漂移：

| 文件 | 字段 | 校验 |
|---|---|---|
| `package.json` | `version` | 唯一来源 |
| `src-tauri/Cargo.toml` | `version` | `cargo` 包版本 |
| `src-tauri/Cargo.lock` | `name = "luma"` 下的 `version` | `cargo build` 会自动改，提交前确认 |
| `src-tauri/tauri.conf.json` | `version` | 安装包元数据 / `p3.py` 与 `make_portable.py` 从此处读版本 |
| `sidecars/py/main.py` | `VERSION` | Python sidecar `ping` 返回值 |
| `README.md` | 版本号、便携 zip 文件名 | 文档一致性 |
| `docs/size-report.md` | 被测包名与实测体积 | 每次发版重写 |
| `CHANGELOG.md` | 新增版本条目 | 发布记录 |

**不要再硬编码版本号到探针**。`tools/probe_settings_logs.mjs` 从 `../package.json` 动态读 `EXPECTED_VERSION`，并按 `formatVersion()` 规则派生 `DISPLAY_VERSION`。UI 展示层 `src/lib/version.ts::formatVersion()` 把 prerelease 缩写成 `.a/.b/.rc`，正式版原样显示。

一键核对：

```bash
grep -rn "1\.0\.0-alpha" package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json sidecars/py/main.py README.md docs/size-report.md
# 应为空（把 1.0.0-alpha 换成上一个版本号）
```

## 2. 发版前检查清单（按顺序）

### 2.1 离线回归（无需窗口，必过）

```bash
python tools/check.py
```

`check.py` 串行执行并汇总：契约校验、Python 兼容、py 框架、`py_compile`、`pnpm test`、`cargo test --lib`、`prepare_runtime.py --check`。任一失败即非零退出。

**当前基线（1.0.0）**：`python tools/check.py` **7/7 全绿**；其中 `pnpm test` 326/326、`cargo test --lib` 116 passed / 1 ignored、`py_compat_check` 37/37、`contract_check` 8 类型 + 7 方法对齐、`prepare_runtime --check` 依赖齐全 + 8/8 JS 资源 SHA256 通过；71 个 `tools/*.mjs` 全部 `node --check` 通过。

### 2.2 窗口回归（需要 debug 窗口）

```bash
corepack pnpm tauri dev            # 另一个终端，debug 默认开 CDP 9222
node tools/run_probes.mjs          # 默认全套，不含会切桩配置的 UI 冒烟
node tools/run_probes.mjs --with-ui
```

> 顺序约束见脚本头注释：`probe_search_ui` 最前、`probe_ui` 最后且默认跳过、`probe_sidebar` 靠后。探针会自清理，不污染真实配置。
> 外网抖动（chips=0 / 播放无画面且无报错）先看日志是否成片 SSL EOF，别当回归改代码。

### 2.3 构建与打包

```bash
corepack pnpm build                 # 前端产物 dist/（含 tsc --noEmit）
python tools/make_portable.py       # cargo build --release + 组装 release/portable/Luma/ + 打 zip
```

`make_portable.py` 产出：
- `release/portable/Luma/` —— 解压即用的目录；
- `release/Luma-<version>-portable.zip` —— 分发包。

运行时产物（JRE / python-embed / mpv / binaries）**不入库**，由 `tools/prepare_runtime.py` 重建；打包前先跑 `--check`。

### 2.4 产物验收

1. **体积**：重测 zip 与目录分项，更新 `docs/size-report.md`。目标 ≤ 45 MB（zip）；**1.0.0 实测 44.36 MB 达标**。超标时优先找运行期永不命中的冗余副本（1.0.0 就靠移除第二份 `qjs-runner.exe` 省 1.50 MB），其次 `lto` 回压 exe，最后才谈放宽目标；不要删运行时产物凑数。
2. **解压即用**：解压到全新目录，双击 `Luma.exe`；确认配置/收藏/历史写在**包内 `data/`**，不写 `%APPDATA%`。
3. **自检**：`LUMA_SELFCHECK=1` 启动，检查 `data/selfcheck.log` 里 `ping ok`，且子进程指向包内 `python-embed`。
4. **冒烟**：导入配置 → 搜索 → 详情 → 播放出画（`videoWidth/Height > 0`）。
5. **日志**：确认 `data/logs/luma-YYYY-MM-DD.log` 生成、URL 无查询参数落盘。

### 2.5 记录与提交

- 更新 `CHANGELOG.md`（能力变更 / 已知限制 / 工程改动）、`docs/size-report.md`（实测）。
- `git add` 只本次改动的文件；`git commit` 由开发者自己写，**不 push**。
- 需要 tag 时由发布者手工执行，本流程不自动打 tag、不上传任何云端资源。

## 3. 回滚

版本升级只改上表 8 处 + 文档，代码无迁移逻辑（无旧数据兼容负担）。回滚 = 还原版本字符串并重新打包；`data/luma.db` 不随版本变更，无需迁移脚本。

## 4. 常见失败与对策

| 现象 | 原因 | 处理 |
|---|---|---|
| `contract_check` MISMATCH | 新增字段只加了 TS 没补 schema | schema 是唯一真源，补 `contracts/tvbox.schema.json`，不要删 TS 字段 |
| 版本探针失败 | 曾把版本号硬编码进断言 | 改为动态读 `package.json`（已在 1.0.0 修复） |
| `cargo` 等待 target 锁 | dev 进程在跑 | 编译/打包前先停干净 dev |
| zip 超 45MB | release exe / python-embed 增大 | release profile `strip`/`lto`，或明确放宽目标并写进报告 |
| 便携版加载旧 sidecar | 路径探测命中 stale 副本 | `paths::sidecar_roots()` debug 优先源码根、release 用 resource dir |
