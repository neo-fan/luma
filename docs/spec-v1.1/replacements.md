# v1.1 云端规格书 · 逐条替换清单（可直接粘贴）

> 对象：TVBox 桌面客户端实现规格书（内部设计文档，不随仓库分发）
> 输入：R1~R11 的替换文本 + 全部联动修改；已确认「全按推荐」。（原修订建议文档不随开源仓库分发。）
> 只保留**最终采纳方案**：R4 取方案 A、R6 取线程池（8 workers）、R7 取目标白名单（不做一次性 token）、R8 取轻量校验、R11 取方案 A；已删除所有备选方案表述与待决策字样。
> 用法：每个条目给出「位置 / 原文 / 替换为」三段。「替换为」代码块内即写入云端的**最终文本**（不含外层 ```` 围栏），按本文末尾「建议写入顺序」执行。
> 约定：标注「（v1.0 无对应内容，本项为新增）」的条目的「原文」为空，直接在指定位置插入「替换为」内容。
>
> **状态更新（2026-11-08 收尾）**：用户确认「全按推荐」后要求「不用改云端规格书，全部在本地」。本清单现作为**本地 v1.1 基线文本**（与 `CHANGELOG.md` 同为唯一实现依据）；文中「写入云端」「云端编辑器」等措辞是生成时的历史语境，实际不再对云端执行任何写入。云端 doc 节点曾被历史写入 v1.1，只读参考、不作为依据。

---

## 文首

### 文首-1 版本号与修订说明（v1.0 → v1.1）

- **位置**：第 1 个 `<Heading level="1">`（标题）与其后的 `<BlockQuote>` 之间。
- **原文**：

````text
TVBox 桌面客户端 · 实现规格书 v1.0
````

- **替换为**：

````markdown
TVBox 桌面客户端 · 实现规格书 v1.1

v1.1 修订说明（2026-11-08）：按 R1~R11 修订——12.2 改为累积断言矩阵；7.1 的 7 个 command 为唯一真源；区分 6.2 `SpiderMethod`(6) / 7.2 协议方法(11) / 8.4 Spider API(12) 三套集合；JS 下沉为 `qjs-runner` sidecar 且 Rust `process.rs` 为唯一拉起主体；新增 7.2.1「并发与取消语义」（线程池 8 workers）与 7.5.1「动态端口注入机制」（目标白名单）；契约以 `contracts/tvbox.schema.json` 为唯一真源；「目标 jar」为自编模板 jar；JDK 统一 17；体积改为 `docs/size-report.md` 实测口径。实现依据以云端 v1.1 为准。
````

---

## 0 节 · 给实现 Agent 的工作指令（必读）

### 0-1 第 1 条：补 `N/A` 门禁语义（R1 联动）

- **位置**：0 节第 1 条 `<NumberedList>`（「严格按 P0 → P1 → P2 → P3 顺序实施……」）。
- **原文**：

````text
严格按 P0 → P1 → P2 → P3 顺序实施，不得跳阶段。每个任务 `T-xx` 完成后必须跑其验收断言，不通过不得进入下一任务。
````

- **替换为**：

````markdown
严格按 P0 → P1 → P2 → P3 顺序实施，不得跳阶段。每个任务 `T-xx` 完成后必须跑其验收断言，不通过不得进入下一任务。阶段脚本仅断言本阶段已交付能力；未交付能力按 12.2 标 `N/A`，不视为通过，也不计入 FAIL。
````

### 0-2 第 6 条：补「目标 jar」定义（R9）

- **位置**：0 节第 6 条 `<NumberedList>`（「修改或新增 `com.github.catvod.**` 下的桩类前……」），在该条目后追加一段。
- **原文**：

````text
修改或新增 `com.github.catvod.**` 下的桩类前，必须先对目标 jar 实跑 `javap -p -s` 并做符号守恒比对；签名以实测为准，第 7.4 节仅为基线。
````

- **替换为**：

````markdown
修改或新增 `com.github.catvod.**` 下的桩类前，必须先对目标 jar 实跑 `javap -p -s` 并做符号守恒比对；签名以实测为准，第 7.4 节仅为基线。

本文档的「目标 jar」在仓库内指 `tests/fixtures/jars/` 下的自编模板 jar（纯 class 与 dex 两种形态）。用户在本机另行提供 jar 时，实现 Agent 应先对该 jar 实跑 `javap -p -s`、输出签名差异报告，再决定是否调整桩类；该 jar 不得入库、不得提交、不得写入 fixture。
````

---

## 2 节 · 环境与前置依赖

### 2-1 JDK 行（R10）

- **位置**：2 节环境表 `JDK` 行的「版本 / 说明」单元格。
- **原文**：

````text
17（仅打包期做 `jlink` 裁剪）；开发期可探测用户已有 JDK 8 直接跑 jar
````

- **替换为**：

````markdown
**JDK 17（开发、编译、`jlink` 裁剪统一使用 17）**；不探测、不兼容 JDK 8。用户机器无 JDK 17 时，README 指引安装或直接使用随包裁剪 JRE。
````

---

## 3 节 · 技术栈与依赖清单

### 3-1 3.2 `rquickjs` 用途（R4 方案 A 联动）

- **位置**：3.2 Rust 依赖表 `rquickjs` 行的「用途」单元格。
- **原文**：

````text
JS 源运行时（进程内）
````

- **替换为**：

````markdown
JS sidecar（`qjs-runner`）内运行时，主进程不执行第三方 JS
````

---

## 4 节 · 架构

### 4-1 4.1 进程拓扑图（R2 + R4 方案 A + R5）

- **位置**：4.1 的 `<Code>` 代码块，整块替换。
- **原文**：

