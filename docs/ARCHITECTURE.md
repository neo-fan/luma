# 架构说明（ARCHITECTURE）

> 给二次开发者的单页架构入口。规范与决策见 `AGENTS.md`；环境/四端调试/常见坑见 `docs/DEVELOPMENT.md`；目录与产物约定见 `docs/project-layout.md`。

## 1. 系统总览：一个主进程 + 三个 sidecar

```text
┌──────────────────────────────────────────────────────────────┐
│ 前端 (React+TS, WebView2, Vite dev:1420)                      │
│   routes → AppShell → pages → hooks/lib → stores              │
│   唯一 IPC 入口: src/lib/invoke.ts                            │
└───────────────┬──────────────────────────────────────────────┘
                │ Tauri invoke（43 个 command）
┌───────────────▼──────────────────────────────────────────────┐
│ 主进程 Rust/Tauri (src-tauri/src, cargo)                      │
│   infra/  底座: error/env/paths/process/netrules/http/pct/    │
│            textio/started/bridge/db/store/logging/window      │
│   domain/ 业务: config/play/parse/proxy/live/sniff/           │
│            clipboard + spider/{cms,python,quickjs}           │
│   本地反代 :9978  (m3u8 重写 / parses / headers / /image)     │
└───┬───────────────────────────────┬──────────────────────────┘
    │ stdio JSON-RPC (spawn_stdio/call_on) │
┌───▼────────┐            ┌──────────▼──────────┐
│ Python     │            │ QuickJS (qjs-runner)│
│ 适配层     │            │ rquickjs ESM 加载   │
│ 3.11 embed │            │ 随包 qjs-assets     │
└────────────┘            └─────────────────────┘
```

进程边界：**主进程不直连源站协议**，所有源站访问都经 sidecar；sidecar 崩溃由主进程按源级熔断（连续 3 次超时/崩溃禁用该源）处理，不影响其它源。

## 2. IPC 与数据流

- 前端唯一出口 `src/lib/invoke.ts` → Tauri `invoke(cmd, args)` → Rust `generate_handler!` 注册的 43 个 command。禁止前端 `import` Node 内置模块。
- 主进程 ↔ sidecar：通用 `spawn_stdio` / `call_on` / `kill_conn`（`bridge.rs`）；每行 stdout 是一帧 JSON-RPC，主循环线程池 `max_workers=8`。
- 归一化契约 `contracts/luma.schema.json` 是 TS / Rust 两端唯一真源；`tests/offline/contract_check.py` 校验 TS 侧字段。

```text
用户操作 → 前端 (pages/hooks) → invoke → Rust command
  → 配置/聚合: spider_invoke(siteKey) → 各 sidecar 取数据 → 归一化 → 返回
  → 播放:       resolve_play → 本地反代 :9978 → <video>/hls.js/mpegts.js
  → 换源:       同片其它线路 → 其它站点 → 第4级嗅探(sniff)
```

## 3. 四类源路由决策树

导入归一化后，每个 site 带 `type`（`cms`/`python`/`quickjs`/`jvm`）与 `enabled`/`disabledReason`：

| 类型 | 执行方 | 状态 | 说明 |
|---|---|---|---|
| `cms` | 主进程直接 HTTP | ✅ 主体 | `api.php/provide/vod`，直链 m3u8 |
| `python` | Python 适配层 | ✅ 支持 | 只执行第三方 `spider` 脚本（`py/main.py` → `pyspider.py`，进程内常驻实例池），返回值原样交回、由宿主 `cms_parse.rs` 归一化；含 JSON 安全/空信封/`_absolutize` 降级 |
| `quickjs` | qjs-runner | ✅ 支持（部分） | ESM 加载 + cheerio 等价；`initEnv` 完整 polyfill、FongMi class-based 仍未支持 |
| `jvm` | （无运行时） | ⛔ 运行时已移除 | jar 站点仍被识别为 `jvm` 并在导入时屏蔽（`enabled=false`+`disabledReason`）；Android dex jar 依赖 ART/okhttp/gson/QuickJS，Win x64 无法加载。JVM 运行时（`spider/jvm.rs` / `sidecars/java` / `sidecars/jre`）已于 1.0.3 整体移除 |

