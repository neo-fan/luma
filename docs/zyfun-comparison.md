# zyfun 竞品分析与我们项目的差距清单

> 日期：2026-11-12 · 性质：外部项目评估，未改代码
> 对象：https://github.com/Hiram-Wong/zyfun（9.1k star / 1.1k fork / 2276 commits / AGPL-3.0 / 最新提交 2026-06-25 / 版本 3.4.8-rc2）
> 方法：README + 稀疏克隆源码（`src` / `resources` / `docs`）逐文件核对，凡标注「推断」处为源码未直接证实。
> **前提：不考虑跨平台，我们固定 Win11 x64。**

---

## 1. 它是什么

一句话：**Electron + Vue 3 的跨平台影音管家，把 TVBox 生态的各类源抽象成 12 个 adapter，用本地 HTTP 服务当内核实，渲染层只是它的客户端。**

与我们最本质的区别不是 UI 框架，而是**内核位置**：

| | zyfun | 我们（Luma） |
|---|---|---|
| 内核承载 | Node 主进程（TypeScript），能力对外暴露为 `http://127.0.0.1:9978/api/v1/...` | Rust 宿主（Tauri command）+ Python/JVM/qjs 三套 sidecar |
| 渲染层角色 | 纯 HTTP 客户端（`src/renderer/src/api/*.ts` 逐个封 route） | 直接调用 Tauri IPC，共享 Rust 状态 |
| 结果 | 任何外部程序都能当它的前端（swagger/OpenAPI 现成） | 只有自己的前端能用；反代端口只服务播放链路 |

---

## 2. 硬指标对照

| 项 | zyfun 3.4.8-rc2 | Luma（对比时为 1.0.0-alpha，现已发布 1.0.0） |
|---|---|---|
| 桌面壳 | Electron 41.8.0（Node ≥24.11） | Tauri v2 + 系统 WebView2 |
| 前端 | Vue 3.5 + TDesign + Pinia + monaco + i18next（20+ 语言） | React 18 + zustand + 手写 CSS（无 i18n） |
| 代码规模 | 498 个 ts/tsx/vue，**75,874 行**，94 个 `.vue` | 54 个 ts/tsx **9,710 行** + 26 个 rs **8,679 行** ≈ 18.4k 行 |
| 测试 | `src` 下仅 **5 个** `__tests__` 文件 | 145 前端 + 78 Rust + 32 py 兼容 + 6 套探针脚本 |
| 数据层 | drizzle-orm + `@libsql/client`，8 张表 CRUD + 版本迁移（`migrate-3_3_x`） | 手写 SQLite(WAL)，`configs` 双快照 + `meta.active_config_id` |
| 分发 | electron-builder（win/mac/linux，x64/arm64）+ electron-updater 夜间版 | NSIS 安装器（1.0.0 实测 40.38 MiB），无自动更新 |
| 许可 | **AGPL-3.0** | 自建（不受传染） |

体量差 4 倍，但**测试密度差 30 倍以上**——这是两套工程文化的差异，不是能力差异。

---

## 3. 源适配矩阵（差距最集中的地方）

zyfun 的 `src/main/services/FastifyService/routes/v1/film/cms/adapter/` 下 12 个 adapter 一一对应配置里的 `type`：

