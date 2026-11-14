# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循语义化版本。**唯一版本来源**是 `package.json`，同步清单与发布流程见 `docs/RELEASING.md`。

---

## [1.0.1] — 2026-11-14

补丁版。修复正式版发布当日发现的一个 GUI 体验缺陷。

### 修复

- **拉起 sidecar 时弹出控制台窗口**：`luma.exe`（GUI 子系统）此前以默认标志启动 `qjs-runner.exe` / `python` / `java` 等控制台子系统 sidecar，Windows 会为子进程分配一个新控制台窗口（黑框）。统一在 `infra/process.rs::Guarded::spawn` 注入 Windows `CREATE_NO_WINDOW (0x08000000)`，并同步覆盖 `mpv.rs` 直接拉起 `mpv.exe` 的点位；一处修复覆盖全部 sidecar 出入口。安装版启动不再出现任何命令行窗口。

### 工程

- 版本号在 `package.json` / `Cargo.toml` / `Cargo.lock`(luma) / `tauri.conf.json` / `sidecars/py/main.py` 五处同步至 `1.0.1`，保持单来源 `package.json` 不变。
- 构建产物：官方 `tauri build` 产出 `src-tauri/target/release/bundle/nsis/Luma_1.0.1_x64-setup.exe`（**40.48 MiB**；`luma.exe` 内含 `1.0.1` / `dev.luma.desktop` 与应用 chunk `usePlayerEngine`）。体积口径见 `docs/size-report.md`。

---

## [1.0.0] — 2026-11-14

首个正式版。交付形态为 **NSIS 安装器**（官方 `tauri build` 打包，双击安装；不再出便携 zip）。

### 能力范围

- **配置**：导入 URL / 本地文件 / 文本、多配置保存与切换、自定义命名、订阅定时刷新、GitHub 资源加速（3 个内置前缀 + 直连，可测速切换）。导入与运行双快照隔离，`imported` 永不被策略改写。
- **点播**：CMS 采集、Python `base.spider`、JS（drpy2 / ESM，`qjs-runner`）三类源；全站聚合搜索逐站流式上屏且可打断（改词重搜不串结果）；失败源按原因分组并可单站重试；详情页线路/选集、手动换源、跨站自动换源。
- **播放**：ArtPlayer + hls.js / mpegts.js（FLV）；本地反代 `:9978` 重写 m3u8 相对分片、透传 UA/Referer/Cookie、封面 `/image`；第 4 级隐藏 WebView2 嗅探；解码失败转 mpv；播放偏好记忆、自动下一集、历史进度续播。
- **直播**：m3u/m3u8 解析与代理重写、多线路切换、XMLTV EPG 与台标。
- **数据**：SQLite 单库（配置快照 / active / 收藏 / 历史），便携模式数据随 `data/` 目录移动。
- **诊断**：结构化日志（7 天轮转、URL 脱敏）、设置页复制诊断信息 / 打开日志目录 / 导出反馈文件、`LUMA_SELFCHECK=1` 启动自检。

### 工程

- **随包运行时优先**：`sidecars/jre`、`sidecars/python-embed` 由 `sidecar_roots()` 统一探测，dev 与交付同源，**用户无需安装 JDK 17**。JDK 17 仅在重建 JRE / 编译 `runner.jar` 时需要（构建期）。
- **契约**：`contracts/tvbox.schema.json` 补齐 `Site.searchableDeclared`、`SpiderRequest.stream` / `streamId`，schema 与 TS 的 8 个类型、7 个 SpiderMethod 全对齐。
- **回归**：`tools/check.py` 一键离线检查；`tools/run_probes.mjs` 窗口探针；版本探针改为从 `package.json` 动态读取，升版本不再假失败。
- **文档**：新增 `CHANGELOG.md`、`docs/ARCHITECTURE.md`（架构 + ADR）、`docs/DEVELOPMENT.md`（调试）、`docs/MAINTENANCE.md`（维护/升级）、`docs/RELEASING.md`（发布）；`docs/project-layout.md` 目录树同步。历史资产（`SPEC_REVIEW.md`、`DESIGN-SPEC.md`、`docs/ui-preview.html`、`docs/site-compat-report.md`）已标注为归档快照。
- **体积达标**：官方 `tauri build` 产出的 NSIS 安装器 `Luma_1.0.0_x64-setup.exe` **40.38 MiB**（约 42.3 MB 磁盘）。做法是移除 `qjs-runner.exe` 的运行期永不命中的第二份副本（-1.50 MB），而非删功能或放宽目标；`[profile.release] strip = "symbols"` 实测无额外收益，作为常规优化保留。详见 `docs/size-report.md`。
- **构建产物**：官方 `tauri build` 产出 `src-tauri/target/release/bundle/nsis/Luma_1.0.0_x64-setup.exe`（40.38 MiB）。前端由 Tauri 在构建期嵌入 exe，不再单独产出 zip。本次完成**无窗口静态验收**（安装器内 `luma.exe` 含 `1.0.0` 与 `dev.luma.desktop`、不含 `1.0.0-alpha`；嵌入的应用 JS chunk `usePlayerEngine` 可命中），GUI 启动冒烟与 `LUMA_SELFCHECK` 按计划本地确认。
- **可追溯性**：构建时工作区存在的 2 个既有改动（`src/pages/SearchPage.tsx`、`src/styles.css` —— 搜索框内嵌清除按钮，含清空结果/复位状态/作废在途代次）已在发版整理阶段单独提交。release 包、`v1.0.0` tag 与 HEAD 内容一致，无需重新打包。

### 明确不支持 / 已知限制

- **jar 源（社区配置）不支持**：Android dex jar 依赖 ART / OkHttp / gson / `android.util.*`，Win x64 无法加载；导入时 `runtime=jvm` 站点自动屏蔽。JVM 通道仅为 `p2.py` 回归与自编纯 class 模板 jar 保留。
- `parses[]` 只实现 type 0 / 1 / 4；type 2/3 依赖 jar 反射，直接返回「不支持」。
- JS 源尚未覆盖 drpy2 `initEnv` 完整 polyfill 与 FongMi class-based `Spider` 规范。
- T-31（`tvbox://` 协议关联、JumpList、全屏勿扰）未实现，规格要求逐项手工验收。
- mpv 不随安装包分发（单文件约 117MB），需要时自行放入安装目录的 `sidecars/mpv/`。
- 公开源失效频繁，属正常现象；自动换源与源级原因提示是必需能力。

---

## [1.0.0-alpha] — 2026-11-11 ~ 2026-11-14

试运行版本。完成 P0 ~ P3（T-31 除外）：Tauri v2 + React 骨架、四类源适配层、SQLite、ArtPlayer、便携打包、CDP 探针回归体系。真实配置「导入 → 全站搜索 → 详情 → 播放」出画（101 站点 / 17 直播源）。逐轮过程见 `docs/log/2026-11.md` 与 `docs/tasks/`。
