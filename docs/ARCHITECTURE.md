# 架构说明（ARCHITECTURE）

> 给二次开发者的单页架构入口。规范与决策见 `AGENTS.md`；环境/四端调试/常见坑见 `docs/DEVELOPMENT.md`；目录与产物约定见 `docs/project-layout.md`。

## 1. 系统总览：一个主进程 + 三个 sidecar

```text
┌──────────────────────────────────────────────────────────────┐
│ 前端 (React+TS, WebView2, Vite dev:1420)                      │
│   routes → AppShell → pages → hooks/lib → stores              │
│   唯一 IPC 入口: src/lib/invoke.ts                            │
└───────────────┬──────────────────────────────────────────────┘
                │ Tauri invoke（37 个 command）
┌───────────────▼──────────────────────────────────────────────┐
│ 主进程 Rust/Tauri (src-tauri/src, cargo)                      │
│   infra/  底座: error/env/paths/process/netrules/http/        │
│            bridge/db/migrate/store/logging/window             │
│   domain/ 业务: config/play/parse/proxy/live/sniff/           │
│            mpv/clipboard + spider/{cms,jvm,python,quickjs}    │
│   本地反代 :9978  (m3u8 重写 / parses / headers / /image)     │
└───┬───────────┬───────────────────────────┬──────────────────┘
    │ stdio JSON-RPC (spawn_stdio/call_on)  │
┌───▼────────┐ ┌──────────────┐ ┌──────────▼──────────┐
│ Python     │ │ JVM (唯一常驻)│ │ QuickJS (qjs-runner)│
│ 适配层     │ │ runner.jar   │ │ rquickjs ESM 加载   │
│ 3.11 embed │ │ JDK 17       │ │ 随包 qjs-assets     │
└────────────┘ └──────────────┘ └─────────────────────┘
```

进程边界：**主进程不直连源站协议**，所有源站访问都经 sidecar；sidecar 崩溃由主进程按源级熔断（连续 3 次超时/崩溃禁用该源）处理，不影响其它源。

## 2. IPC 与数据流

- 前端唯一出口 `src/lib/invoke.ts` → Tauri `invoke(cmd, args)` → Rust `generate_handler!` 注册的 37 个 command。禁止前端 `import` Node 内置模块。
- 主进程 ↔ sidecar：通用 `spawn_stdio` / `call_on` / `kill_conn`（`bridge.rs`）；每行 stdout 是一帧 JSON-RPC，主循环线程池 `max_workers=8`。
- 归一化契约 `contracts/tvbox.schema.json` 是 TS / Rust / Python 三端唯一真源；`tests/e2e/contract_check.py` 校验 TS 侧字段。

```text
用户操作 → 前端 (pages/hooks) → invoke → Rust command
  → 配置/聚合: spider_invoke(siteKey) → 各 sidecar 取数据 → 归一化 → 返回
  → 播放:       resolve_play → 本地反代 :9978 → <video>/hls.js/mpegts.js
  → 换源:       同片其它线路 → 其它站点 → 第4级嗅探(sniff) → mpv 兜底
```

## 3. 四类源路由决策树

导入归一化后，每个 site 带 `type`（`cms`/`python`/`quickjs`/`jvm`）与 `enabled`/`disabledReason`：

| 类型 | 执行方 | 状态 | 说明 |
|---|---|---|---|
| `cms` | 主进程直接 HTTP | ✅ 主体 | `api.php/provide/vod`，直链 m3u8 |
| `python` | Python 适配层 | ✅ 支持 | `spider` 方法经 `py/main.py` 桥，含 JSON 安全/空信封/`_absolutize` 降级 |
| `quickjs` | qjs-runner | ✅ 支持（部分） | ESM 加载 + cheerio 等价；`initEnv` 完整 polyfill、FongMi class-based 仍未支持 |
| `jvm` | JVM runner | ⚠️ 仅模板 jar | 用户真实配置的全局 `spider` 是 Android dex jar（ART/okhttp/gson/QuickJS 依赖），Win x64 无法加载 → 源级快速失败 + 原因 |

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
  → 失败顺序: HLS fatal/12s watchdog → 同片其它线路 → 其它站点
            → 第4级嗅探(sniff, 隐藏 WebView2 抓 .m3u8/.mp4/...) → mpv 兜底
```

- 反代 `:9978`：scheme 走 `resolve_scheme_link`；源返回的 `127.0.0.1:<port>/proxy?do=...` 本地地址**一律跳过**（该路由未实现，套一层会变 403）。
- 内置播放器 **ArtPlayer**；FLV 走 mpegts.js（WebView2 无内置 FLV 解码）；`<video>` 报 `MEDIA_ERR_DECODE/ SRC_NOT_SUPPORTED` 时前端自动转 mpv 一次。
- 自动换源铁律：**「慢 ≠ 死」**——没有明确失败（4xx/5xx、非 `#EXTM3U`、首分片是图片/HTML）不换；超时算 `unknown`，连续 3 次才换。