| type | 适配器 | 实现方式 | 我们 |
|---|---|---|---|
| 0 | `t0Xml.ts` | XML 采集（`?ac=list/videolist/detail`） | ❌ 无 |
| 1 | `t1Json.ts` | CMS JSON（`?ac=...`），兼容 `list/video` 等别名 | ✅ `domain/spider/cms.rs` |
| 6 | `t4Drpys.ts` | 远程 drpy2 脚本（JS 文本） | ⚠️ quickjs 可跑但缺 cheerio/ESM，实际全废 |
| 7 | `t3Drpy.ts` | drpy2 脚本 + 内置 `drpy2.min.js`，跑在 **workerpool 子进程** | ⚠️ 同上 |
| 8 | `t4Catvod.ts` | **不跑 JVM**，POST 到外部 HTTP 服务 `/init /home /category /detail /search /play /action` | ✅ 真 JVM 17 常驻（但只能跑自编桩 jar） |
| 9 | `t3Xbpq/` | 小白 XBPQ 规则引擎，**66KB 内嵌实现** | ❌ 无 |
| 10 | `t3Xyq.ts` | 香雅情规则（23KB） | ❌ 无 |
| 11 | `t3AppYsV2.ts` | AppYS V2 协议 | ❌ 无 |
| 12 | `t3Py.ts` | Python 源 → gRPC 到 uv 拉起的解释器 | ✅ python-embed + stdio JSON-RPC |
| 13 | `t3Alist.ts` | AList 网盘 | ❌ 无 |
| 15/16/17 | `t3AppGet` / `AppQi` / `AppFox` | 各家 App 私有协议 | ❌ 无 |

**结论**：CMS 与 Python 两家都覆盖（我们这部分做得更稳）；**JS 家族（6/7）和规则引擎（9/10/11/13/15/16/17）是我们的大片空白**，而真实配置里这几类占比不低——我们全站扫描 101 站里 quickjs 6 个、jvm 28 个，其余 py/cms 居多，但换一份配置结论就会变。

### 3.1 jar 的真实答案（重要）

zyfun **完全不带 JVM**，`DEFAULT_BINARIES = ['uv','bun','ffmpeg','ffprobe']`。它的 `t4Catvod` 只是把请求转发给用户自己起的一个服务；更关键的是导入 TVBox 配置时：

```ts
// routes/v1/data/utils/data.ts
.filter(item => [0,1,4].includes(item.type) ||
  (item.type === 3 && (['csp_XBPQ','csp_XYQHiker'].includes(type) || item.api.endsWith('.js') || item.api.endsWith('.py'))))
```

**`csp_*.jar` 站点被静默丢弃**。所以我们在这条路上其实是**领先的**：有真 JVM、12 方法路由、源级熔断、singleflight 复用同一个 dex jar，失败也给原因（`docs/site-compat-report.md` 就是证据）。zyfun 是"看不见就不报错"，我们是"跑不了也告诉你为什么"。

### 3.2 Python：离线 vs 在线的正面取舍

| | zyfun | Luma |
|---|---|---|
| 运行时 | 首次运行下载 `uv` 到 `~/.zy/bin`，`uv run main.py` 自动拉 Python | 随包 python-embed 3.11，零下载 |
| 依赖 | `uv sync --default-index https://mirrors.aliyun.com/pypi/simple`（首次联网） | 预装进包，离线可用 |
| 协议 | gRPC `t3py.SpiderService/Exec`，JSON 作 payload，端口 **19979** | stdio 一行一帧 JSON-RPC，常驻单进程，`max_workers=8` |
| 隔离 | ThreadPoolExecutor(4) + `lru_cache(10)` 按 `hash(code)` 复用实例 | 同样按 hash 复用 + 宿主侧 `json_safe()` 净化 |

他们的在线方案对"装完就能用"友好、对"换新源缺库"友好；我们的离线方案对**无网/企业网/便携移动**友好，代价是**用户拿到一个需要新依赖的 py 源就必死**。这是可以互补的，不是必须二选一（见 §6 建议 2）。

---

## 4. 播放与反代：两套不同哲学