策略入口 `spider_invoke` 单点补运行策略检查，防止绕过；`derive_runtime()` 从 `imported` 单向派生 `runtime` 快照（命中站点 `enabled=false` + `disabledReason`），fan-out/播放只读 `runtime`。

## 4. 配置导入与双快照隔离

- `StoredConfig` 持久化 `imported_json`（导入+归一化原件，**永不被运行改写**）与 `runtime_json`（派生快照，含 `enabled`/`disabledReason`）。
- `ConfigStore::load` 遇空 `runtime_json` 自动派生并回写；策略变更从 `imported` 重派生，**不在已派生结果上二次改写**（幂等、可重放）。
- `find_site` 仍查 `imported` 以兼容旧收藏/历史；`config_activate(id)` 写 `meta.active_config_id` → 更新内存 active → `netrules::replace` → 返回运行快照。
- GitHub 加速在导入期改写一次（只碰 github 系主机，先剥后套幂等），`origin` 始终保留原始 URL（配置 id 由其派生）。

## 5. 播放链路

```text
PlayerPage.resolve_play
  → playerContent(flag, id, [])      取 playUrl/url + header(UA/Referer/Cookie)
  → 本地反代 :9978 重写 m3u8 相对分片、透传 headers
  → <video> + hls.js (m3u8) / mpegts.js (flv, MSE)
   → 失败顺序: HLS fatal → 就地重连同一地址（800/1600/3200/6400ms，共 4 次）
              → 仍失败则报错，由用户决定换线路 / 换源
              → stall 看门狗（判决在会话状态机：静默 20s 独立复核，
              dead 一次即判死、unknown 累计三次判死、已出画后不判死）
            → 第4级嗅探(sniff, 隐藏 WebView2 抓 .m3u8/.mp4/...)
```

- 反代 `:9978`：scheme 走 `resolve_scheme_link`；源返回的 `127.0.0.1:<port>/proxy?do=...` 本地地址**一律跳过**（该路由未实现，套一层会变 403）。
- 反代上游超时只看「建连 10s」与「两次读到数据间隔 20s」，**不用整体墙钟截止**：慢 CDN 的 9MB 分片读到 21 秒被掐断会变成半截分片，播放器侧表现为 `fragLoadError` + 永久转圈。
- 内置播放器 **ArtPlayer**；FLV 走 mpegts.js（WebView2 无内置 FLV 解码）；`<video>` 报 `MEDIA_ERR_DECODE/ SRC_NOT_SUPPORTED`（常见于 HEVC）时直接落到换线路 / 换源，不再有外部播放兜底。
- 自动换源铁律：**「慢 ≠ 死」**——没有明确失败（4xx/5xx、非 `#EXTM3U`、首分片是图片/HTML）不换；超时算 `unknown`，连续 3 次才判死。判死后**只上报，不自动切换**：换线 / 换源由 UI 选择发起（乐观切换，不预检）。

### 5.1 前端切换编排（`src/hooks/playback/`）

播放目标只有一份真源，四条异步链（换集 / 换源 / 换线 / 自动自愈）都只是「产生一个新目标」：

| 模块 | 职责 |
|---|---|
| `playbackTarget.ts` | `PlaybackTarget` + reducer（`catalog`/`intent`/`commit`/`cancel`/`reset`）；显示恒为 `intent ?? committed`，索引由 `clampTarget` 钳制 |
| `usePlaybackController.ts` | 目录拉取、选集、换源、换线、自愈的唯一编排点：`switchToken` 单调代次抢占 + `commitGate` 串行提交（进锁再校验代次）+ `switchQueue` 合并连点 + `manualHold` 手动意图持有期内让自愈让位 |
| `episodePlayResolve.ts` | 单集解析单一实现：集级缓存 → `playerContent` 前置解析 → `resolve_play` → 校验播放类型未变（`hls → page` 必须退整页） |
| `playerRoute.ts` | `player` 路由唯一构造点（`playFrom` 决定线路 headers、`failoverKey` 决定换线账本能否续上） |
| `lib/switchToken.ts` / `lib/switchQueue.ts` | 代次令牌 / 串行提交门 / 手动持有；队列合并与同步 `peek` 判等 |
| `lib/failoverLedger.ts` | 按剧记账：试过的 url / 源、切换次数预算，防搜索风暴 |