````text
```
┌─ Rust / Tauri Core（唯一原生主进程）───────────────────────────┐
│  #[command] 层                                                 │
│   ├ config_import / config_list                                │
│   ├ http_fetch                                                 │
│   ├ spider_invoke  ──► SpiderRuntime::route()                  │
│   │                     ├ cms.rs     进程内（Rust）             │
│   │                     ├ quickjs.rs 进程内（rquickjs context）  │
│   │                     ├ python.rs  ──► Python sidecar         │
│   │                     └ jvm.rs     ──► JVM sidecar            │
│   ├ resolve_play / open_external                               │
│   ├ bridge.rs    stdio JSON-RPC 客户端（连 Python 适配层）        │
│   ├ proxy.rs     唯一本地 HTTP 反代，绑定 127.0.0.1:9978         │
│   └ process.rs   进程池 + 墙钟超时 + Job Object                  │
│        │ Tauri IPC（WebView2 message passing，非 HTTP）           │
│        ▼                                                        │
│   WebView2 进程：React SPA + hls.js / mpegts.js                  │
│        │ 降级                                                    │
│        └──► mpv.exe（--input-ipc-server=\\.\pipe\tvbox-mpv）     │
└─────────────────────────────────────────────────────────────────┘
```
````

- **替换为**：

````text
```
┌─ Rust / Tauri Core（唯一原生主进程）───────────────────────────┐
│  #[command] 层                                                 │
│   ├ config_import / config_list / config_remove                │
│   ├ http_fetch                                                 │
│   ├ spider_invoke  ──► SpiderRuntime::route()                  │
│   │                     ├ cms.rs     进程内（Rust，宿主自研）     │
│   │                     ├ quickjs.rs ──► qjs-runner sidecar      │
│   │                     ├ python.rs  ──► Python sidecar         │
│   │                     └ jvm.rs     ──► JVM sidecar            │
│   ├ resolve_play / open_external                               │
│   ├ bridge.rs    stdio JSON-RPC 客户端（连 Python 适配层）        │
│   ├ proxy.rs     唯一本地 HTTP 反代，绑定 127.0.0.1:9978         │
│   └ process.rs   唯一拉起主体：进程池 + 墙钟超时 + Job Object     │
│        │ Tauri IPC（WebView2 message passing，非 HTTP）           │
│        ▼                                                        │
│   WebView2 进程：React SPA + hls.js / mpegts.js                  │
│        │ 降级                                                    │
│        └──► mpv.exe（--input-ipc-server=\\.\pipe\tvbox-mpv）     │
└─────────────────────────────────────────────────────────────────┘
```
````

### 4-2 4.3 数据流（首页聚合）（R4 方案 A + R6 联动）

- **位置**：4.3 的 `<Code>` 代码块，整块替换。
- **原文**：

````text
```
UI invoke('spider_invoke', {siteKey:'all', method:'homeContent'})
  → Rust 读 ConfigSnapshot，取所有可用站点
  → tokio JoinSet 并发分发（每源 15s 墙钟超时）
      ├ CMS  → reqwest GET + Python normalizeHome
      ├ py   → Python sidecar / py 子进程
      ├ js   → rquickjs context
      └ jar  → JVM sidecar JSON-RPC
  → 结果统一为 ResultPage → 去重/归一化片名 → UI 渲染
任一源超时或崩溃：只标记该源不可用，不影响其他源。
```
````

- **替换为**：

````text
```
UI invoke('spider_invoke', {siteKey:'all', method:'homeContent'})
  → Rust 读 ConfigSnapshot，取所有可用站点
  → tokio JoinSet 并发分发（每源 15s 墙钟超时）
      ├ CMS  → reqwest GET + Python normalizeHome
      ├ py   → Python sidecar / py 子进程
      ├ js   → qjs-runner sidecar
      └ jar  → JVM sidecar JSON-RPC
  → 结果统一为 ResultPage → 去重/归一化片名 → UI 渲染
任一源超时或崩溃：只标记该源不可用，不影响其他源。
所有走适配层的请求受 7.2.1「并发与取消语义」约束（线程池、取消帧、epoch 隔离、迟到帧回收）。
```
````

---

## 5 节 · 工程目录（完整树，含职责）

### 5-1 目录树（R2 + R4 方案 A + R5 + R8 + R9 + R11）

- **位置**：5 节的 `<Code>` 代码块（完整工程树），整块替换。
- **原文**：

