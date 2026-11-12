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

| 项 | zyfun 3.4.8-rc2 | Luma 1.0.0-alpha |
|---|---|---|
| 桌面壳 | Electron 41.8.0（Node ≥24.11） | Tauri v2 + 系统 WebView2 |
| 前端 | Vue 3.5 + TDesign + Pinia + monaco + i18next（20+ 语言） | React 18 + zustand + 手写 CSS（无 i18n） |
| 代码规模 | 498 个 ts/tsx/vue，**75,874 行**，94 个 `.vue` | 54 个 ts/tsx **9,710 行** + 26 个 rs **8,679 行** ≈ 18.4k 行 |
| 测试 | `src` 下仅 **5 个** `__tests__` 文件 | 145 前端 + 78 Rust + 32 py 兼容 + 6 套探针脚本 |
| 数据层 | drizzle-orm + `@libsql/client`，8 张表 CRUD + 版本迁移（`migrate-3_3_x`） | 手写 SQLite(WAL)，`configs` 双快照 + `meta.active_config_id` |
| 分发 | electron-builder（win/mac/linux，x64/arm64）+ electron-updater 夜间版 | 便携 zip **41.36MB**，无安装器、无自动更新 |
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

---

## 8. 差距清单与建议优先级

按"投入产出 + 是否卡住真实可用率"排序，供拍板：

| 优先级 | 事项 | 现状 | 建议做法 | 成本 |
|---|---|---|---|---|
| **P0** | drpy2 / 用户 JS 源 | quickjs 缺 ESM+cheerio，6 个站全废。**注意：工作区已有未提交改动在做同一件事**——`sidecars/qjs-runner` 增加 ESM resolver + `assets://` 映射，`sidecars/qjs-assets/` 内置 cheerio(356K)/crypto-js/node-rsa/pako/gbk/json5/jinja/template 并带 sha256 清单 | 先验证这版：drpy2 标准模板 + 全站扫描里 6 个 quickjs 站复测；再补 `req`/`localProxy` 垫片、墙钟与内存边界（与 zyfun 的 `workerpool{maxWorkers:1}` 一致：一站点一串行队列） | 中（把在做的收口，比新起一套便宜） |
| **P0** | 配置解密导入 | 只认明文 JSON/变体 | 移植 `aesDecode/base64` 常见包装识别（自写，不抄）；失败给明确原因 | 低（半天） |
| **P1** | T0_XML 适配 | 无 | CMS 家族的 XML 分支，接口面很小 | 低 |
| **P1** | 应用内站点体检 | 只有离线报告 | 把 `scan_site_compat` 结果进库 + PQueue 串行体检 + UI 状态色 | 中 |
| **P1** | 本地 API（只读 + token） | 无 | 复用现有 axum：`/api/sites`、`/api/search`、`/api/play`，必须绑 127.0.0.1 + Bearer token | 中 |
| **P2** | py 依赖在线补齐 | 纯离线 | 内置 `uv` 作为**可选**兜底（默认关），失败仍回落到随包环境 | 中 |
| **P2** | libVLC 兜底 | 只有 mpv | 先做"探测系统 VLC lib 并可选启用"，不随包分发 | 中 |
| **P3** | AList / AppYS / AppGet / XBPQ / XYQ | 无 | 属"扩品类"，非播放链路必需；先把 P0/P1 做完 | 高 |
| **P3** | EPG / 弹幕 / 云同步 / i18n / 自动更新 | 无 | 产品加分项，与"空壳播放框架"的定位要另议 | 高 |

**一句话结论**：zyfun 是"广度换维护成本"的路线（12 个适配器、下载式运行时、AGPL），我们是"深度换确定性"的路线（离线随包、真 JVM、强回归）。**短期最该补的是 JS/drpy 这一块（它直接决定 6~10% 站点的可用率），最不该动的是离线随包与测试体系。**
