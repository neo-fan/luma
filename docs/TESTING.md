# 测试与回归约定

> 目标：新增一个用例时不用问「放哪」。四层各管一段，命令与目录一一对应。
> 目录归口见 `docs/project-layout.md` §4；发版验收清单在 `docs/RELEASING.md`。

## 1. 四层模型

| 层 | 放哪 | 入口 | 什么时候跑 |
|---|---|---|---|
| 单测（前端） | 被测模块同目录 `*.test.ts` | `corepack pnpm test` | 每次改前端 |
| 单测（Rust） | 同文件 `#[cfg(test)] mod tests` | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 每次改 Rust |
| 离线检查 | `tests/offline/` | `python tools/check.py` | **每次改动的最低门槛** |
| 阶段验收 | `tests/acceptance/p0.py~p3.py` | 单独执行（可带 `--offline`） | 改 sidecar / 打包前 |
| 窗口探针 | `tools/{probes,verify,diag,audit}/` | `node tools/run_probes.mjs` | 改 UI / 播放 / 配置链路后 |

一句话边界：**能离线判定对错的进 `tests/`，必须靠真实窗口才能取证的进 `tools/`。**

## 2. 目录约定

```text
src/lib/*.test.ts          # 前端单测：与被测模块同目录，import "./模块名"
src/pages/*.test.tsx
src/stores/*.test.ts
src-tauri/src/**/*.rs      # Rust 单测内联在同文件 #[cfg(test)] mod tests
src-tauri/tests/           # 目前为空（没有跨 crate 集成测试就不建）

tests/
  stub_server.py           # 共享桩服务（离线检查与阶段验收共用）
  fixtures/                # 测试输入：configs / spiders / media / manual
  frontend/                # 跨文件约定测试（readFileSync 读源码文本，断言"哪些文件里必须出现什么"）
  offline/                 # 离线确定性检查，全部进 tools/check.py
    contract_check.py      #   schema ↔ TS ↔ Rust 字段对齐
    capabilities_check.py  #   Tauri 权限闭集
    py_compat_check.py     #   TVBox py 脚本通用兼容 / 子进程信封
    py_base_spider_check.py#   py 框架与 base.spider 原生行为对齐
    adapter_isolation.py   #   适配层协议：单车道 / 坏帧回帧 / 编码 / 慢调用日志
    config_compat.py       #   脚本执行侧兼容（BOM 源码、base.spider、html().xpath()）
  acceptance/              # spec §11 阶段验收，累积断言，未交付能力标 N/A
    p0.py p1.py p3.py      # p2.py（jar/JVM 回归）已随 JVM 运行时移除

tools/
  probes/                  # 窗口回归探针（每个文件自己断言，失败 exit 1）
    lib/cdp.mjs            #   新探针共用的最小 CDP 客户端（连接/求值/真实点击/截图）
  verify/  diag/  audit/   # 一次性验收 / 证据打印 / 静态走查（diag 不断言）
```

窗口探针的两种写法：早期 49 个探针各自内联一份 `Cdp` 类（自包含、复制粘贴）；
**新探针一律 `import { connect, finish } from "./lib/cdp.mjs"`**，断言留在探针里。

## 3. 判断该放哪

- 纯函数 / 组件行为、不碰网络与真实窗口 → **单测**，放在模块旁边。
- 断言「仓库里某几个文件必须保持某种写法」（比如控件必须来自 lucide、页面必须保留某个 DOM 结构）→ `tests/frontend/`，它读的是源码文本，不属于任何单模块。
- 起进程、跑 stub server、验证三端字段一致、验证适配层协议 → `tests/offline/`，并接进 `tools/check.py`。
- 按规格书 12.2 逐阶段验收（会跑 stub、可能要求窗口）→ `tests/acceptance/pN.py`。
- 需要 CDP 9222 才能取证（DOM 尺寸、截图、真实点击）→ `tools/` 下的探针。

## 4. 硬约束

1. **离线检查必须真的离线**：不访问公网，fixture 只指向 `127.0.0.1`。
2. **新增离线检查要同时改两处**：`tools/check.py` 的 `checks()` 与 `docs/MAINTENANCE.md` §2 的覆盖清单；`--ci` 子集只放「干净机器能跑」的项。
3. **阶段验收不进 CI**：它依赖运行中的应用与 stub，留在发版手工清单。
4. **探针会切后端 active 配置的，cleanup 必须 `location.reload()`**（见 `AGENTS.md` 工程铁律 7）。
5. 跑 `cargo test` 前先结束残留的 `qjs-runner` 进程：`tauri-build` 每次构建都要覆盖 `target/debug/qjs-runner.exe`，被占用会报 `os error 5 拒绝访问`。
6. 若本会话的 `TEMP` 指向仓库内目录，Rust 单测里建子目录会因 ACL 失败（`create data dir failed`），改用系统临时目录（`$env:TEMP`）或仓库外的可写目录；**不要把临时目录建进仓库**。

