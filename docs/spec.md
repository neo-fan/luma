# Luma 实现规格（现状）

> 本文描述**当前代码的形态**，是需求与实现的唯一基线：改行为先改这里，再改代码；
> 与实现不一致时以本文为准（`AGENTS.md`「本地需求文档优先」）。本文不按版本号切分，
> 也不保留历史修订稿——过程记录看 `CHANGELOG.md` 与 git history。

## 1. 范围与交付

- **是什么**：Windows 11 x64 的配置兼容播放框架（空壳框架，兼容 TVBox 系配置）。用户导入自己的
  `api.json` / `box.json` 及变体，应用提供点播浏览 / 搜索 / 详情 / 播放、直播，以及
  CMS / Python / JS 三类源的调度。
- **不内置**任何配置地址、片源、直播源、API Key。
- **交付形态**：官方 `tauri build` 产出的 NSIS 安装器（`Luma_<version>_x64-setup.exe`）。
- **不承诺**：macOS / Linux；jar（`csp_*` / jvm）运行时；返回自有本地服务的源。

## 2. 版本与构建标识

| 项 | 现状 |
| --- | --- |
| 版本号 | `package.json` 是唯一来源；`tauri.conf.json` 直接指向它（`"version": "../package.json"`），`Cargo.toml` 由 `build.rs` 断言，`sidecars/py/main.py` 读宿主注入的 `LUMA_VERSION` |
| 一致性检查 | `python tools/version_check.py`（`tools/check.py` 第 2 项），静态对齐 + 跑一次 `ping` 验证注入覆盖 |
| 界面 build 号 | 宿主进程**本次启动时刻**（`infra/started.rs` → `diagnostics.startedAt`），前端 `src/lib/appInfo.ts` 缓存后统一显示；侧栏与设置页是同一个 14 位时间戳 |
| 诊断里的另两个值 | `buildHash`（最近提交）、`buildTime`（exe 修改时间）只用于排障，不上界面 |

## 3. 进程拓扑与责任边界

```text
WebView2（React，Vite dev 1420）
  │  invoke（唯一 IPC 出口 src/lib/invoke.ts）
  ▼
Rust 宿主（Tauri v2）
  ├─ infra/   bridge · db · env · error · http · logging · netrules · paths · process · started · store · textio · window
  ├─ domain/  config（decrypt/normalize/import/derive/refresh）· spider（cms/cms_parse/python/quickjs）
  │           · live（m3u/epg）· parse · play · proxy（guard/handlers/playlist）· douban · sniff
  └─ 本地反代 :9978（m3u8 重写、headers 补默认值）
        │  stdio JSON-RPC
        ▼
sidecar：Python 适配层（只执行第三方 spider 脚本） · qjs-runner（只执行第三方 JS 源）
```

- **第三方代码一律在宿主进程之外**：Python 脚本由适配层进程内的 `pyspider.py` 执行
  （每源一个常驻实例池，逐实例加锁串行），JS 脚本进独立的 `qjs-runner`；Rust 主进程
  不执行第三方代码。Python 侧超时由宿主墙钟判定并发 `cancel` 帧，连接判死则重启适配层
  （`bridge.rs`）；`qjs-runner` 按进程级强杀，不依赖 future 取消。
- Rust 进程内只跑自研逻辑：配置链、CMS 采集与解析、直播解析、parse 池、反代、豆瓣。
- `infra/` 与 `domain/` 是物理分层（`#[path]` 映射），40 个 command 的路径因此零改动；
  `db↔store`、`proxy↔spider` 各自同层以规避环。

## 4. 源类型：执行与解析位置