````text
```
tvbox-desktop/
├─ README.md                         # 免责声明 + 构建/运行说明
├─ package.json · pnpm-lock.yaml · vite.config.ts · tsconfig.json · index.html
├─ src/                              # React SPA
│  ├─ main.tsx                       # 入口
│  ├─ App.tsx                        # 路由 + 布局 + 键盘导航
│  ├─ styles.css                     # 大屏/桌面样式，rem + clamp，PerMonitorV2 友好
│  ├─ lib/
│  │  ├─ invoke.ts                   # 唯一 IPC 入口（强类型封装）
│  │  └─ normalize.ts                # 片名归一化、别名剥离、多源合并
│  ├─ types/tvbox.ts                 # 归一化数据契约（见 6.2）
│  ├─ store/useApp.ts                # zustand：配置、站点、收藏、历史
│  └─ pages/
│     ├─ Home.tsx                    # 首页聚合
│     ├─ Browse.tsx                  # 分类/筛选
│     ├─ Search.tsx                  # 跨源聚合搜索
│     ├─ Detail.tsx                  # 详情 + 选集 + 换源
│     ├─ Player.tsx                  # hls.js / mpegts.js / 转外部播放器
│     ├─ Live.tsx                    # 直播分组 + 播放
│     └─ Settings.tsx                # 配置导入/管理、代理、播放偏好
├─ src-tauri/
│  ├─ Cargo.toml · build.rs · tauri.conf.json
│  ├─ capabilities/default.json      # 最小权限白名单（见 11.1）
│  ├─ icons/
│  └─ src/
│     ├─ main.rs                     # 二进制入口
│     ├─ lib.rs                      # tauri::Builder + command 注册
│     ├─ commands.rs                 # 6 个 command 实现
│     ├─ error.rs                    # AppError + 错误码
│     ├─ config.rs                   # 订阅拉取、快照、多仓合并调度
│     ├─ http.rs                     # reqwest 封装（UA/Referer/Cookie/重定向/超时）
│     ├─ bridge.rs                   # Rust ↔ Python stdio JSON-RPC 客户端
│     ├─ proxy.rs                    # 127.0.0.1:9978 反代
│     ├─ process.rs                  # 进程池 + Job Object + 墙钟超时
│     └─ spider/
│        ├─ mod.rs                   # SpiderRuntime trait + route() + SpiderMethod
│        ├─ cms.rs                   # type 0/1/4，进程内
│        ├─ python.rs                # py 源（经适配层子进程）
│        ├─ quickjs.rs               # JS 源，进程内白名单 context
│        └─ jvm.rs                   # jar 源（JVM sidecar + dex2jar + 桩）
├─ sidecars/
│  ├─ python-embed/                  # python.exe + python311.dll + Lib/（分发）
│  ├─ py/
│  │  ├─ main.py                     # stdio JSON-RPC 主循环（stdout 只走协议）
│  │  ├─ decrypt.py                  # 解密链
│  │  ├─ normalize.py                # 方言归一化
│  │  ├─ cms.py                      # CMS 字段映射（JSON/XML）
│  │  ├─ live.py                     # m3u / txt 解析
│  │  ├─ sniff.py                    # parses 嗅探规则
│  │  └─ pyrun.py                    # TVBox py 源加载器（子进程执行）
│  ├─ jre/                           # jlink 裁剪产物（P2 生成）
│  ├─ java/
│  │  ├─ stubs-src/                  # Android/catvod 桩类源码（P2）
│  │  ├─ SpiderRunner.java           # JSON-RPC 桥：加载 jar → 反射调方法
│  │  └─ stubs.jar · dex2jar/
│  └─ mpv/                           # 可选，P3
└─ tests/
   ├─ stub_server.py                 # 本地桩服务器（见 12.1）
   ├─ fixtures/configs/              # 各类配置样本（全部指向 127.0.0.1）
   └─ e2e/                           # 端到端断言脚本
```
````

- **替换为**：

````text
```
tvbox-desktop/
├─ README.md                         # 免责声明 + 构建/运行说明
├─ package.json · pnpm-lock.yaml · vite.config.ts · tsconfig.json · index.html
├─ src/                              # React SPA
│  ├─ main.tsx                       # 入口
│  ├─ App.tsx                        # 路由 + 布局 + 键盘导航
│  ├─ styles.css                     # 大屏/桌面样式，rem + clamp，PerMonitorV2 友好
│  ├─ lib/
│  │  ├─ invoke.ts                   # 唯一 IPC 入口（强类型封装）
│  │  └─ normalize.ts                # 片名归一化、别名剥离、多源合并
│  ├─ types/tvbox.ts                 # 归一化数据契约（见 6.2）
│  ├─ store/useApp.ts                # zustand：配置、站点、收藏、历史
│  └─ pages/
│     ├─ Home.tsx                    # 首页聚合
│     ├─ Browse.tsx                  # 分类/筛选
│     ├─ Search.tsx                  # 跨源聚合搜索
│     ├─ Detail.tsx                  # 详情 + 选集 + 换源
│     ├─ Player.tsx                  # hls.js / mpegts.js / 转外部播放器
│     ├─ Live.tsx                    # 直播分组 + 播放
│     └─ Settings.tsx                # 配置导入/管理、代理、播放偏好
├─ src-tauri/
│  ├─ Cargo.toml · build.rs · tauri.conf.json
│  ├─ capabilities/default.json      # 最小权限白名单（见 11.1）
│  ├─ icons/
│  └─ src/
│     ├─ main.rs                     # 二进制入口
│     ├─ lib.rs                      # tauri::Builder + command 注册
│     ├─ commands.rs                 # Tauri command 实现（清单见 7.1）
│     ├─ error.rs                    # AppError + 错误码
│     ├─ config.rs                   # 订阅拉取、快照、多仓合并调度
│     ├─ http.rs                     # reqwest 封装（UA/Referer/Cookie/重定向/超时）
│     ├─ bridge.rs                   # Rust ↔ Python stdio JSON-RPC 客户端
│     ├─ proxy.rs                    # 127.0.0.1:9978 反代（目标白名单见 7.5）
│     ├─ process.rs                  # 唯一拉起主体：进程池 + Job Object + 墙钟超时
│     └─ spider/
│        ├─ mod.rs                   # SpiderRuntime trait + route() + SpiderMethod
│        ├─ cms.rs                   # type 0/1/4，进程内（宿主自研）
│        ├─ python.rs                # py 源（经适配层子进程）
│        ├─ quickjs.rs               # JS sidecar 协议适配（qjs-runner 客户端）
│        └─ jvm.rs                   # jar 源（JVM sidecar + dex2jar + 桩）
├─ contracts/
│  └─ tvbox.schema.json              # 归一化契约唯一真源（见 6.2）
├─ sidecars/
│  ├─ python-embed/                  # python.exe + python311.dll + Lib/（随包分发）
│  ├─ qjs-runner/                    # JS sidecar（rquickjs，每请求独立 context）
│  ├─ py/
│  │  ├─ main.py                     # stdio JSON-RPC 主循环（stdout 只走协议）
│  │  ├─ decrypt.py                  # 解密链
│  │  ├─ normalize.py                # 方言归一化
│  │  ├─ live.py                     # m3u / txt 解析
│  │  ├─ sniff.py                    # parses 嗅探规则
│  │  └─ pyrun.py                    # TVBox py 源加载器（子进程执行）
│  ├─ jre/                           # jlink 裁剪产物（P2 生成）
│  ├─ java/
│  │  ├─ stubs-src/                  # Android/catvod 桩类源码（P2）
│  │  ├─ SpiderRunner.java           # JSON-RPC 桥：加载 jar → 反射调方法
│  │  └─ stubs.jar · dex2jar/
│  └─ mpv/                           # 可选，P3
├─ docs/
│  └─ size-report.md                 # 实测体积报告（T-32 前产出，见 13 节）
└─ tests/
   ├─ stub_server.py                 # 本地桩服务器（见 12.1）
   ├─ fixtures/
   │  ├─ configs/                    # 各类配置样本（全部指向 127.0.0.1）
   │  └─ jars/                       # 自编模板 jar：template-class.jar / template-dex.jar
   └─ e2e/
      ├─ contract_check.py           # 三端字段名比对（见 6.2 / T-04 / T-13）
      └─ p0.py · p1.py · p2.py · p3.py  # 累积式阶段断言（见 12.2）
```
````