| 维度 | zyfun | Luma |
|---|---|---|
| 播放内核 | artplayer + xgplayer(flv/hls/mp4/shaka/subtitle/danmaku) + dashjs + flv.js + mpegts.js + **libVLC（用户提供 libPath;pluginPath）** + 外部播放器 | artplayer + hls.js + mpegts.js；解码失败降级 **mpv**（随包可选，默认不带 117MB） |
| 反代模型 | `/proxy?url=×tamp`：服务端代取 + 内存缓存，spider 用 `POST /proxy` 把内容塞进缓存再拿回 URL；图片走 base64 兜底 | `/proxy?do=py|jar|js` **完整复用 TVBox 协议**，m3u8 分片重写 + `/image` 封面代理 + `live_parse` |
| 嗅探 | puppeteer-core 驱动 **Electron 自己的 Chromium**（`puppeteer-in-electron`），`evaluateOnNewDocument` 注 `navigator.webdriver=false` 反爬，正则表 `m3u8|mpd|mp4|flv|avi|mkv|rm|wmv|mpg|m4a|mp3|tos`，命中即 `req.abort()` 并解析 | 隐藏 WebView2 + `WebResourceRequested`，扩展名白名单，15s 墙钟、成功缓存 10 分钟、串行化 |
| 换源/容错 | 多线路 + 播放器切换；`checkQueue` 逐个体检站点 | 12s stalled watchdog + 线路探活 + 自动换源 + 源级熔断 |

两边都做了嗅探，但**我们复用系统 WebView2（更小、无额外 Chromium），他们复用 Electron 自带 Chromium（更强、能用 puppeteer 生态）**。固定 Win11 前提下，我们的路线不落后；但他们的 `runScript` / `initScript` / `customRegex` 三种可配置嗅探钩子，比我们写死白名单灵活。

反代这块我们明显更强：他们只做 `url=` 单参转发 + 缓存，**不认 TVBox 的 `do=py` 协议**，所以配置里那些 `127.0.0.1:9978/proxy?do=py&...` 的源在他们那边天然跑不通（只能靠自家 spider 重写）。我们是真把这条路由实现了的。

---

## 5. 架构与工程细节值得抄的"思路"

以下都是**思路**，不是代码（AGPL-3.0，禁止引入，见 §7）。

1. **能力 HTTP 化**：`FastifyService` 监听 `0.0.0.0:9978`，路由分组 `v0/proxy`、`v1/film|cms|live|parse|data|file|setting|system`，dev 下自动挂 `/docs`（Swagger UI）。渲染层 `api/film.ts` 只是薄封装。好处：外部播放器、手机遥控、自动化脚本、MCP、二次开发全都免费获得。
2. **drpy2 打包进 worker 进程**：`t3Drpy/worker.ts` 直接 `import drpy from './drpy2.min'`，把 `console.*` 重定向成 `workerpool.workerEmit` 日志，`maxWorkers:1` 保证一个站点一个串行队列。这正面解决我们"quickjs 跑不了 drpy2"的痛点。
3. **依赖预置成 bundle**：`t3Drpy/libs/` 里塞了 `crypto-js / jinja / json5 / jsonpath-plus / node-rsa / pako / polywasm / gb18030 / xxhash-wasm`，所以是"零安装离线可跑"的 JS 运行时 + 少量在线兜底（bun、npm install）。
4. **配置解密**：`tvboxDecryption()` 处理真实世界大量 AES/base64 包装的 `api.json`。我们目前是"解析失败就报错"，这块是低成本高收益。
5. **站点体检队列**：`setting/components/film/index.vue` 用 `PQueue({concurrency:1})` 逐个 `check`，结果直接落库给 UI 标红。我们的 `scan_site_compat.mjs` 是离线报告，缺一个"应用内一键体检"。
6. **导入兜底**：`file/film/auto/:type/*` 扫目录把 `.js` 直接映射成 drpy2 站点（`api` 指向官方 drpy2.min.js，`ext` 指向本地文件），把"一堆脚本文件"变成"一堆站点"。对折腾型用户很友好。

---

## 6. 我们不该学的地方