| 源 | 脚本在哪执行 | 响应在哪解析 | 状态 |
| --- | --- | --- | --- |
| CMS 采集 | —（宿主 `reqwest`） | `domain/spider/cms_parse.rs`（JSON/XML → 契约） | ✅ 承诺（直链 m3u8） |
| Python（`base.spider`） | `sidecars/py/main.py` → `pyspider.py`（进程内常驻实例池） | 脚本结果原样交回，宿主 `cms_parse.rs::normalize_spider_result` 归一化 | ✅ 承诺（返回自有本地服务的源除外） |
| JS（drpy2 / 经典 `var spider`） | `qjs-runner`（独立进程，每请求独立 rquickjs context） | 宿主 `spider/quickjs.rs` 直接收帧：qjs-runner 自己产出契约形状，不再过 `cms_parse` | ✅ 支持 |
| jar（`csp_*` / jvm） | 不执行 | — | ⛔ 运行时已移除，导入即 `enabled: false`，原因「jar 源为 Android dex，Windows 端暂不支持」 |

## 5. 适配层协议（2 个方法）

| 方法 | 说明 |
| --- | --- |
| `ping` | 返回 `{ ok: true, result: { version } }`；`version` 来自 `LUMA_VERSION`（宿主注入，回退 `package.json`） |
| `spider.py` | `params = { source, className?, method, args, ext?, api?, filename?, timeoutMs? }`，结果 = 脚本返回值（已 `json_safe` 净化） |
| `debug.*` | 仅当 `LUMA_ADAPTER_DEBUG=1` 时注册（`echo` / `junk` / `crash`），生产不可见 |

- **帧格式**：一行一个 JSON。请求 `{ id, method, params }`；响应
  `{ id, ok: true, result }` 或 `{ id, ok: false, error: { code, message } }`。
  stdout 只允许协议帧，日志一律走 stderr / 文件；启动后 `sys.stdout` 被换成「一律
  投 stderr」的门卫，第三方脚本的 `print` 不会插进帧里。
- **并发**：单车道 `ThreadPoolExecutor(max_workers=8)`；`spider.py` 在车道里同步等待
  脚本返回（同源调用被实例锁串行，跨源仍并发），`ping` 与其共享队列，宿主侧看到的是
  排队而不是丢失。
- **帧健壮性**：坏帧能捞出 id 就回 `malformed frame` 错误帧，捞不到就记日志并继续
  服务（静默丢帧会让宿主干等满墙钟）。