---

## 6 节 · 数据契约

### 6-1 6.2 `AppError` 定义（R8）

- **位置**：6.2 TS 代码块内 `AppError` 一行。
- **原文**：

````text
export interface AppError { code: string; message: string; cause?: string; }
````

- **替换为**：

````ts
export interface AppError {
  code: string;
  message: string;
  cause?: string;
  rawSaved?: boolean;       // 7.2 错误帧：原始配置是否已留存便于诊断
  details?: Record<string, unknown>;
}
````

### 6-2 6.2 契约真源段（R8，新增）

- **位置**：6.2 TS 代码块之后、「6.3 统一错误码」标题之前，新增一个段落。
- **原文**：（v1.0 无对应内容，本项为新增）
- **替换为**：

````markdown
归一化契约以 `contracts/tvbox.schema.json` 为唯一真源。`src/types/tvbox.ts`、`error.rs` 的 serde struct、Python 输出字段必须与之对齐；`tests/offline/contract_check.py` 比对三端字段名，作为 T-04 与 T-13 的必跑断言。新增字段须先改 schema，再改三端实现与验收脚本。
````

---

## 7 节 · 接口契约

### 7-1 7.1 command 清单说明（R2，新增段）

- **位置**：7.1 两个代码块（Rust / TS）之后、「约束」段之前或之后，新增一个说明段。
- **原文**：（v1.0 无对应内容，本项为新增）
- **替换为**：

````markdown
以上 7 个 command 为完整清单，是新增系统能力的唯一登记处；新增 command 须同步更新本清单、`lib.rs` 注册与 `src/lib/invoke.ts`，并在 `capabilities/default.json` 复核权限。
````

### 7-2 7.2 方法集合说明（R3，表后补）

- **位置**：7.2「请求方法表」之后、「帧格式」之前，新增一个说明段。
- **原文**：（v1.0 无对应内容，本项为新增）
- **替换为**：

````markdown
本表共 7 个业务方法 + `ping`，是 Rust ↔ Python **适配层协议面**（1.0.5 起 `site.parseHome/parseCategory/parseDetail/parseSearch` 随 CMS/归一化搬进 Rust 删除，适配层只执行第三方源脚本；再调用 `site.parse*` 返回 `unknown method`）。6.2 的 `SpiderMethod`（6 个对外方法）与 8.4 的 **Spider API**（12 个 jar 反射方法）是另外两个集合，三者数量不得互相套用。新增或删改方法须同步本表、T-14 与 `bridge.rs` 分发实现。
````

### 7-3 7.2.1 并发与取消语义（R6，新增小节，线程池 8 workers）

- **位置**：7.2 末尾（「帧格式」JSON 代码块之后）、7.3 标题之前，新增一个 `###` 小节。
- **原文**：（v1.0 无对应内容，本项为新增）
- **替换为**：

````markdown
### 7.2.1 并发与取消语义

- 请求 `id` 由 Rust 侧生成，进程生命周期内全局单调、绝不复用；适配层重启后 id 带 epoch 前缀
  （如 `e3-42`），旧 epoch 的迟到帧一律丢弃。
- Python 主循环用线程池并发处理纯计算型方法（`config.*` / `live.parseM3u` /
  `parse.resolve`），默认 `max_workers = 8`，可配置；`spider.py` 一律转独立子进程，不占主循环。
  主循环只做读帧、派发、写帧，禁止在协议线程内做阻塞计算。
- 增加取消帧：`{"id":"<new>","method":"__cancel__","params":{"targetId":"<old>"}}`。
  Python 对未开始执行的请求直接丢弃；已执行中的纯计算任务标记取消，返回时不写 stdout；
  `spider.py` 由 Rust 直接强杀对应子进程（Job Object）。
- Rust 侧维护 `HashMap<id, oneshot::Sender>`。超时后将该 id 标记为 orphan，其迟到帧丢弃并写
  debug 日志；适配层崩溃或重启时，把所有 in-flight 一次性回 `RUNTIME_RESTART` 错误并清空映射。
- 墙钟超时以 Rust 侧 `tokio::time::timeout` 为准；对 `spider.py` 子进程必须同步执行进程级强杀，
  禁止只取消 future。
- 4.3 的 CMS 归一化在宿主进程内完成（`domain/spider/cms_parse.rs`，含 py 源返回值归一），
  不经适配层，也不占本节线程池。
````

### 7-4 7.5 本地 proxy 四条（R7，目标白名单）

- **位置**：7.5 的四条 `<BulletedList>`，整组替换。
- **原文**：

````text
- 绑定 `127.0.0.1:9978`，只监听回环；端口占用时改为动态端口并把实际端口注入各 runtime。
- spider 产出的是「原始 URL + 所需 headers」，由 proxy 统一转发，避免多 runtime 抢端口。
- 路径：`/proxy?url=<urlencoded>&ua=<...>&referer=<...>&cookie=<...>`，支持 `Range` 透传与流式回写。
- 播放器拿到的是 `http://127.0.0.1:<port>/proxy?...`，带防盗链的音视频流由此中转。
````

- **替换为**：