1. **`origin: '*'` + `host: '0.0.0.0'` 的本地 API**。任何人打开的网页都能打 `127.0.0.1:9978/api/v1/...` 拿到你的配置、站点、历史，还能触发任意源请求（SSRF 到内网）。要抄这个能力，必须先加 token 校验 + 绑定 `127.0.0.1` + Origin 白名单。
2. **首启下载运行时（uv/bun/ffmpeg）**。国内网络 + 公司代理 + 离线环境三连崩；出问题用户看到的是"python 没装好"，而我们看到的是"包坏了"。我们的离线随包是**卖点**，不能退。
3. **12 个 adapter 里一半是站点专属硬编码**（`t3Xbpq` 66KB、`t3Xyq` 23KB、`t3AppGet` 13KB）。这与我们"不内置任何片源/规则"的硬边界直接冲突，也解释了他们为何需要 2276 次提交仍追不上源站变化。
4. **测试薄**。7.6 万行配 5 个测试文件，回归全靠人肉。我们的 145+78+32 是资产，别为了功能速度放弃。

---

## 7. 许可与合规

- zyfun 是 **AGPL-3.0**：任何衍生作品必须 AGPL 开源并保留声明。**不能抄代码、不能拷 `drpy2.min.js` 这类打包产物进我们仓库**（其上游 `hjdhnx/drpy-node` 的许可需单独核实，标注为待确认）。
- 与我们此前的 AVBox 决策一致：**只借鉴行为、字段、交互与思路，不引入代码**，因此不受传染。
- 可合法做的替代：直接用上游开源运行时（如 drpy2 官方仓库 / quickjs 绑定）自行集成，来源与许可单独登记。

### 7.1 决策更新（2026-11-12，用户拍板）

**用户明确：个人自用、不对外分发，版权不构成约束，drpy2 相关限制解除。**

据此调整口径：

| 项 | 原口径 | 现口径 |
|---|---|---|
| 拷贝 `drpy2.min.js` 等打包产物入库 | 禁止 | **允许**（个人自用） |
| AGPL 传染 | 视为红线 | 本地桌面程序、不 conveying、不对外提供网络服务 → 不触发；**仅当对外分发安装包或做联网服务时才需重评** |
| 第三方许可登记 | 必须 | 仍建议在 `docs/` 记录来源与版本，方便日后想分发时一次性回滚（不是法务要求，是可运维性） |

> 一次说清边界：**自己用 = 无义务；给别人用（发 zip、上架、开服）= 义务立刻回来。** 所以代码里不做「开源合规声明」这类仪式，但每个第三方文件仍登记来源/版本/字节数，将来要分发时能 10 分钟内定位并替换。

**但请注意：版权放开 ≠ drpy2 就能跑了。** 这是两件独立的事，见 §9.5。

---

## 8. 差距清单（已按 2026-11-12 晚代码现状校正）

> 下表原为初版结论，其中两项与实测代码不符，在此**更正**，避免按错误前提排期。

| 事项 | 初版结论 | 实测代码现状 | 更正 |
|---|---|---|---|
| 配置解密 | "只认明文，需半天补齐" | `sidecars/py/decrypt.py` 已有 6 级链路：`<image>**` seed / 明文（含 JSONC 去注释+尾逗号）/ `****`+XOR / 数字前缀+gzip / base64 / gzip+base64 | 主体已做，缺口只是 zyfun 那两种 **AES** 包装，不是从零 |
| qjs 串行化 | "需补 workerpool{maxWorkers:1} 式串行队列" | `quickjs.rs` 是 **单常驻 runner + 全局 tokio Mutex**（`RUNNER: OnceLock<Mutex<Option<Runner>>>`），比一站点一串行更严格 | 已具备，无需改动 |
| JS/drpy | "6 个站全废" | 已提交 `11e0b34`/`b78bbc4`：ESM resolver + 8 个内置资源 + `req`/`local`/`md5X` 垫片，真实 6 源里 **4 个出数据** | 剩余是覆盖率与报告口径，不是能力缺失 |

---

## 9. 可借鉴项落地计划（含工作量）

