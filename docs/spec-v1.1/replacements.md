# TVBox 桌面客户端 · 实现规格 现状对齐（v1.1 修订档）

> 本文在 1.0.5 重写，用来替代 2026-11-08 的 v1.1「替换清单」。那份清单是提交给云端规格书的
> 逐条粘贴稿，前提是「解析链在 Python 适配层里跑、jar 走 JVM sidecar」；1.0.2 ~ 1.0.5 的重构把
> 这些前提全部推翻了：
>
> - 配置解密 / 归一化 / 站点路由 / CMS 采集 / m3u / XMLTV / parse 池全部搬进 Rust 宿主进程；
> - Python 适配层只剩一条职责：**执行第三方 `spider` 脚本**；
> - jar（`csp_*`）运行时整体移除，站点仍识别为 `jvm` 并在导入时屏蔽。
>
> 实现与本文冲突时，以 `docs/ARCHITECTURE.md` 与代码为准，并先改本文。R1~R11 的逐条处置见 §1。

## 0. 一页摘要

| 项 | 现状 |
| --- | --- |
| 交付形态 | `tauri build` 产出的 NSIS 安装器（`Luma_<version>_x64-setup.exe`） |
| 版本 / build 号 | `package.json` 唯一来源；界面 build 号 = 宿主进程本次启动时刻（`infra/started.rs`），前后端同一个 14 位时间戳 |
| 前端 | React 18 + TS + Vite（dev 1420）、react-router（hash）、zustand、ArtPlayer + hls.js / mpegts.js |
| 宿主 | Tauri v2 + Rust stable（x86_64-pc-windows-msvc）、reqwest(rustls)、tokio、axum、rusqlite、Job Objects |
| sidecar | Python 3.11 embeddable（stdio JSON-RPC）；`qjs-runner`（rquickjs，`externalBin`） |
| 本地反代 | `127.0.0.1:9978`（被占用时回退动态端口并注入脚本） |
| 命令面 | **37 个 command 闭集**（`src-tauri/src/lib.rs` 注册，`src/lib/invoke.ts` 是唯一 IPC 出口） |
| 路由 | 8 条（`src/routes.tsx`，detail/player 大字段走 `history.state`） |
| 数据 | `<data>/luma.db` 单库（WAL + 事务），便携模式 = exe 同级有 `data/` |

## 1. v1.1 修订条（R1~R11）的现状处置

| 条目 | v1.1 的主张 | 现状 |
| --- | --- | --- |
| R1 累积断言矩阵 | `p0/p1/p2/p3` 按阶段累积，未交付标 `N/A` | 保留。`tests/acceptance/` 现有 `p0.py` / `p1.py` / `p3.py`（p2 随 jar 运行时一起删除） |
| R2 命令清单唯一真源 | 7 个 command | 保留「唯一真源」，数量已变为 **37**；新增 command 仍须同步 `lib.rs`、`invoke.ts`、`capabilities/default.json` |
| R3 方法集合分离 | `SpiderMethod`(6) / 协议方法(11) / Spider API(12) | 三套集合仍分开，但数字变了：`SpiderMethod` **8**（含 `homeVideoContent` / `proxy`）、协议方法 **2**、Spider API 不复存在（jar 移除） |
| R4 JS 下沉 sidecar | `qjs-runner` 独立进程 | 保留。每请求独立 rquickjs context，`assets://` + 8 个随包依赖 |
| R5 Rust 唯一拉起主体 | 删除 `shell:allow-spawn` | 保留。`infra/process.rs` + Job Object 收尸 |
| R6 Python 线程池 8 | `ThreadPoolExecutor(max_workers=8)` | 保留但**只余一条车道**：没有导入/爬虫两条车道的区分，`spider.py` 仍转独立子进程 |
| R7 反代目标白名单 | 保留 9978、不做一次性 token | 保留（`domain/proxy/guard.rs`） |
| R8 契约轻量校验 | `contracts/tvbox.schema.json` + `contract_check.py` | 保留，接入 `tools/check.py` |
| R9 目标 jar | `tests/fixtures/jars/` 自编模板 jar | **作废**：jar 运行时与 fixture 已删除 |
| R10 JDK 17 / jlink | 随包裁剪 JRE | **作废**：不再分发 JVM |
| R11 Python 随包 | `python-embed` + `<45MB` 实测口径 | 保留，体积口径见 `docs/size-report.md` |

## 2. 进程拓扑与责任边界