````markdown
- 绑定 `127.0.0.1:9978`，只监听回环（9978 为兼容既有 spider 的默认端口，不得随意变更）。
  端口占用时按 7.5.1 注入机制改用动态端口；无法完成注入时降级为「代理不可用 + 源级灰显」，
  不得静默换端口。
- 目标白名单：仅允许 http/https，禁止 CONNECT 与任意 method 转发；拒绝目标是回环地址、
  私网段、链路本地（169.254.0.0/16）与本机管理端口的请求；只允许转发本次配置 / 站点声明的
  目标 host 与播放器显式请求的 URL；单请求超时、响应体大小上限必须设置。
  （测试中的网络目标仍只能是 127.0.0.1 的 stub_server。）
- 路径：`/proxy?url=<urlencoded>&ua=<...>&referer=<...>&cookie=<...>`，支持 `Range` 透传与流式回写；
  token / ua / referer / cookie 不写入日志。
- 播放器拿到的是 `http://127.0.0.1:<port>/proxy?...`，带防盗链的音视频流由此中转。
````

### 7-5 7.5.1 动态端口注入机制（R7，新增小节 + 注入表）

- **位置**：7.5 四条之后、8 节标题之前，新增一个 `####` 小节，内含一张注入表。
- **原文**：（v1.0 无对应内容，本项为新增）
- **替换为**：

````markdown
#### 7.5.1 动态端口注入机制

由 Rust `process.rs` 在拉起每个 sidecar 时统一注入，实际端口对第三方代码可见：

| runtime | 注入方式 |
| --- | --- |
| Python 适配层 / py 源 | 环境变量 `TVBOX_PROXY_PORT` / `TVBOX_PROXY_BASE`，并注入 `os.environ` 与 `local.proxyBase` |
| JS 源 | `local.proxyBase` + 环境变量（同 py） |
| JVM / jar | JVM 参数 `-Dtvbox.proxy.port=<port>`，环境变量同上 |
| CMS / 播放器 URL | 由 Rust 生成，天然使用实际端口 |

第三方 spider 硬编码 9978 且端口被占用时不保证可用：7.5 的降级策略生效，并在 UI 给出原因。
v1.1 不启用一次性 token 鉴权；后续如需加固，须单独评估对硬编码 URL 的破坏并经批准，不得默认开启。
````

---

## 8 节 · 兼容矩阵

### 8-1 8.4 spider 方法面措辞（R3）

- **位置**：8.4 的 `<Paragraph>`（方法清单），在该段末尾补一句；8.5 保持不变。
- **原文**：

````text
`init / homeContent / homeVideoContent / categoryContent / detailContent / searchContent / playerContent / liveContent / proxy / isVideoFormat / manualVideoCheck / destroy` 全部登记；未实现的方法返回空结果而非报错。
````

- **替换为**：

````markdown
`init / homeContent / homeVideoContent / categoryContent / detailContent / searchContent / playerContent / liveContent / proxy / isVideoFormat / manualVideoCheck / destroy` 全部登记；未实现的方法返回空结果而非报错。本节为 **Spider API**（12 个 jar 反射方法），与 6.2 `SpiderMethod`（6 个对外方法）、7.2 适配层协议方法（7 个业务方法 + `ping`）分属三套集合，数量不得互相套用（见 7.2 表后说明）；8.5 保持不变。
````

---

## 9 节 · 分期任务清单（验收列）

> 以下 14 处均改对应 `T-xx` 行的「验收」单元格文本（T-23 另含「任务」单元格）。表格为富文本，只替换单元格内文字，不动行 / 列结构与其余单元格。

### 9-1 T-03（R5 联动）

- **位置**：9 节 P0 表 T-03 行「验收」列。
- **原文**：

````text
未授权 command 调用被拒
````

- **替换为**：

````markdown
未授权 command 调用被拒；前端调用 spawn 被拒、Rust 拉起的进程均在 Job Object 内
````

### 9-2 T-04（R8 联动）

- **位置**：9 节 P0 表 T-04 行「验收」列。
- **原文**：

````text
`tsc --noEmit` 通过
````

- **替换为**：

````markdown
`tsc --noEmit` 通过；`contract_check.py` 通过
````

### 9-3 T-08（R7）

- **位置**：9 节 P0 表 T-08 行「验收」列。
- **原文**：

````text
带 Referer 的桩 m3u8 能正常播放
````

- **替换为**：

````markdown
带 Referer 的桩 m3u8 能正常播放；按 7.5 目标白名单拒绝回环 / 私网 / 链路本地（169.254.0.0/16）与本机管理端口目标，禁止 CONNECT 与非 http/https 转发，单请求超时与响应体大小上限生效；token / ua / referer / cookie 不写入日志
````

### 9-4 T-11（R1 联动）

- **位置**：9 节 P0 表 T-11 行「验收」列。
- **原文**：

````text
`python tests/acceptance/p0.py` 全绿
````

- **替换为**：

````markdown
`python tests/acceptance/p0.py` 全绿（按 12.2 累积断言口径：仅断言 P0 已交付能力，未交付项标 `N/A` 不参与判定，`FAIL = 0` 即通过）
````

### 9-5 T-13（R6 + R8 联动）

- **位置**：9 节 P1 表 T-13 行「验收」列。
- **原文**：

````text
断帧/乱序/崩溃三类用例通过
````

- **替换为**：

````markdown
断帧/乱序/崩溃三类用例通过；迟到帧丢弃、取消帧生效、崩溃重启 epoch 隔离、`id` 不复用四类用例通过；`contract_check.py` 通过
````

### 9-6 T-14（R3）

- **位置**：9 节 P1 表 T-14 行「验收」列。
- **原文**：

````text
`ping` 与 10 个方法均有响应
````

- **替换为**：

````markdown
`ping` 与第 7.2 节方法表中全部 7 个业务方法逐一有响应（逐方法断言，不写死数字）
````

### 9-7 T-16（R4 方案 A 联动）