- **编码**：stdio 恒 UTF-8，`force_utf8_stdio()` 在启动时重建 stdin/stdout；宿主给
  子进程注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8` / `PYTHONPATH`。
- **可观测性**：慢调用（≥ 3000ms）写 `adapter_latency`，单次脚本执行超 15s 另记
  `slow_call`（调用已返回，不当崩溃），脚本崩溃写 `spider_crash`（含 traceback 与
  来源 api），能力缺口写 `missing_method`，越界返回值写 `unsafe_result`。
- **已删除方法**（调用返回 `unknown method`）：`config.decrypt` /
  `config.normalize` / `config.mergeRepos` / `site.route` /
  `site.parseHome|parseCategory|parseDetail|parseSearch` / `live.parseM3u` /
  `live.parseEpg` / `parse.resolve`。

## 6. 宿主 IPC 与前端路由

- **40 个 command 闭集**（`src-tauri/src/lib.rs` 注册）：config 13
  （`config_import` / `config_list` / `config_active` / `config_activate` /
  `config_edit` / `config_remove` / `config_refresh` / `config_refresh_settings` /
  `config_set_refresh_interval`、`gh_proxy_state` / `gh_proxy_set` / `gh_proxy_test`、
  `site_set_enabled`）、
  http 1、spider 2（`spider_invoke` / `site_health`）、live 3（`live_parse` /
  `live_epg` / `live_epg_warm`）、proxy 1、play 2（`resolve_play` / `open_external`）、
  parse 1（`parse_resolve`）、douban 2（`douban_meta` / `douban_request`）、
  store 8（收藏 3 + 播放记录 5，单表实现）、logging 4、
  storage 2（`storage_usage` / `storage_clear`）、clipboard 1。
- 前端不得绕过 `src/lib/invoke.ts`；detail / player 的大字段走 `history.state`，
  不进 URL。
- **8 条路由**（`src/routes.tsx`，`createHashRouter`）：首页、收藏、历史、搜索、
  详情、播放、直播、设置；侧栏「播放」常驻，没有会话时落到续播页。
- 权限闭集在 `capabilities/default.json`，由 `tests/offline/capabilities_check.py`
  守住。

## 7. 配置与数据

- `<data>/luma.db` 单库，WAL + 事务写，先提交再刷内存缓存；2.0 起 `PRAGMA user_version`
  闸门，**不迁移旧播放数据**（`favorites`/`history` 分表丢弃，订阅地址保留并重新解析）。
  数据目录 = `%APPDATA%\<identifier>`（`LUMA_DATA_DIR` 可覆盖），无便携布局。
- **playback 行 = 这部剧的状态**：除进度/集/线路外，还带 `rate`（倍速，0 = 没设过
  → 播放侧按 1.0）、`skip_json`（跳过片头/片尾配置的 JSON 文本，空串 = 这次没带、
  `[]` = 用户清空过）与 `prefs_json`（剧个性配置扩展位）。表按 `title_key`（剧名
  归一化：去空白 + 小写）合并同一部剧，所以这些偏好天然跨源共享；写入沿用
  「空值不覆盖已有值」。**收藏只是行上的 `favorite` flag**：收藏没看过的片会新建
  一条无进度记录；取消收藏只置 0（行保留）；清空播放记录只删 `favorite=0`，收藏
  连同进度一起保留。容量裁剪（`MAX_HISTORY`）只裁非收藏行。
- **集用语义集号**：`episode_number` 从集名解析（`第04集` / `第4集` / `EP01` → 4），
  不是数组下标——倒序线路也能正确定位续播与换源同集。
- **双快照**：`imported_json` 是导入原件，永不被运行策略改写；`runtime_json` 由
  `derive_runtime()` 单向派生（含 `enabled` / `disabledReason`）。fan-out / 播放 /
  前端缓存只读 runtime；`find_site` 查 imported 以兼容旧收藏；`spider_invoke` 单点
  补策略检查防绕过。
- 导入链：拉取（10s 超时）→ `infra/textio.rs` 洗 UTF-8 → 解密 → 归一化 → 双快照
  → 站点路由（`.py` → Python，`.js` → QuickJS，`csp_*` / `.jar` → jvm 屏蔽，
  其余 CMS）。
- 本机代理地址还原：TVBox 系订阅会把宿主进程内的转发地址写进 `api` / `lives`
  （`127.0.0.1:<port>/p/0/proxy/<真实地址>`）。那个端口在 Luma 里不存在，导入时
  剥掉外壳直连。带 `do=` / `siteKey=` 的是 spider 回调（含本应用自己的
  `?do=py`），一律不动；还原目标只接受公网 http(s)；直播 `/c/…` 剥完内层仍是
  本机转码服务，保持原样。
- 契约单一真源：`contracts/luma.schema.json` → `src/types/luma.ts` → Rust 序列化，
  `python tests/offline/contract_check.py` 必须 `CONTRACT OK`。

## 8. 播放与本地反代

- 反代 `127.0.0.1:9978`（beta 9977 / debug 9979，与正式版分离）。固定端口被占即
  **启动失败并写明原因**，不回退动态端口——静默回退会让按默认端口兜底的 py/js 脚本
  指向另一个实例或连不上，现场只剩一行 warn。
- **headers 优先级**：爬虫显式 UA/Referer/Cookie > 配置级 `headers[]`（host 精确 →
  通配）> 默认值（`okhttp/3.15` + `{scheme}://{host}/`）。默认值由反代最后补，不提前
  折进 proxyUrl 的 query。
- 播放链路：`playerContent` 取 playUrl + header → 反代重写 m3u8 → ArtPlayer / hls.js
  / mpegts.js → 失败依次：同片换线 → 跨站换源 → 第 4 级嗅探（隐藏 WebView2）；
  没有外部播放兜底。
- **换线只认证据**：`dead` 仅限 4xx/5xx、非 `#EXTM3U`、首分片是图片/HTML；超时算
  `unknown`，连续 3 次才换。慢 ≠ 死。