```text
WebView2（React，Vite dev 1420）
  │  invoke（唯一 IPC 出口 src/lib/invoke.ts）
  ▼
Rust 宿主（Tauri v2）
  ├─ infra/   bridge · db · env · error · http · logging · netrules · paths · process · store · textio · window
  ├─ domain/  config（decrypt/normalize/import/derive/refresh）· spider（cms/cms_parse/python/quickjs）
  │           · live（m3u/epg）· parse · play · proxy（guard/handlers/playlist）· douban · sniff
  └─ 本地反代 :9978（m3u8 重写、headers 补默认值）
        │  stdio JSON-RPC
        ▼
sidecar：Python 适配层（只执行第三方 spider 脚本） · qjs-runner（只执行第三方 JS 源）
```

- 第三方代码**一律子进程**：Python 脚本经 `pyspider.py` 拉起 `pyrun.py`，JS 脚本进 `qjs-runner`；
  主进程不执行第三方代码。子进程超时按进程级强杀（Job Object），不依赖 future 取消。
- Rust 进程内只跑自研逻辑：CMS 采集与解析、配置链、直播解析、parse 池、反代、豆瓣。
- jar 不执行：`csp_*` / `.jar` 站点识别为 `jvm`，导入即 `enabled: false`，原因「jar 源为 Android dex，Windows 端暂不支持」。

## 3. 四类源的执行与解析位置

| 源 | 脚本在哪执行 | 响应在哪解析 | 状态 |
| --- | --- | --- | --- |
| CMS 采集 | —（宿主 `reqwest`） | `domain/spider/cms_parse.rs`（JSON/XML → 契约；`normalize_spider_result` 也在这里） | ✅ 承诺 |
| Python（`base.spider`） | `sidecars/py/main.py` → `pyspider.py` → `pyrun.py` 子进程 | 脚本结果原样交回，宿主 `cms_parse.rs` 归一化 | ✅ 承诺（返回自有本地服务的源除外） |
| JS（drpy2 / 经典 `var spider`） | `qjs-runner`（独立进程） | 宿主 `spider/quickjs.rs` 直接收帧：qjs-runner 自己产出契约形状，不再过 `cms_parse` 归一化 | ✅ 支持 |
| jar（`csp_*` / jvm） | 不执行 | — | ⛔ 运行时已移除，导入即屏蔽 |

## 4. 适配层协议（当前 = 2 个方法）

| 方法 | 说明 |
| --- | --- |
| `ping` | 返回 `{ ok: true, result: { version } }`；`version` 来自 `LUMA_VERSION`（宿主注入，回退 `package.json`） |
| `spider.py` | `params = { source, className?, method, args, ext?, api?, filename?, timeoutMs? }`，结果 = 脚本返回值（已 `json_safe` 净化） |
| `debug.*` | 仅当 `LUMA_ADAPTER_DEBUG=1` / `TVBOX_ADAPTER_DEBUG=1` 时可用（`echo` / `junk` / `crash`），生产不注册 |

- 帧格式：一行一个 JSON。请求 `{ id, method, params }`；响应 `{ id, ok: true, result }` 或 `{ id, ok: false, error: { code, message } }`。stdout 只允许协议帧，日志一律走 stderr / 文件。
- 并发：**单车道** `ThreadPoolExecutor(max_workers=8)`；`spider.py` 在车道里等 `pyrun.py` 子进程（一次调用占满一条 worker 直到脚本返回或宿主强杀），`ping` 与其共享队列，宿主侧看到的是排队而不是丢失。
- 帧健壮性：坏帧能捞出 id 就回 `malformed frame` 错误帧，捞不到就记日志并继续服务（静默丢帧会让宿主干等满墙钟）。
- 编码：stdio 恒 UTF-8；`force_utf8_stdio()` 在 `main.py` 启动时重建 stdin/stdout。
- 可观测性：慢调用（≥ 3000ms）写 `adapter_latency`，脚本崩溃写 `spider_crash`（含 traceback 与来源 api），能力缺口写 `missing_method`，越界返回值写 `unsafe_result`。
- 已删除方法（调用返回 `unknown method`）：`config.decrypt` / `config.normalize` / `config.mergeRepos` / `site.route` / `site.parseHome|parseCategory|parseDetail|parseSearch` / `live.parseM3u` / `live.parseEpg` / `parse.resolve`。

## 5. 宿主 IPC 与路由