**口径**：工作量为「含自测」的净开发日（1d ≈ 6 小时有效编码 + 验证），不含打包发版；估算依据是同类改动在本仓库的历史实际耗时（如 `do=py` 反代 1d、嗅探 1.5d、JS 解禁 2.5d）。

### 9.1 值得做（按顺序，前一阶段不完成不启下一阶段）

| # | 借鉴点 | 我们的缺口 | 落点（文件/模块） | 工作量 | 验收标准 |
|---|---|---|---|---|---|
| 1 | **报告口径校正**（不是抄，是还债） | `docs/site-compat-report.md` 仍写"JS 源暂不支持"，已与代码不符 | `tools/scan_site_compat.mjs` 复跑 + 重生成报告 | **0.5d** | 6 个 quickjs 站有真实四能力结果；报告"导入侧屏蔽"从 34 降到 28 |
| 2 | **配置解密补 AES 分支** | 缺 `[A-Z0-9]{8}**` 任意位置匹配、`2423` 段 AES-CBC（key 自 `$#…#$`、iv 取尾 13 位补 `0`）、用户 `configKey` 的 AES-ECB | `sidecars/py/decrypt.py` 加两级；`config.rs` 已透传 `configKey` 则只需 py 侧 | **0.5d** | `tests/e2e/py_compat_check.py` 增 3 例；真实配置样本解密成功率不下降 |
| 3 | **T0_XML 适配** | 无 XML 采集（`?ac=list/videolist/detail`） | 新 `src-tauri/src/domain/spider/xml.rs` + `runtime_for()` 增加分支 | **0.5d** | fixture 单测 6 条；扫描报告新增 type=0 站点可列出内容 |
| 4 | **应用内站点体检** | 只有离线 `scan_site_compat.mjs`，用户拿不到 | Rust command `check_sites`（并发 1、单站 15s、复用 `homeContent`）+ `site_health` 表 + 设置页状态色/重试 | **2d** | 101 站全量体检 ≤ 8 分钟可中断；结果落库重启仍在；UI 三色（可用/空/失败）与原因一致 |
| 5 | **本地脚本目录自动成站点** | 无（用户须手改配置） | 导入流程扫描 `data/js`、`data/py`，`.js`→quickjs 站点（`api` 指内置 drpy2）、`.py`→python 站点 | **1d** | 放两个脚本进目录→导入后多两个站点且能搜到；不写回用户原始配置文件 |
| 6 | **只读本地 API + token**（借"能力 HTTP 化"思路，不借它的安全配置） | 9978 只有 `/proxy` `/image` `/health` | 复用 axum 加 `/api/v1/{sites,search,detail,play}`；**强制绑 127.0.0.1**、Bearer token（首次启动生成存 db）、Origin 白名单、只读 | **2d** | 无 token 返回 401；`curl` 带 token 能搜出结果；外部网页 fetch 被 CORS/Origin 拦 |
| 7 | **嗅探可配置钩子** | 扩展名白名单写死 | `sniff.rs` 读站点级 `sniffScript/sniffRegex`，注入 `initScript`、命中前 `runScript` | **1d** | 至少 1 个需点击才出 m3u8 的站，注入脚本后可命中；无配置时行为与现在完全一致 |
| 8 | **py 依赖在线补齐（可选，默认关）** | 纯离线，新源缺库必死 | 设置项 `allowOnlineDeps`；开启时才允许 `uv`/`pip` 装到 `data/pydeps`，失败回落随包 | **2d** | 默认关时进程不发任何外部请求；开启后装一个缺库源成功、断网时报明确错误 |

**合计 9.5d**（1~3 为一批 1.5d，4~5 一批 3d，6 一天 2d，7~8 一批 3d）。

### 9.2 视情况做（先验证价值再动手）