- **位置**：9 节 P1 表 T-16 行「验收」列。
- **原文**：

````text
自编模板 js 源跑通 6 个方法；越权 API 调用被拒
````

- **替换为**：

````markdown
自编模板 js 源（经 `qjs-runner` sidecar）跑通 6 个方法；越权 API 调用被拒；死循环 JS 超时被强杀、主进程存活、无残留进程
````

### 9-8 T-17（R6 联动）

- **位置**：9 节 P1 表 T-17 行「验收」列。
- **原文**：

````text
20 源并发，其中 3 源超时，其余正常返回
````

- **替换为**：

````markdown
20 源并发，其中 3 源超时，其余正常返回；20 源并发下无串帧、总耗时 ≤ 单源超时上限 + 归一化排队余量；3 个超时源的子进程 / 任务被取消且无残留
````

### 9-9 T-19（R1 联动）

- **位置**：9 节 P1 表 T-19 行「验收」列。
- **原文**：

````text
`python tests/acceptance/p1.py` 全绿
````

- **替换为**：

````markdown
`python tests/acceptance/p1.py` 全绿（按 12.2 累积断言口径：仅断言 P1 及之前已交付能力，未交付项标 `N/A`，`FAIL = 0` 即通过）
````

### 9-10 T-20（R9）

- **位置**：9 节 P2 表 T-20 行「验收」列。
- **原文**：

````text
脚本输出 0 处不匹配
````

- **替换为**：

````markdown
对 `tests/fixtures/jars/template-class.jar` 与 `template-dex.jar` 实跑 `javap -p -s`，守恒脚本输出 0 处不匹配；脚本须支持 `--jar <path>` 接收用户本机 jar（可选输入，不改变仓库内不含第三方代码的约束）
````

### 9-11 T-23（R3 + R9，含任务列）

- **位置**：9 节 P2 表 T-23 行「任务」列与「验收」列。
- **原文**：

````text
任务列：`SpiderRunner.java`：JSON-RPC over stdio，反射调 12 个方法，`ext` 透传
验收列：单测逐方法覆盖
````

- **替换为**：

````markdown
任务列：`SpiderRunner.java`：JSON-RPC over stdio，反射调用 8.4 登记的全部 12 个方法（未实现方法返回空结果），`ext` 透传
验收列：单测逐方法覆盖 8.4 登记的全部 12 个方法；自编模板 jar（`template-class.jar` / `template-dex.jar`）跑通率 100%（口径见 14 节）
````

### 9-12 T-25（R7）

- **位置**：9 节 P2 表 T-25 行「验收」列。
- **原文**：

````text
带防盗链地址经 9978 正常播放
````

- **替换为**：

````markdown
带防盗链地址经实际端口（默认 9978，动态端口按 7.5.1 注入）正常播放；第三方硬编码 9978 且端口被占用时按 7.5 降级为「代理不可用 + 源级灰显」并在 UI 给出原因
````

### 9-13 T-27（R1 联动）

- **位置**：9 节 P2 表 T-27 行「验收」列。
- **原文**：

````text
`python tests/acceptance/p2.py` 全绿
````

- **替换为**：

````markdown
`python tests/acceptance/p2.py` 全绿（按 12.2 累积断言口径：仅断言 P2 及之前已交付能力，未交付项标 `N/A`，`FAIL = 0` 即通过）
````

### 9-14 T-32（R11 方案 A）

- **位置**：9 节 P3 表 T-32 行「验收」列。
- **原文**：

````text
两种形态均能启动，安装包 ≤130MB（按需下载版 ≤25MB）
````

- **替换为**：

````markdown
两种形态均能启动；安装包 ≤130MB；「不含 JRE / mpv」的按需下载版体积以 `docs/size-report.md` 的实测值为准（v1.1 目标 ≤45MB，含 Python embeddable 与前端产物）。JRE / mpv 按需下载；Python 适配层为 P0 必备，一律随包分发，不得按需下载。
````

---

## 10 节 · 编码约定

### 10-1 超时行（R4 方案 A 联动）

- **位置**：10 节表「超时」行的「约定」单元格。
- **原文**：

````text
单源默认 15s 墙钟；配置拉取 10s；py/jar 子进程调用一律进程级可强杀，禁止依赖线程超时
````

- **替换为**：

````markdown
单源默认 15s 墙钟；配置拉取 10s；py/js/jar 子进程调用一律进程级可强杀，禁止依赖线程超时
````

### 10-2 并发行（R6 联动）

- **位置**：10 节表「并发」行的「约定」单元格。
- **原文**：

````text
首页/搜索用 `tokio::JoinSet` fan-out，限制并发上限（建议 20），结果按站点分组返回
````

- **替换为**：

````markdown
首页/搜索用 `tokio::JoinSet` fan-out，限制并发上限（建议 20），结果按站点分组返回；适配层的并发、取消与迟到帧回收语义见 7.2.1
````

---

## 11 节 · 安全约束

### 11-1 11.1 权限 JSON（R5）

- **位置**：11.1 的 `<Code language="json">` 代码块，整块替换。
- **原文**：

````json
{
  "identifier": "main-access",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-title",
    "shell:allow-open",
    { "identifier": "shell:allow-spawn", "allow": [{ "name": "python", "sidecar": true }] }
  ]
}
````

- **替换为**：

````json
{
  "identifier": "main-access",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-title",
    "shell:allow-open"
  ]
}
````

### 11-2 11.1 说明段（R5，新增段）

- **位置**：11.1 权限 JSON 之后的「自定义 command……」段落，在其后追加一段。
- **原文**：

````text
自定义 command 在 Tauri v2 中通过 `#[command]` 注册后由应用内 IPC 直接调用；`spider_invoke` 不得授予任何外部加载页面 / iframe / 嗅探 WebView。
````

- **替换为**：