- **37 个 command 闭集**：config 12（`config_import/list/active/activate/rename/remove/refresh/refresh_settings/set_refresh_interval`、`gh_proxy_state/set/test`）、http 1、spider 2（`spider_invoke` / `site_health`）、live 3（`live_parse` / `live_epg` / `live_epg_warm`）、proxy 1、play 2（`resolve_play` / `open_external`）、parse 1（`parse_resolve`）、douban 1、store 8（收藏 3 + 历史 5）、logging 4、clipboard 1、`site_set_enabled`。
- 前端不得绕过 `src/lib/invoke.ts`；detail/player 的大字段走 `history.state`，不进 URL。
- 权限闭集在 `capabilities/default.json`，由 `tests/offline/capabilities_check.py` 守住。

## 6. 解析链位置（全部进程内纯函数）

| 能力 | 位置 |
| --- | --- |
| 配置解密 | `domain/config/decrypt.rs` |
| 方言归一化 + 多仓合并 + 站点路由 | `domain/config/normalize.rs`（`normalize_config` / `merge_repos` / `route`） |
| 导入、双快照、策略派生 | `domain/config/{import,derive}.rs`（`imported_json` 永不改写，运行策略只写 `runtime_json`） |
| CMS 采集 | `domain/spider/cms.rs` → `cms_parse.rs` |
| py / js 源返回值归一 | `domain/spider/cms_parse.rs::normalize_spider_result` |
| m3u / txt 直播源 | `domain/live/m3u.rs` |
| XMLTV 节目单 | `domain/live/epg.rs` |
| parse 池解析 | `domain/parse.rs`（command `parse_resolve`） |
| 豆瓣元数据 | `domain/douban.rs` |

外部字节一律经 `infra/textio.rs` 洗成 UTF-8 再解析；macOS/Linux 不承诺。

## 7. 日志、诊断与版本

- 日志三通道：`app` / `ui` / `spider`，落 `<data>/logs/<channel>/<channel>.<UTC 日期>.log`，单文件 10 MiB 滚动。
  `spider` 通道只放脚本异常与 traceback；适配层的 JSONL 画在同一文件里（`layer: "py-adapter"`）。
- 诊断（设置 → 诊断）：版本、build 号（`started_at`）、运行平台、数据目录、日志目录、日志文件、当前配置。
- 版本一致性：`python tools/version_check.py`（`tools/check.py` 第 2 项）静态对齐 `package.json` /
  `Cargo.toml` / `Cargo.lock` / `AGENTS.md` / `tauri.conf.json` / `main.py`，并跑一次 `ping` 验证注入覆盖。

## 8. 验收基线

| 层 | 命令 | 基线 |
| --- | --- | --- |
| 离线门禁（9 项） | `python tools/check.py` | 全 PASS（契约 / 版本一致性 / py 兼容 / py 框架 / 适配层健壮性 / 运行时候检 / py 语法 / 前端单测 / Rust 单测） |
| 验收脚本 | `python tests/acceptance/p0.py`、`p1.py --adapter` | 见脚本输出；p1 的适配层阶段只断言 `ping` + `spider.py` 与已删方法的反向断言 |
| 窗口探针 | `node tools/run_probes.mjs` | 需 debug 窗口 + CDP 9222 |

> 单源默认 15s 墙钟超时、配置拉取 10s；fan-out 并发上限 20。

## 9. 与云端 v1.1 规格的差异（这些条目不再适用）

1. **JVM / jar 全链路**：`sidecars/jre`、`sidecars/java`、`SpiderRunner.java`、`dex2jar`、桩类符号守恒、
   `javap` 比对、jar 跑通率、`tests/fixtures/jars/`、JDK 17 / `jlink` —— 全部删除。规格里的「Spider API 12 方法」随之作废。
2. **协议方法数**：11 → 2（`ping` + `spider.py`），见 §4。
3. **命令数**：7 → 37，见 §5。
4. **`externalBin`**：只剩 `binaries/qjs-runner`；Python 以 `resources` 随包（`sidecars/python-embed`、`sidecars/py`、`sidecars/qjs-assets`）。
5. **P0 语义**：`config.decrypt` / `config.normalize` 不再是适配层能力，离线闭环由 Rust 单测 + `config_compat.py` 守（后者只保留 `pyrun` / `base.spider` 部分）。
6. **测试分层**：`p2.py` 已删除；`tests/offline/` 内与 Python 解析链重复的脚本（`config_shapes_check.py` /
   `parse_check.py` / `parse_epg_check.py`）已删除，对应断言由 Rust 单测（`normalize.rs` / `m3u.rs` / `epg.rs`）覆盖。