| 借鉴点 | 前置判断 | 工作量 |
|---|---|---|
| libVLC 兜底 | 我们已有 mpv 兜底；先统计真实触发率，<1% 就不做 | 1d（仅探测系统 VLC，不随包） |
| XBPQ / XYQ 规则引擎 | 先统计目标配置里 type=9/10 的占比；占比 <5% 不做（实现成本高、规则易失配） | 各 5~8d |
| AList | 只对网盘用户有价值，与"空壳播放框架"定位需产品决策 | 3~5d |
| i18n / EPG / 弹幕 | 产品加分项，非可用率问题 | 各 2~4d |

### 9.3 明确不做

| 不做 | 理由 |
|---|---|
| 12 个 adapter 里的站点专属硬编码（`t3Xbpq` 66KB / `t3Xyq` 23KB / `t3AppGet`） | 与"不内置任何片源/规则"硬边界冲突，且解释了它 2276 次提交仍追不上源站变化 |
| `origin:'*'` + `host:'0.0.0.0'` | 本机任意网页可读配置、可触发任意源请求（SSRF 到内网）。要做 API 就必须先加 token + 绑回环 |
| 首启下载运行时（uv/bun/ffmpeg） | 国内网络/代理/离线三连崩；离线随包是卖点 |
| AppYS / AppGet / AppQi / AppFox 私有协议 | 各家 App 逆向协议，维护成本极高，无公开文档 |

> ~~抄 `drpy2.min.js` 打包产物~~：已按 §7.1 用户决策解除（个人自用）。改为 §9.5 的独立子计划。

### 9.4 一个待核实风险

`decrypt.py` 的 `****` 分支用 `KEY = b"tvbox-stub-key"`（命名上像占位实现）。真实 TVBox 生态的 `****` 包装算法需拿**至少 2 份真实配置**验证；若不匹配，第 2 项（解密）要从 0.5d 上调到 1.5d，且优先级升到最前。**这一条建议先做，成本 0.2d（找配置试一次）。**

### 9.5 drpy2 专项（版权解除后重排）

**先说结论：版权只是最外层的一道门，拆掉它之后里面还有三道。**

对 zyfun 那份产物的实测（`t3Drpy/`，146,927 B）——它**不是**可直接拷过来就用的独立引擎：

```js
import { cheerio, 模板, gbkTool, CryptoJS, JSEncrypt, NODERSA, pako,
         JSON5, JSONPath, jinja, WebAssembly, TextEncoder, TextDecoder, WXXH }
  from './drpy-core-lite.min';
import { batchFetch, joinUrl, local, pd, pdfa, pdfh, req } from './inject';
```

它依赖同目录 `drpy-core-lite.min.js`（1,230 B 胶水）与 `inject.ts`（他们自己写的宿主垫片，由 electron-vite 打包时内联）。**换句话说：它跑得起来是因为 zyfun 给它配了一套宿主；换个宿主就得重写那层 `inject`。**

> **实测修正（同日）**：拿 `cluntop/tvbox` 的真实引擎 `lib/drpy2.min.js`（67 KB）做探针后发现，
> `pdfh`/`pdfa`/`pd`/`jsp` 是**引擎自己定义的**，`MY_URL` 也自声明——宿主根本不需要提供它们。
> 真正挡住 drpy2 的是另外三件事：Web 全局缺失、`req` 的**同步语义**、以及引擎自己的
> `getProxyUrl()` 依赖 `getProxy(boolean)`。详见 D2 行与 `docs/js-support.md` §5.5。

