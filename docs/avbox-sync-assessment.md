# AVBox 上游评估与「可同步重构」方案

> 日期：2026-11-08 · 性质：方向评估，未改代码、未改云端文档
> 结论先行：**AVBox 没有 Windows 桌面端**，它是纯 Android 工程；Release 里的 `AVBox_1.3.6_win-x64.zip` 不是原生桌面构建。「直接 fork 出 Win11 原生版」不可行，但「上游代码子集 + 桌面端重写」的同步架构可行。

## 1. 上游事实核验

| 项 | 实测 |
|---|---|
| 仓库 | `XiaochangXu/AVBox`（626 stars，108 forks，今天仍有推送） |
| 语言 / 框架 | Kotlin 2.4.21 + Jetpack Compose（**Android**）+ AGP 9.5.0 |
| 模块 | `:app`、`:quickjs`、`:pyramid`、`:libs:backdrop`；**无 `desktop` / `jvm` target** |
| Android 依赖 | compileSdk 37、minSdk 24、Media3/ExoPlayer、Room、MMKV、Chaquopy Python、NDK arm64 |
| 许可证 | **AGPL-3.0**（衍生作品必须 AGPL 开源并保留版权声明） |
| 代码规模 | 496 个 Kotlin 文件（`app/src/main/java`） |
| 架构约束 | 上游 `AGENTS.md` 定义 6 条包依赖不变量；`player.core` 是内核底座；`server` 只做协议与端口；UI 走 UDF |

**Release 的 win-x64.zip 是什么**：262.5 MB，远大于 APK；工程里没有任何 desktop target 或 JVM 打包配置。合理判断是第三方用 Android 运行时封装（模拟器/兼容层）出的「Windows 可运行包」，不是 Compose Desktop 原生程序。**不能作为「参考源码重构」的桌面基线**。

## 2. 可剥离性实测（按包统计 Android 耦合）

统计口径：包内 `.kt` 文件中，含 `import android.*` 或 `import androidx.*` 的文件占比。

| 包 | 文件数 | 耦合 Android | 纯 Kotlin 比例 | 可复用判断 |
|---|---:|---:|---:|---|
| `bean` | 23 | 3 | 87% | ✅ 数据模型可直接复用 |
| `event` | 1 | 0 | 100% | ✅ 直接复用 |
| `net` | 11 | 2 | 82% | ✅ OkHttp 封装可直接复用 |
| `util` | 55 | 27 | 51% | ⚠️ 一半可复用，一半依赖 Context/IO |
| `api` | 17 | 8 | 53% | ⚠️ 配置解析可用，站点管理需改 |
| `catvod` | 31 | 16 | 48% | ⚠️ 契约层可复用，Android 桥需重写 |
| `sourcedata` | 15 | 11 | 27% | ❌ CMS/py 解析深度依赖 Android |
| `data` | 27 | 12 | 56% | ⚠️ Room/MMKV 需换桌面存储 |
| `player` | 134 | 80 | 40% | ❌ Media3 内核无法用于桌面 |
| `ui` | 142 | 124 | 13% | ❌ Compose Android 与桌面有差异，需重写 |
| `server` | 5 | 3 | 40% | ⚠️ 端口抽象可参考 |
| `subtitle` | 22 | 4 | 82% | ✅ 字幕解析可复用 |

**总量结论**：真正能低改造成本复用的只有 `bean` / `event` / `net` / `subtitle` 约 **57 个文件（11%）**；`util` / `api` / `catvod` 约 **103 个文件（21%）** 可复用但需 `expect/actual` 改造；`player` / `ui` / `sourcedata` 共 **291 个文件（59%）** 必须重写。

## 3. 三个方案对比

### 方案 A（推荐）：Compose Multiplatform Desktop + 上游子树同步