````markdown
自定义 command 在 Tauri v2 中通过 `#[command]` 注册后由应用内 IPC 直接调用；`spider_invoke` 不得授予任何外部加载页面 / iframe / 嗅探 WebView。

capabilities 约束的是 WebView 前端权限，Rust 主进程通过 `process.rs` 拉起 sidecar 不受其管辖。所有 sidecar（python-embed / jvm / qjs-runner / mpv）统一在 `tauri.conf.json` 的 `externalBin` 注册，由 Rust 端 `Command` 或 shell sidecar 的 Rust API 拉起并纳入 Job Object；前端不得直接 spawn 任何进程，也不授予 `shell:allow-spawn`。`open_external` 若走 shell 插件，仅保留 `shell:allow-open`。
````

### 11-3 11.2 第一条（R4 方案 A）

- **位置**：11.2 第一条 `<BulletedList>`。
- **原文**：

````text
所有 spider（jar / py / js）都是第三方任意代码，一律子进程隔离（js 用独立 rquickjs context，不共享主 context）。
````

- **替换为**：

````markdown
py / js / jar 三类 spider 均为第三方任意代码，一律由 Rust `process.rs` 以独立子进程拉起并纳入 Job Object，主进程不执行第三方代码；js 使用独立 `qjs-runner` sidecar（内部 rquickjs context，每请求新建、不共享），不放在主进程内。所有子进程调用具备进程级强杀能力，超时须 `TerminateJobObject`，禁止依赖 future 取消或线程超时。CMS（`cms.rs`）为宿主自研代码，可进程内执行，但同样受 15s 墙钟超时约束。
````

### 11-4 11.2 第二条（R7）

- **位置**：11.2 第二条 `<BulletedList>`。
- **原文**：

````text
proxy 只监听 `127.0.0.1`，不暴露到局域网，不带鉴权信息到日志。
````

- **替换为**：

````markdown
proxy 只监听 `127.0.0.1`，按 7.5 做目标白名单与请求限制，不暴露到局域网，不带鉴权信息到日志。
````

---

## 12 节 · 验收方案

### 12-1 12.2 断言脚本 · 累积断言矩阵全文（R1）

- **位置**：12.2 的 `<Paragraph>`（原为一段文字），替换为「说明段 + 富文本表格 + 判定口径」；云端请把表格建成 `<Table>` 节点（见末尾注意点）。
- **原文**：

````text
`tests/acceptance/p0.py` ~ `p3.py`，每阶段至少覆盖：配置解析、路由判定、6 个 spider 方法、聚合超时、崩溃隔离、播放四级降级、proxy 转发、ext 透传、进程无残留。脚本输出 `PASS/FAIL` 计数，任一 FAIL 即阶段不通过。
````

- **替换为**：

````markdown
`tests/acceptance/p0.py` ~ `p3.py` 采用累积式断言：每个脚本只断言本阶段及之前已交付的能力，
未交付能力标 `N/A`（不计数、不计 FAIL）；该项在对应阶段交付后转为必测，并在后续阶段回归。
脚本输出 `PASS / FAIL / N/A` 计数，任一 `FAIL` 即阶段不通过；`N/A` 项必须在阶段交付物中
列出并注明启用阶段。

| 断言组 | p0.py | p1.py | p2.py | p3.py |
| --- | --- | --- | --- | --- |
| 配置解析、路由判定 | 必测 | 必测 | 必测 | 必测 |
| CMS 首页 / 分类 / 详情 / 搜索 | 必测 | 必测 | 必测 | 必测 |
| 6.2 `SpiderMethod` 的 6 个方法（按已启用 runtime 逐类覆盖） | N/A | py / js | + jar | 全量回归 |
| 聚合超时（20 源并发、3 源超时） | 单源超时 | 必测 | 必测 | 必测 |
| 崩溃隔离、进程无残留 | N/A（P0 无子进程） | 必测（T-18 后） | 必测 | 必测 |
| 播放降级 | 1~3 级 | 1~3 级 | 1~3 级 | 四级 |
| proxy 转发、Range、Referer | 必测 | 必测 | 必测 | 必测 |
| 扩展字段透传（8.5） | CMS 原样保留 | py / js | jar 重点 | 全量回归 |
| 嗅探（第 4 级降级） | N/A | N/A | N/A | 必测 |

判定口径：「全绿」= 当阶段所有「必测」项 PASS 且 `FAIL = 0`；`N/A` 不参与判定。
````

---

## 13 节 · 构建与打包

### 13-1 `externalBin` 清单（R4 方案 A + R5）

- **位置**：13 节第一条 `<BulletedList>`（「`externalBin` 配置 sidecar……」）。
- **原文**：

````text
`externalBin` 配置 sidecar，命名带 `-x86_64-pc-windows-msvc` triple 后缀；Win11 单平台只需一个目标。
````

- **替换为**：

````markdown
`externalBin` 统一注册全部 sidecar：`python-embed`（Python 适配层）、`jvm`（裁剪 JRE + `SpiderRunner`）、`qjs-runner`（JS sidecar）、`mpv`（P3）；命名带 `-x86_64-pc-windows-msvc` triple 后缀，Win11 单平台只需一个目标。以上清单为唯一登记处，全部由 Rust `process.rs` 以 `Command` 或 shell sidecar 的 Rust API 拉起并纳入 Job Object；前端不得直接 spawn 任何进程，也不授予 `shell:allow-spawn`。
````

### 13-2 体积报告（R11 方案 A，新增）

- **位置**：13 节 BulletedList 末尾（Python 分发条之后）新增一条。
- **原文**：（v1.0 无对应内容，本项为新增）
- **替换为**：

````markdown
T-32 前产出 `docs/size-report.md`，逐项列出主程序、前端产物、Python embeddable、JRE、mpv 的实测体积（压缩前 / 后），指标以该文件为准，不在正文写未经实测的数字。
````

---

## 14 节 · 风险与兜底

### 14-1 风险表首行兜底列（R9）

