# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循语义化版本。**唯一版本来源**是 `package.json`，同步清单与发布流程见 `docs/RELEASING.md`。

---

## [1.0.0] — 2026-11-14

首个正式版。交付形态为**解压即用的便携 zip**（不做安装包）。

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
- **体积达标**：`release/Luma-1.0.0-portable.zip` **44.36 MB**（目标 ≤ 45 MB）。做法是移除 `qjs-runner.exe` 的运行期永不命中的第二份副本（-1.50 MB），而非删功能或放宽目标；`[profile.release] strip = "symbols"` 实测无额外收益，作为常规优化保留。详见 `docs/size-report.md`。
- **构建产物**：`cargo build --release` 5m38s；zip 1001 条目，46,513,892 字节，SHA256 `2f7272f905fb88c708a1e19a0dfce6fb3d4e687d2888db3c197f9e0d6c88a07b`。本次仅做静态验收，GUI 启动冒烟与 `LUMA_SELFCHECK` 按 `docs/RELEASING.md` 留待本地确认。
- **可追溯性说明**：构建时工作区存在 2 个**非本次产生的既有未提交改动**（`src/pages/SearchPage.tsx`、`src/styles.css`），release 包包含它们，但本次 commit 不含。后续若要让产物与 HEAD 严格一致，需先决定这两个改动的归属再重新打包。

### 明确不支持 / 已知限制

- **jar 源（社区配置）不支持**：Android dex jar 依赖 ART / OkHttp / gson / `android.util.*`，Win x64 无法加载；导入时 `runtime=jvm` 站点自动屏蔽。JVM 通道仅为 `p2.py` 回归与自编纯 class 模板 jar 保留。
- `parses[]` 只实现 type 0 / 1 / 4；type 2/3 依赖 jar 反射，直接返回「不支持」。
- JS 源尚未覆盖 drpy2 `initEnv` 完整 polyfill 与 FongMi class-based `Spider` 规范。
- T-31（`tvbox://` 协议关联、JumpList、全屏勿扰）未实现，规格要求逐项手工验收。
- mpv 不随 zip 分发（单文件约 117MB），需要时自行放入 `sidecars/mpv/` 或用 `--with-mpv` 重新打包。
- 公开源失效频繁，属正常现象；自动换源与源级原因提示是必需能力。

---

## [1.0.0-alpha] — 2026-11-11 ~ 2026-11-14

试运行版本。完成 P0 ~ P3（T-31 除外）：Tauri v2 + React 骨架、四类源适配层、SQLite、ArtPlayer、便携打包、CDP 探针回归体系。真实配置「导入 → 全站搜索 → 详情 → 播放」出画（101 站点 / 17 直播源）。逐轮过程见 `docs/log/2026-11.md` 与 `docs/tasks/`。