不变式：**最终上屏的一定是最新一次选中**；迟到的旧解析拿不到画面；手动选择压过自动自愈（60s 持有期）；`30s` 兜底只复位「切换中」UI，**不作废代次、不撤意图**（解析硬上限 50s，作废会让真正完成的结果被丢弃、画面卡住）。

## 6. 本地反代与嗅探

- 反代（`proxy/{mod,handlers,guard,playlist,speed}.rs` + `netrules.rs`）：对源站请求做 UA/Referer/Cookie 透传、m3u8 分片重写、`/image` 封面代理；`speed.rs` 在分片转发途中累计字节做吞吐采样（前端 HUD 每秒轮询 `/meter`，量的是源站真实下载速度而不是回环速度）；`LUMA_PROXY_PORT` 按通道分：stable 9978 / beta 9977 / dev 9979（绑定后由宿主写回环境变量）。
- 嗅探（`sniff.rs`）：隐藏 `sniffer-*` WebView2 加载播放页，用 `WebResourceRequested` 抓取媒体请求；独立 `data_directory` + 覆盖 `--remote-debugging-port=0`（避开 dev 的 9222 冲突）；成功缓存 10 分钟、失败不缓存、串行化避免抢 user data dir。
- 爬虫自带代理（`handle_spider_proxy`，`spider::proxy_call`）：实现 `Spider.proxy`/`localProxy` 的源（如央视频 yangshipin 的 `live_mode=proxy`）把播放地址回指到 `/proxy`，宿主用 `last_play_site()` 找到上一个点播源、把整张 query 表交给其 `proxy()`，返回 `[contentType, headers, bytes]` 作 HTTP 响应。路由判据：带 `do=py|js|jar` 直接回调；无 `do=` 但 `url=` 为空且带其它参数（FongMi 系 `getProxyUrl()` 基址不含 `do=` 的写法）也回调——空 `url=` 本就不是合法直连。Python 基类 `proxy()` 委派 `localProxy()`（社区源多只实现后者）。

## 7. 数据层（SQLite）

- `<data>/luma.db`（`rusqlite bundled`，静态编译，WAL + `synchronous=NORMAL` + `busy_timeout=5000`，`Mutex<Connection>`）。
- 表：`configs(id, imported_json, runtime_json, source_json, ...)` 整存深层嵌套方言对象（**过渡期**）；`subscriptions`（2.0 目标：`address` 裸地址唯一 + `payload` 存内联正文）；`playback` 播放记录**单表**（`title_key` 剧名归一化唯一 + `favorite` flag + `episode_number` 语义集号 + `prefs_json` 扩展位，取代旧 `favorites`/`history` 两张表）；`meta(active_config_id)`。
- 写顺序：先提交事务，再刷新内存读缓存；所有写操作经事务，防 active 指向不存在配置。**2.0 破坏性升级**：`PRAGMA user_version` 闸门，低于 2 时丢弃旧收藏/历史分表并清空订阅刷新状态，订阅地址保留在 `configs`，由下一次 60s 刷新重新拉取 + 解析。

## 8. 前端分层