## 9. 解析链位置（全部进程内纯函数）

| 能力 | 位置 |
| --- | --- |
| 配置解密 | `domain/config/decrypt.rs` |
| 方言归一化 + 多仓合并 + 站点路由 | `domain/config/normalize.rs` |
| 本机代理地址还原（TVBox 系订阅） | `domain/config/deproxy.rs` |
| 导入、双快照、策略派生 | `domain/config/{import,derive}.rs` |
| CMS 采集 | `domain/spider/cms.rs` → `cms_parse.rs` |
| py / js 源返回值归一 | `domain/spider/cms_parse.rs::normalize_spider_result`（js 由 qjs-runner 直接产出契约形状） |
| m3u / txt 直播源 | `domain/live/m3u.rs` |
| XMLTV 节目单 | `domain/live/epg.rs` |
| parse 池解析 | `domain/parse.rs`（command `parse_resolve`） |
| 豆瓣元数据 | `domain/douban.rs` |

外部字节一律经 `infra/textio.rs` 洗成 UTF-8 再解析。

## 10. 日志、诊断与版本

- 日志三通道：`app` / `ui` / `spider`，落 `<data>/logs/<channel>/<channel>.<本地日期>.log`
  （系统时区：行首时间戳与文件名日期同一口径，带偏移量），
  单文件 10 MiB 滚动。`spider` 通道只放脚本异常与 traceback，适配层 JSONL 画在同一
  文件里（`layer: "py-adapter"`）。
- 诊断（设置 → 诊断）：版本、build 号、运行平台、数据目录、日志目录、日志文件、
  当前配置。
- 存储与清理（设置 → 存储与清理）：日志 / 反馈报告 / 封面与页面缓存三项的本机占用
  （字节 + 文件数）与分项手动清理；当天被 writer 持有的日志改为清空内容，剩余量按
  实测量回报。观看历史不在此处清理（入口在历史页）。

## 11. 验收与测试分层

| 层 | 命令 | 基线 |
| --- | --- | --- |
| 离线门禁（12 项） | `python tools/check.py` | 全 PASS：契约 / 版本一致性 / 发布收口 / py 兼容 / py 框架 / 适配层健壮性 / 运行时候检 / py 语法 / 前端单测 / Rust 单测 / qjs-runner 单测 / qjs 引擎(GBK+ds) |
| 前端单测 | `corepack pnpm test` | 全部通过 |
| Rust 单测 | `cargo test --lib` | 全部通过（2 项联网回归 ignored） |
| 验收脚本 | `python tests/acceptance/p0.py`、`p1.py --adapter` | 见脚本输出；p1 适配层阶段只断言 `ping` + `spider.py`，并反向断言已删方法 |
| 窗口探针 | `node tools/run_probes.mjs` | 需 debug 窗口 + CDP 9222 |

单源默认 15s 墙钟超时、配置拉取 10s；fan-out 并发上限 20（`tokio::JoinSet`）。

## 12. 已移除与不适用

- **JVM / jar 全链路**：`sidecars/jre`、`sidecars/java`、`SpiderRunner.java`、`dex2jar`、
  桩类符号守恒、jar 跑通率、`tests/fixtures/jars/`、JDK 17 / `jlink` 已全部删除；
  规格里的「Spider API 12 方法」随之作废。站点仍识别为 `jvm` 并导入即屏蔽。
- **适配层旧方法**：11 → 2（`ping` + `spider.py`），见 §5。
- **命令面**：7 → 39，见 §6。
- **`externalBin`**：只剩 `binaries/qjs-runner`；Python 以 `resources` 随包
  （`sidecars/python-embed`、`sidecars/py`、`sidecars/qjs-assets`）。
- **测试分层**：`tests/acceptance/p2.py` 与 `tests/offline/` 里与 Python 解析链重复的
  脚本（`config_shapes_check.py` / `parse_check.py` / `parse_epg_check.py`）已删除，
  对应断言由 Rust 单测（`normalize.rs` / `m3u.rs` / `epg.rs`）覆盖。