- **形态**：新建 `desktopApp`（Kotlin/JVM 21 + Compose Multiplatform Desktop），UI 用 Compose 重写为桌面交互（大屏、键盘、鼠标悬停、窗口状态），播放器换 **VLCJ（libvlc）** 或 **mpv IPC**。
- **复用**：用 `git subtree` 把 `bean` / `event` / `net` / `subtitle` 引入 `upstream/avbox/`（只读）；`util` / `api` / `catvod` 以 patch 形式适配，不改上游目录。
- **同步机制**：
  ```bash
  git remote add upstream https://github.com/XiaochangXu/AVBox.git
  git fetch upstream
  git subtree pull --prefix upstream/avbox upstream main --squash
  ```
  冲突只允许在 `desktopApp/` 与 `upstream/patches/` 解决；`tools/sync-avbox.sh` 输出「上游变更 → 影响到的本地文件」报告。
- **工期**：10~14 周（1 人；UI 6 周、播放器 3 周、同步与适配 3 周）。
- **优点**：同语言同 UI 框架，复用度最高；代码级同步可行；社区规则/字段变化能跟。
- **风险**：AGPL 传染（本仓库也必须 AGPL）；上游 API 不稳定；Android 依赖点需长期维护 patch。

### 方案 B（保守）：Tauri 桌面端继续，AVBox 仅作行为参考

- **形态**：保留已建的 Tauri v2 骨架（`pnpm build` 已过），按本地规格书 v1.1 实现。
- **复用**：0 行代码；用 AVBox 校验字段语义、路由规则、UI 交互、错误处理。
- **同步机制**：`tools/diff-avbox.sh` 定期 diff 上游 `sourcedata`/`api`/`skill/*.md`，输出变更摘要，人工移植到 Rust/Python 适配层。
- **工期**：按规格书 9~10 周（T-01 已完成大半）。
- **优点**：已有骨架与完整规格书；Rust/Python 边界清晰；无 AGPL 传染（不复制代码）。
- **缺点**：**不是代码级同步**，上游更新只能人工跟进；两套技术栈的领域知识要各维护一份。

### 方案 C（不推荐）：直接 fork Android 工程加 desktop target

- 全量 fork，给 `:app` 加 `jvm("desktop")` target，用 `expect/actual` 隔离 Android API。
- **工期 16~20 周**，`player`（Media3）、`ui`（142 文件）、`sourcedata` 的 Context 依赖会持续炸；维护成本高于收益。

## 4. 推荐与决策点

**推荐方案 A**，理由：
1. 用户要「参考 AVBox 重构 + 跟随上游更新」，只有同语言（Kotlin）+ 同 UI 框架（Compose）才能做到代码级同步；
2. 11% 的纯 Kotlin 层（bean/event/net/subtitle）+ 21% 可适配层（util/api/catvod）能显著降低重写量；
3. VLCJ/mpv 在 Windows 上的播放能力优于 Tauri 的 WebView 播放，符合「Win11 桌面端」定位。

**代价必须提前说清**：
- 放弃已建的 Tauri 骨架（T-01），改 Kotlin 技术栈；
- 本仓库必须改为 **AGPL-3.0** 开源（复用 AVBox 代码的强制要求）；
- 工期 10~14 周，比规格书的 9~10 周更长，且需要 Android/Compose 经验。

**如果不想放弃 Tauri**，选方案 B，但要接受「同步靠人工」——上游改一个 CMS 字段，我们要手工移植到 Python 适配层。

## 5. 许可证与合规

- AVBox 是 AGPL-3.0：**复制/修改其代码 → 本仓库必须以 AGPL-3.0 发布，保留版权声明与出处链接**，网络服务形态也要提供源码。
- 若只「参考行为、不复制代码」（方案 B），不受 AGPL 传染，但需在 README 声明参考来源。
- 无论哪个方案，都保持「空壳、不内置源、不提供内容」的边界。

## 6. 下一步（待确认方向后执行）

- 方案 A：初始化 `desktopApp`（Compose Desktop）→ 引入 `upstream/avbox` 子树 → 打通 bean/net 编译 → 用 VLCJ 播一个 127.0.0.1 的 stub 流 → 再接 UI。
- 方案 B：继续 T-02（tauri.conf.json Windows/WebView2）→ T-03 capabilities → T-04 契约 → T-05 配置解析。
- 无论哪个方案，先补 `tools/sync-avbox.sh` 与上游变更监测，避免「fork 后失联」。