- **位置**：14 节风险表第一个数据行（「jar 跑通率不满（冷门 Android API）」）的「兜底」单元格；「风险」列文字保持不变。
- **原文**：

````text
源级灰显 + 原因提示；CMS/py/js 仍可覆盖大部分配置
````

- **替换为**：

````markdown
定义：jar 跑通率 = 通过 T-23 逐方法断言的 jar 数 / 参与测试的 jar 数。v1.1 的验收基准为自编模板 jar 100%；不对第三方 jar 的跑通率作承诺。第三方 jar 不通过时源级灰显 + 原因提示，CMS / py / js 三类运行时仍须可用；样本由用户在本机提供，不入库。
````

---

## 云端写入注意点

1. **整体**：云端文档是富文本（自定义 XML 节点），不是 Markdown 源文件。本清单「替换为」内的 `**粗体**`、反引号、Markdown 表格、` ``` ` 围栏是给编辑器粘贴 / 转换用的表述；粘贴后由云端编辑器生成对应的 `<Mark bold>`、代码样式、`<Table>`、`<Code>` 节点。请勿把围栏符号本身当正文写入。
2. **12.2 是富文本表格**：`替换为` 里是一张 Markdown 表，但云端必须建成 `<Table>` 节点（9 行 × 5 列，含表头「断言组 / p0.py / p1.py / p2.py / p3.py」），逐格填「必测 / N/A / py / js / + jar / 全量回归 / 单源超时 / 1~3 级 / 四级 / CMS 原样保留 / jar 重点」等；表前后的两段文字与「判定口径」段作为普通 `<Paragraph>`。不要只贴一段 Markdown 文本当表格。
3. **7.2.1 / 7.5.1 是新增小节**：分别插在 7.2 末尾（7.3 之前）与 7.5 末尾（8 节之前），标题层级与同章一致（7.2.1 为 `###`、7.5.1 为 `####` 或按云端现有层级对齐）。7.5.1 内含一张 4 行 2 列的注入表（`<Table>`），同样需建成表格节点。
4. **代码块整块替换**：4.1 拓扑图、4.3 数据流、5 节目录树、11.1 `capabilities` 均为 `<Code>` 节点。4.1 / 4.3 / 5 是无语言或纯文本代码块，替换时保留 ` ``` ` 围栏内的等宽对齐（竖线 `│ ├ └` 与空格不要被编辑器自动折行破坏）；11.1 是 `<Code language="json">`，删掉 `shell:allow-spawn` 后注意 `permissions` 数组最后一项 `shell:allow-open` 后**没有尾逗号**。6.2 `AppError` 是 `<Code language="ts">`，7.2.1 内的 JSON 取消帧示例按正文内联处理。
5. **9 节 T-xx 是富文本表格单元格**：14 处只改「验收」列文本（T-23 另改「任务」列），不动「编号」列，也不要增删行 / 列；`pX.py 全绿` 的括注写进同一单元格。
6. **0 节是 `<NumberedList>`**：第 1 / 6 条在**条目内部末尾追加**文字，不要新增编号项；第 6 条追加的是独立段落，按云端编辑器可在条目内换行处理。
7. **2 节 / 3.2 / 10 节 / 14 节是表格单元格**：只替换对应单元格文字，保留表格结构；14 节首行「风险」列不动。
8. **11.1 说明段 / 6.2 契约真源段 / 13 节体积报告 / 7.1 清单说明 / 7.2 方法集合说明**均为新增 `<Paragraph>` / `<BulletedList>` 条目，插在本文「位置」指定的相邻节点之间。
9. **8.5 不改**：R3 / R9 均明确 8.5「ext 透传属 P2 验收重点」保持不变，与 12.2 表格一致。
10. **交叉引用复核**：写入后通读一遍，确认 `7.2.1`、`7.5.1`、`12.2`、`contracts/tvbox.schema.json`、`qjs-runner`、`docs/size-report.md`、`tests/fixtures/jars/` 等编号 / 名称全文一致；三套方法集合统一表述为 6.2 `SpiderMethod`(6) / 7.2 协议方法(11) / 8.4 Spider API(12)。

### 建议的写入顺序

> 原则：**先结构、后引用，自上而下，最后统一版本号与表格**——先建好新增小节与目录，再改引用它们的验收 / 约定，避免中途出现悬空引用；富文本表格（12.2、7.5.1）一次性建好，减少反复重排。

1. 文首：版本号 v1.0 → v1.1 + 「v1.1 修订说明」段（条目 文首-1）。
2. 骨架：0-1 / 0-2 → 2-1 → 3-1 → 4-1 → 4-2 → 5-1（先完成 0~5 节的门禁、环境、拓扑、数据流、目录树，目录树里把 `contracts/`、`qjs-runner/`、`size-report.md`、`fixtures/jars/` 等新路径立起来）。
3. 契约与协议：6-1 / 6-2 → 7-1 / 7-2 / 7-3 / 7-4 / 7-5（含两个新增小节 7.2.1、7.5.1 及其表格）。
4. 兼容矩阵：8-1（8.5 不动）。
5. 分期任务：9-1 ~ 9-14（14 处验收列 + T-23 任务列）；此时 7.2.1 / 7.5.1 / 12.2 的编号已存在，引用不悬空。
6. 约定与安全：10-1 / 10-2 → 11-1 / 11-2 / 11-3 / 11-4。
7. 验收与收尾：12-1（12.2 富文本表整表重建）→ 13-1 / 13-2 → 14-1。
8. 全文复核：按注意点第 10 条做交叉引用与三套集合措辞核对，确认无备选方案、无待决策字样、无写死的数量（除 6 / 11 / 12 的明确集合定义与 `max_workers = 8`）。

> 本清单现为**本地 v1.1 基线文本**，不再对云端执行写入；云端 doc 节点的历史 v1.1 内容仅作只读参考。实现依据以本目录与 `CHANGELOG.md` 为准，修订统一走本地。