## 6. 本地反代与嗅探

- 反代（`proxy.rs` + `netrules.rs`）：对源站请求做 UA/Referer/Cookie 透传、m3u8 分片重写、`/image` 封面代理；`LUMA_PROXY_PORT` 默认 9978。
- 嗅探（`sniff.rs`）：隐藏 `sniffer-*` WebView2 加载播放页，用 `WebResourceRequested` 抓取媒体请求；独立 `data_directory` + 覆盖 `--remote-debugging-port=0`（避开 dev 的 9222 冲突）；成功缓存 10 分钟、失败不缓存、串行化避免抢 user data dir。

## 7. 数据层（SQLite）

- `<data>/luma.db`（`rusqlite bundled`，静态编译，WAL + `synchronous=NORMAL` + `busy_timeout=5000`，`Mutex<Connection>`）。
- 表：`configs(id, imported_json, runtime_json, source_json, ...)` 整存深层嵌套方言对象；`meta(active_config_id)`；`favorites`/`history` 规范化列 + `(site_key, vod_id)` 主键。
- 写顺序：先提交事务，再刷新内存读缓存；所有写操作经事务，防 active 指向不存在配置。**无迁移**（未上线、无旧数据）。

## 8. 前端分层

```
src/routes.tsx       8 条路由（react-router createHashRouter，detail/player 大字段走 history.state）
src/AppShell.tsx    布局壳：侧栏/配置同步/命令面板/Esc 返回/滚动恢复，注册 registerNav
src/pages/          首页/分类/搜索/详情/播放/直播/收藏/历史/设置
src/hooks/          跨页复用 hook（usePlayerEngine 等）
src/lib/            invoke（唯一 IPC）、pageCache、usePageState、playerPrefs、sources、sourceCache、format、logger、clipboard、nav
src/stores/         zustand：只收编跨页共享态（cache/preferredSite/sidebarCollapsed）
src/components/     ErrorBar / Spinner / SourcePicker / player/* / settings/*
src/types/tvbox.ts  归一化契约 TS 侧
```
- hash 路由下 `pathname` 恒为 `/`，探针按 URL 选 target 不受影响。
- 提示分层：事件→toast；需决策错误→`ErrorBar`（图标+主文案+归因+折叠技术详情+复制/重试+倒计时）；说明→`.tip`。

## 9. Rust 分层（`src-tauri/src`）

- `infra/` 底座、`domain/` 业务；`lib.rs` 用 `#[path = "infra/foo.rs"] pub mod foo;` 映射，**逻辑模块名与 37 个 command 路径不变**（物理分层，未做 `crate::infra::*` 前缀化）。
- `db↔store`、`proxy↔spider` 各同层规避环；生产路径一律 `Result<T, AppError>`，禁 `unwrap()`。
- 编译：`cargo check --manifest-path src-tauri/Cargo.toml`；debug 默认开 CDP `:9222`（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`）。

## 10. 构建与产物

| 产物 | 位置 | 生成 | 入库 |
|---|---|---|---|
| ① 前端 | `dist/` | `corepack pnpm build` | 否 |
| ② Rust | `src-tauri/target/` | `cargo build` / `pnpm tauri dev` | 否 |
| ③ 交付包 | `release/portable/Luma/` + zip | `python tools/make_portable.py` | 否 |

- 运行时产物（JRE / python-embed / qjs-runner / mpv）**不入库**，由 `tools/prepare_runtime.py` 重建。
- 交付形态：**解压即用便携版 zip**（不做安装包），`exe` 同级 `data/` 优先、`sidecars/`。

## 11. 硬边界（不可逾越）

- 不内置/硬编码任何配置地址、片源、直播源、API Key。
- 不引入规格书未列功能；不用 WSA / Android 模拟器 / 内嵌 Chromium / 内嵌 Node / SSR。
- 测试网络目标只能是 `127.0.0.1`。
- 新增 command 或错误码需 v1.2 文档先行（command 闭集、契约 6.2/7.1 不动）。

## 12. 调试入口

见 `docs/DEVELOPMENT.md`：环境准备、四端调试（前端 CDP 9222、Rust cargo check、Python spider.log、JVM `LUMA_JAVA=JDK17`、qjs-runner 重编）、日志（`LUMA_LOG=debug`）、回归（离线 `cargo test --lib` / `pnpm test` / `parse_check` 与窗口 `run_probes.mjs`）、环境变量速查、常见坑 6 条。