```
src/routes.tsx       8 条路由（react-router createHashRouter，detail/player 大字段走 history.state）
src/AppShell.tsx    布局壳：侧栏/配置同步/命令面板/Esc 返回/滚动恢复，注册 registerNav
src/pages/          首页/分类/搜索/详情/播放/直播/收藏/历史/设置
src/hooks/          跨页复用 hook（usePlayerEngine / usePlayResolution / usePlaybackHistory /
                    useLiveCatalog）+ playback/（单一播放目标 + 切换编排，见 §5.1）
src/lib/            invoke（唯一 IPC）、queryClient、handoff、usePageState、playerPrefs、sources、sourceCache、format、logger、clipboard、nav
src/stores/         zustand：只收编跨页共享态（cache/preferredSite/sidebarCollapsed）
src/components/     ErrorBar / Spinner / SourcePicker / player/* / settings/*
src/types/luma.ts  归一化契约 TS 侧
```
- hash 路由下 `pathname` 恒为 `/`，探针按 URL 选 target 不受影响。
- 提示分层：事件→toast；需决策错误→`ErrorBar`（图标+主文案+归因+折叠技术详情+复制/重试+倒计时）；说明→`.tip`。`ErrorBar` 有三种身材：`bar` 压在内容上、`compact` 进窄面板、`panel` 用于**整页失败**（错误就是这一屏的内容，卡片居中，与详情空态同一套容器）。

### 8.1 数据分层与失效契约

页面之间传的是**实体**，不是「让对方再去取一次」。四层职责固定，越界即视为缺陷：

| 层 | 模块 | 放什么 | 有效期 / 上限 | 何时失效 | 允许谁依赖 |
|---|---|---|---|---|---|
| L0 身份 | URL + `history.state`（`lib/nav.ts`）、SQLite `playback` | 重建会话的最小集：`siteKey/vodId/playUrl/episodeName/playFrom` | 持久 | 配置切换重建 | 任何地方 |
| L1 交接 | `lib/handoff.ts` | 上一页已握住的 `VodInfo`（详情跳/播放跳各一槽） | 单跳、2 分钟 | 落地页 effect 按身份清；配置切换 `clearAllHandoffs()` | **落地首帧只能读它** |
| L2 回访 | `lib/queryClient.ts`（TanStack） | `detail` 10min / `home`·`category`·`live` 5min / `search` 2min | `gcTime` 30min | 配置切换 `resetCacheForScope`；空结果 `dropCached` | 只做兜底，不做跳转依赖 |
| L3 派生索引 | `lib/cardIndex.ts`、`lib/sourceCache.ts` | 列表卡片 slim（6h / 3000 条）、换源候选（10min / 8 bundle / 512 预热） | 见左 | 配置切换 `forgetCards` / `clearSourceCache` | 只做「同一实体在别处出现」的兜底 |
| L4 时效凭据 | `lib/episodePlayCache.ts` | `PlayResolved`（带 token 的直链/反代地址） | 3min / 64 条 | 播放 fatal、手动刷新即作废 | **只有播放器读**，不参与首帧 |

另有两条**不是数据源**的存储，别拿它们当真相：
- `lib/usePageState.ts`：UI 快照（选中线路、筛选词、倒序、展开态、滚动），无 TTL，配置切换整体清空。**网络数据/详情不写这里**（写了就没有失效点）。
- zustand `playSession`：当前会话身份，等价于 L0 的内存镜像。

判据：首帧出不来内容 = 缺 L1 交接；看到旧内容 = 数据被写进了没有 TTL 的层；`刚点就解析失败` = L4 命中临界过期凭据。

## 9. Rust 分层（`src-tauri/src`）