## 5. 现状基线

`python tools/check.py` 9/9、`pnpm test` 544（66 个文件）、`cargo test --lib` 233 passed / 2 ignored。
数字随提交变化，以 `AGENTS.md`「当前状态」为准。

## 6. 探针依赖的 DOM 契约

窗口探针只能按 DOM 定位节点，所以有一小撮选择器是**产品对测试网的承诺**。它们集中登记在这里；
组件源码里不再各写各的「勿改」。

### 6.1 原则

1. **契约集中、实现单一**：新增/修改契约，同一笔提交里改本文档 + 受影响的探针。
2. **不为探针新增类名**。能用 `role` / `aria-label` / `data-value` 表达的，不用自造 BEM 名。
   教训：站点选择器曾为迁就探针在通用下拉之外另养一套 `.site-select*` 双类名，
   结果多出一个 105 行的平行组件和一套只为契约存在的类名（2026-11-16 收敛进 `AppSelect`）。
3. **同类控件必须共用一个组件**。通用组件缺能力时补通用组件，不要在调用方复制实现。
4. 探针**只读**这些属性；产品改版时先判定「是口径过期还是真回归」，禁止为了让探针变绿放宽断言。

### 6.2 下拉（`AppSelect`；`SiteSelect` 只是它的站点适配层）

| 节点 | 选择器 |
|---|---|
| 根 | `.app-select[data-value="<当前值>"]` |
| 触发器 | `.app-select__trigger`，`aria-label` = 当前项文案 |
| 菜单 | `.app-select__menu`，`role="listbox"` |
| 选项 | `.app-select__item[data-value="<选项值>"]` |
| 选项状态 | 选中 `.is-active`；不可选 `.is-disabled` + `aria-disabled="true"` |
| 选项附加 | 后置内容 `.app-select__note`（如收藏 ★）、右对齐标签 `.app-select__tag` |

程序化 `.click()` 可以开菜单也可以选中（Radix 的 `pointerTypeRef` 初值是 `"touch"`，
没有 `pointerdown` 的 click 会正常走 `onClick → handleOpen`）——探针因此不需要真实鼠标序列。

### 6.3 其它定位点

| 场景 | 契约 | 出处 |
|---|---|---|
| 首页内容 | 三形态 `.home-hero` / `.poster-tile` / `.vod-card`（推荐流出头图，分类/数据站出卡片） | `HomePage.tsx`、`HomeHero.tsx`、`PosterTile.tsx`、`VodCard.tsx` |
| 首页分页 | 无限滚动哨兵 `.infinite-sentinel`、收尾 `.infinite-foot`（无 `.pager`） | `HomePage.tsx` |
| 站点体检行 | `.health-item[data-site-key="<siteKey>"]`（列表行不是下拉选项，用语义主键） | `HealthCheckSection.tsx` |
| 滚动 | 唯一的滚动容器是 `.page-body`；`.content` 是 `overflow:hidden`，在它上面滚永远得 0 | `layout.css` |
| 常驻播放层 | 判页用 `location.hash` + `.player-host:not(.is-idle)`；详情页/选集查询必须 scope 到 `.content`（后台层不随切页卸载，全局查会把两份选集数在一起） | `AppShell.tsx`、`PlayerHost.tsx` |
| 版本 | 侧栏 `version: <x.y.z>`，**无 `v` 前缀** | `AppShell.tsx`、`lib/version.ts` |
| 日志 | 三通道 `logs/{app,spider,ui}/<name>.<date>.log` | `infra/logging/` |

### 6.4 非 DOM 的取证点

| 场景 | 契约 | 出处 |
|---|---|---|
| 播放会话状态机 | **仅 dev**：`window.__lumaPlayerSession = { instance, value, context }`。`instance` 区分「同一实例内原地换集（`sessionId` 自增）」与「整页重建（`instance` 变）」；`context` 携带 `sessionId` / `hasPlayed` / `unresponsiveProbes` / `failoverCause`。探针按它比对「模型 ↔ 现实」，产品逻辑一律不读它 | `usePlayerEngine.ts`、`vodSessionMachine.ts`、`liveSessionMachine.ts` |
| 判死文案与日志 stage | `failoverCopy(cause)` 是唯一来源；新增 `FailoverCause` 必须同时给文案与 stage（`sessionFailover.test.ts` 钉穷尽性与 stage 唯一性） | `sessionFailover.ts` |
| 错误条 | `.error-bar__text`（人话）/ `.error-bar__raw`（技术详情 `<pre>`） | `ErrorBar.tsx` |

> 比对 `instance` / `sessionId` 时注意 `SESSION` 快照的形状：`sessionId` 在 `context`
> 里，取顶层 `sessionId` 恒为 `undefined`，断言会**假绿**（2026-11-17 踩过一次）。