| # | 子项 | 为什么必须 | 工作量 | 验收 |
|---|---|---|---|---|
| D1 | **`do=js` 本地代理路由** | drpy2 规则大量返回 `getProxyUrl()` 生成的 `127.0.0.1:<port>/proxy?do=js&...`。我们现在 `do=py` 有、`do=js` 直接报「runtime 不支持 proxy」→ 这类站点**能搜到但一律播不出** | **1.5d** | 一个返回 `do=js` 的规则，`proxy` 方法被调到、m3u8 能 200 返回并被重写；`do=jar` 仍明确报不支持 |
| D2 | **运行时兼容（Web 全局 + `req` 同步语义）** | 真引擎自带 `pdfh/pdfa/jsp`，宿主要补的是 `TextEncoder`/`TextDecoder`/`URLSearchParams`，以及**把 `req` 从 Promise 改成同步可读**——drpy2 写 `req(url).content`，拿到 Promise 就等于恒空列表 | **0.5d**（原估 1.5d） | 真实引擎 + 真实 CMS，`homeVideo/category/search` 各返回 20 条真实数据 |
| D3 | **引擎随包（离线兜底）** | 现在引擎靠站点 `api` 远程加载（实测能加载，8 个 import 全过）。仅当远程挂了/被墙才需要本地副本 | **0.5d** | 断网时 drpy2 站点仍能启动；资源清单登记来源+版本+sha256 |
| D4 | **class-based `Spider` 规范对齐** | 新版 FongMi 用 class 构造，我们只做粗粒度 `new Spider(ext)` | **1d** | fixture 里 class 形态能 `init` 并被短名派发命中 |

**合计 4.5d → 实际 D1+D2+D3 已完成，只剩 D4 约 1d**，顺序 **D1 → D2 → D4 → D3**（D1 是「搜到播不出」的元凶，D3 收益最低）。

> **D1 已交付（2026-11-12）**：`/proxy?do=js` 接通 + `getProxyUrl()` 返回宿主真实端口，
> `p1.py --adapter` 21/21、`cargo test --lib` 84/84、`pnpm test` 145/145。细节见
> `docs/js-support.md` §5.4。
>
> **D2 已交付（2026-11-12，实际 0.5d 而非 1.5d）**：补 Web 全局 + 修 `req` 同步语义 +
> 修 `console.log(undefined)` 中断脚本 + 修 `atob` padding 泄漏 + 补 `getProxy`。真引擎跑真实
> CMS 三条链路各 20 条数据。`p1.py --adapter` **22/22**（新增 9 条断言）。细节见
> `docs/js-support.md` §5.5。
>
> **D3 已交付（2026-11-12）**：`sidecars/qjs-assets/js/lib/drpy2.min.js`（67,385 B，
> sha256 登记）作为离线兜底；`source_for()` 在远程 404 / 非脚本 HTML / 域名不可达三种情况下
> 回落，且**不是已知引擎时绝不覆盖用户 spider**。关键点：引擎的相对 import 若按死掉的 `api`
> 解析就会全拼到死链上，实际验证「本地引擎 + 死域名 + 真实规则」仍各出 20 条数据。
> `p1.py --adapter` **23/23**、`cargo test --lib` 87/1 ignored。细节见 `docs/js-support.md` §5.6。
> **剩余仅 D4。**

**两个不要误解的点：**

1. **KTV 那个站跑不起来不是我们的问题**：它的 `ext` 指向上游并不存在的 `./js/drpy2.js`（§3.2 已记录）。修法只有「站点侧补文件」或「我们硬编码一份规则」——后者与「不内置片源/规则」冲突，即使版权允许也不做，只在报告里如实标注「上游规则缺失」。
2. **引擎随包 ≠ 站点可用**：D3 只解决「远程引擎取不到」，解决不了 D2 的垫片缺口。先做 D3 会有「包变大了但站点还是空」的错觉。


**一句话结论**：zyfun 是"广度换维护成本"（12 适配器、下载式运行时、AGPL），我们是"深度换确定性"（离线随包、真 JVM、强回归）。**真正值得抄的只有 4 件事——体检、解密兜底、XML、只读 API（9.5d）；drpy2 单列 4.5d（D1→D2→D4→D3），其中 `do=js` 代理是「搜到播不出」的元凶，优先级高于随包引擎。最不该动的是离线随包与测试体系。**