- `infra/` 底座、`domain/` 业务；`lib.rs` 用 `#[path = "infra/foo.rs"] pub mod foo;` 映射，**逻辑模块名与 43 个 command 路径不变**（物理分层，未做 `crate::infra::*` 前缀化）。
- `db↔store`、`proxy↔spider` 各同层规避环；生产路径一律 `Result<T, AppError>`，禁 `unwrap()`。
- 编译：`cargo check --manifest-path src-tauri/Cargo.toml`；debug 默认开 CDP `:9222`（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`）。

## 10. 构建与产物

| 产物 | 位置 | 生成 | 入库 |
|---|---|---|---|
| ① 前端 | `dist/` | `corepack pnpm build` | 否 |
| ② Rust | `src-tauri/target/` | `cargo build` / `pnpm dev:app` | 否 |
| ③ 交付包 | `src-tauri/target/release/bundle/nsis/*.exe` | `corepack pnpm build:app`（官方） | 否 |

- 运行时产物（python-embed / qjs-runner 二进制）**不入库**，由 `tools/prepare_runtime.py` 重建后由 `tauri build` 经 `bundle.resources` / `bundle.externalBin` 打包。JVM 运行时已移除，不再产出 JRE / `runner.jar`。
- 交付形态：**官方 NSIS 安装器**（`tauri build` 产出），`data/` 优先 `exe` 同级、`sidecars/` 来自资源目录。

### 10.1 自动升级（`domain/updater.rs`）

- 版本清单是 Release 上的静态资产 `latest.json`（`version` / `tag` / `notes` / `asset{name,size,sha256}`），由发布工作流生成。客户端**不调 GitHub API**：三家内置加速前缀实测都不支持 `api.github.com`。
- 候选通道 = 用户当前加速前缀 → 其余内置前缀 → 直连。清单并发竞速取最先成功者，安装包逐前缀串行回退（某个代理被掐不会卡死）。
- 下载边写边算 SHA256，与清单比对 + 校验字节数后原子改名；安装走项目自己产出的 NSIS（`/P /R`：passive 只显示安装进度窗口、不需要任何交互，`currentUser` 模式不需要提权），随后应用退出；模板在 passive 下同样识别 `/R`，安装成功后自动重新拉起应用，启动回执再提示「已更新到 X」。
- 前端：`UpdateSection` 负责手动检查 / 下载 / 安装；`lib/updatePrefs.ts` 只在本机 localStorage 存「自动检查开关 / 上次检查时间 / 已读版本」。启动后延迟 6 秒静默检查一次，每天最多一次，有新版只在侧栏留轻提示。

## 11. 硬边界（不可逾越）

- 不内置/硬编码任何配置地址、片源、直播源、API Key。
- 不引入规格书未列功能；不用 WSA / Android 模拟器 / 内嵌 Chromium / 内嵌 Node / SSR。
- 测试网络目标只能是 `127.0.0.1`。
- 新增 command 或错误码需 v1.2 文档先行（command 闭集、契约 6.2/7.1 不动）。

## 12. 调试入口

- **调试**：`docs/DEVELOPMENT.md` —— 环境准备、四端调试（前端 CDP 9222、Rust cargo check、Python `logs/spider`、qjs-runner 重编）、日志（`LUMA_LOG=debug`，三个通道 `logs/{app,ui,spider}`）、环境变量速查、常见坑 6 条。
- **回归**：`python tools/check.py`（离线一键）/ `node tools/run_probes.mjs`（窗口探针）。
- **性能**：`docs/PERFORMANCE.md`（三层链路模型）/ `node tools/perf/analyse.mjs`（CDP + IPC + 业务 trace 合成时间线）。
- **维护与升级**：`docs/MAINTENANCE.md`；**发布**：`docs/RELEASING.md`；**变更记录**：`CHANGELOG.md`。

## 13. ADR：随包运行时优先于宿主环境（2026-11-14）

**Context**：`prepare_runtime.py` 产出随包运行时（当时含 `jlink` 裁剪的 `sidecars/jre`），但早期 sidecar 按 `LUMA_* -> JAVA_HOME -> PATH` 解析，从不使用随包产物；开发机默认 JDK 23 与交付 JRE 17 行为不一致，且需要用户额外安装 JDK。`python-embed` 早已用 `paths::embedded_python()` 解决同类问题。

**Decision**：所有 sidecar 运行时统一走 `sidecar_roots()` 探测，优先级 = 显式环境变量覆盖 -> 随包运行时 -> 宿主环境兜底。各 sidecar 按此改造；`prepare_runtime.py` 删除硬编码的 `D:/software/java/...`。

**Consequences**：零配置启动、dev/交付同源、用户无需安装额外运行时；sidecar 运行时缺失时由宿主环境兜底，探测顺序可预测。

> **2026-11-15 后续**：JVM 运行时（`sidecars/jre`、`runner.jar`、`spider/jvm.rs`、`p2.py`）已整体移除，本 ADR 中与 JVM 相关的取舍作废；随包运行时探测只剩 Python embeddable 与 `qjs-runner`。jar 站点仍被识别为 `jvm` 并在导入时屏蔽。
