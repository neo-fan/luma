# 《TVBox 桌面客户端 · 实现规格书 v1.0》修订建议（拟 v1.1）

> 日期：2026-11-08 · 对象：<<internal design doc>>
> 状态：**仅供确认，尚未改动云端规格书**，也未创建任何工程代码。
> 用法：每条给出「位置 / 原文 / 问题 / 建议替换文本 / 联动修改」。带「需拍板」的条目有 A/B 方案，选定后我按选中的方案改云端文档。

## 修订分级

| 级别 | 条目 | 说明 |
|---|---|---|
| **阻断** | R1 | 不改则 `p0.py` 按定义永远无法全绿，P0 直接死锁 |
| 口径 | R2、R3 | 数字与命名不一致，会诱导 Agent 写出错误验收 |
| 架构 / 安全 | R4、R5、R6、R7 | 隔离承诺、进程主体、并发模型、代理边界没闭环 |
| 契约 | R8 | 三处手工同步已出现字段漂移 |
| 可行性 | R9、R10、R11 | 验收基准、JDK 版本、体积指标互相打架 |

---

## R1【阻断】12.2 的「每阶段至少覆盖」与分期交付冲突

**位置**：0 节第 1 条、12.2、T-11 / T-19 / T-27 的验收列。

**原文（12.2）**：
> `tests/e2e/p0.py` ~ `p3.py`，每阶段至少覆盖：配置解析、路由判定、6 个 spider 方法、聚合超时、崩溃隔离、播放四级降级、proxy 转发、ext 透传、进程无残留。脚本输出 `PASS/FAIL` 计数，任一 FAIL 即阶段不通过。

**问题**：0 节规定「每个 `T-xx` 断言不通过不得进入下一任务」，T-11 又要求 `p0.py 全绿`。但按 9 节分期，P0 只有 CMS 进程内运行时和播放 1~3 级降级：

- 6 个 spider 方法：py/js 在 P1（T-15 / T-16），jar 在 P2（T-23）；
- 崩溃隔离 / 进程无残留：Job Object 在 P1（T-18），P0 根本没有子进程；
- 播放四级降级：嗅探是 P3；
- ext 透传：8.5 明写「属 P2 验收重点」。

按字面执行，P0 就要求验证 P1~P3 才有的能力，`p0.py` 必然 FAIL，项目卡死在 T-11。

**建议替换 12.2 全文（可直接粘贴）**：

```markdown
`tests/e2e/p0.py` ~ `p3.py` 采用累积式断言：每个脚本只断言本阶段及之前已交付的能力，
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
```

**联动修改**：

- 0 节第 1 条末尾补：「阶段脚本仅断言本阶段已交付能力；未交付能力按 12.2 标 `N/A`，不视为通过，也不计入 FAIL。」
- T-11 / T-19 / T-27 的「`pX.py` 全绿」统一按上述口径解释。
- 8.5「ext 透传属 P2 验收重点」保持不变，与表格一致。

---

## R2【口径】Tauri command 数量 6 / 7 不一致

**位置**：7.1、第 5 节目录树 `commands.rs` 注释、4.1 拓扑图。

**原文**：7.1 列出 **7 个**（`config_import`、`config_list`、`config_remove`、`spider_invoke`、`http_fetch`、`resolve_play`、`open_external`）；第 5 节写「`# 6 个 command 实现`」；4.1 拓扑图只画了 6 个（漏 `config_remove`）。

**问题**：以注释或拓扑图为准就会漏实现 `config_remove`；写死数字本身也是漂移源。

**建议替换**：以 7.1 为唯一真源，且不再写死数量。

- 第 5 节：`├─ commands.rs                 # Tauri command 实现（清单见 7.1）`
- 4.1 拓扑图：`│   ├ config_import / config_list / config_remove`
- 7.1 代码块后补一段：「以上 7 个 command 为完整清单，是新增系统能力的唯一登记处；新增 command 须同步更新本清单、`lib.rs` 注册与 `src/lib/invoke.ts`，并在 `capabilities/default.json` 复核权限。」

---

## R3【口径】三套「方法」集合混用，T-14 数字错

**位置**：6.2、7.2、8.4、T-14、T-15 / T-16、T-23、12.2。

**原文**：7.2 方法表实为 **11 个业务方法 + `ping`**；T-14 验收写「`ping` 与 10 个方法均有响应」；6.2 `SpiderMethod` 是 **6 个**；8.4 登记 **12 个** jar 反射方法；T-23 写「反射调 12 个方法」；12.2 写「6 个 spider 方法」。

**问题**：T-14 少算一个（应为 11）。三套集合都叫「方法」，12.2 的「6 个」容易被误读成只需覆盖 6 个，而 8.4 要求 12 个全登记。

**建议替换**：

- T-14 验收：「`ping` 与第 7.2 节方法表中全部 11 个业务方法逐一有响应（逐方法断言，不写死数字）」。
- 7.2 表后补：「本表共 11 个业务方法 + `ping`，是 Rust ↔ Python **适配层协议面**；6.2 的 `SpiderMethod`（6 个对外方法）与 8.4 的 **Spider API**（12 个 jar 反射方法）是另外两个集合，三者数量不得互相套用。新增或删改方法须同步本表、T-14 与 `bridge.rs` 分发实现。」
- T-23 任务列：「`SpiderRunner.java`：JSON-RPC over stdio，反射调用 8.4 登记的全部 12 个方法（未实现方法返回空结果），`ext` 透传」。
- R1 的 12.2 表格已明确为「6.2 `SpiderMethod` 的 6 个方法」。

---

## R4【架构 · 需拍板】11.2「一律子进程隔离」与实际架构冲突

**位置**：11.2、4.1、3.2、第 5 节、T-16、10 节超时行。

**原文（11.2）**：
> 所有 spider（jar / py / js）都是第三方任意代码，一律**子进程隔离**（js 用独立 rquickjs context，不共享主 context）。

**原文（3.2 / 4.1 / 第 5 节）**：`rquickjs` 用途写「JS 源运行时（进程内）」；4.1 拓扑 `quickjs.rs 进程内（rquickjs context）`；目录树 `quickjs.rs # JS 源，进程内白名单 context`。

**问题**：`rquickjs` 是主进程内的 context，属于上下文隔离而非进程隔离。第三方 JS 死循环会占死线程，`tokio::time::timeout` 只能取消 future、杀不掉正在执行的线程；QuickJS 的 native 段错误会直接带走主进程。这与 10 节「py/jar 子进程调用一律进程级可强杀，禁止依赖线程超时」的承诺互斥，也让 11.2 的「一律」不成立。CMS（`cms.rs`）是宿主自研代码，进程内合理，但 11.2 没把它排除，措辞也需收窄。

**方案 A（推荐：让 11.2 的承诺真正成立）** — JS 也下沉为可强杀 sidecar。

11.2 第一条替换为：

```markdown
py / js / jar 三类 spider 均为第三方任意代码，一律由 Rust `process.rs` 以独立子进程拉起并纳入
Job Object，主进程不执行第三方代码；js 使用独立 `qjs-runner` sidecar（内部 rquickjs context，
每请求新建、不共享），不放在主进程内。所有子进程调用具备进程级强杀能力，超时须
`TerminateJobObject`，禁止依赖 future 取消或线程超时。CMS（`cms.rs`）为宿主自研代码，
可进程内执行，但同样受 15s 墙钟超时约束。
```

联动：4.1 拓扑 `quickjs.rs` 改为「JS sidecar 客户端」；3.2 `rquickjs` 用途改为「JS sidecar 内运行时」；第 5 节加 `sidecars/qjs-runner/`、把 `spider/quickjs.rs` 注释改为「JS sidecar 协议适配」；T-16 验收补「死循环 JS 超时被强杀、主进程存活、无残留进程」；10 节超时行把「py/jar」改为「py/js/jar」；13 节 `externalBin` 增加 `qjs-runner`。

**方案 B（改动小、安全弱）** — 保留进程内 JS，但如实降级承诺。

11.2 第一条替换为：

```markdown
py / jar 由 Rust 以独立子进程拉起并纳入 Job Object；js 为进程内独立 rquickjs context
（每请求新建、不共享），必须设置 interrupt handler 按 deadline 中断，并在专用 OS 线程求值，
禁止在 tokio worker 线程执行。主进程不对 js 提供「进程级强杀」保证：js 超时只保证中断返回，
native 层崩溃属已知风险，由 T-26 源级熔断兜底。
```

联动：11.2 删除「一律子进程隔离」；10 节超时行注明 js 例外；T-16 验收补「死循环被 interrupt handler 中断、不阻塞其他源」；14 节风险表新增「js native 崩溃 → 主进程重启 + 源级灰显」。

**取舍**：B 少一个可执行文件，但无法覆盖 native 死循环 / 段错误，且要长期背负「文档承诺与实现不符」；A 多一个 sidecar，但隔离、超时、崩溃恢复三件事一次闭环，且与 R5 的「Rust 统一拉起」天然一致。

---

## R5【架构 · 需拍板】sidecar 到底由谁拉起

**位置**：11.1、T-03、4.1、第 5 节 `process.rs`、7.1 约束、13 节 `externalBin`。

**原文（11.1）** 权限里含：
```json
{ "identifier": "shell:allow-spawn", "allow": [{ "name": "python", "sidecar": true }] }
```

**问题**：7.1 约束要求「所有系统能力经 `invoke()` 走 Rust command」，4.1 / 第 5 节 / 10 节又明确 `process.rs` 用 Job Object 管进程、`bridge.rs` 连 Python 适配层。若真由 Rust 拉起，这条前端 spawn 权限多余，且未覆盖 JVM / mpv（以及方案 A 的 qjs-runner）；若真由前端 spawn，则与「Rust 唯一宿主」「Job Object 收尸」直接冲突。拉起主体必须唯一。

**建议（与 R4 方案 A 配套）**：确定 **Rust `process.rs` 为唯一拉起主体**，删除 `shell:allow-spawn`，并把 sidecar 清单集中到 `tauri.conf.json` 的 `externalBin`。

11.1 权限块替换为：

```json
{
  "identifier": "main-access",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-title",
    "shell:allow-open"
  ]
}
```

11.1 说明段补：

```markdown
capabilities 约束的是 WebView 前端权限，Rust 主进程通过 `process.rs` 拉起 sidecar 不受其管辖。
所有 sidecar（python-embed / jvm / qjs-runner / mpv）统一在 `tauri.conf.json` 的 `externalBin`
注册，由 Rust 端 `Command` 或 shell sidecar 的 Rust API 拉起并纳入 Job Object；
前端不得直接 spawn 任何进程，也不授予 `shell:allow-spawn`。
`open_external` 若走 shell 插件，仅保留 `shell:allow-open`。
```

联动：T-03 验收补「前端调用 spawn 被拒、Rust 拉起的进程均在 Job Object 内」；13 节 `externalBin` 列出全部 sidecar；若采用 R4 方案 B，则 `externalBin` 不含 qjs-runner，但拉起主体结论不变。

---

## R6【架构 · 需拍板】常驻单进程 Python 撑不住 20 源 fan-out

**位置**：7.2、4.3、T-13、T-17、10 节并发行。

**原文**：7.2「适配层为**常驻单进程**，内部对 `pyrun` 类调用再 fork 子进程执行」「单请求墙钟超时由 Rust 侧控制」；4.3「20 源并发 → CMS 走 Python `normalizeHome`」；T-17「20 源并发，其中 3 源超时，其余正常返回」。

**问题**：单进程一行一帧，主循环若串行处理，20 个归一化 / 解密请求排队，会引发 15s 墙钟连锁超时。更关键的是**取消语义缺失**：Rust 超时后丢弃 future，但 Python 仍在计算，迟到帧的 `id` 已无归属；`id` 复用、崩溃重启后的 in-flight 请求、串帧都没有定义。T-13 只测「断帧 / 乱序 / 崩溃」，覆盖不到这几类。

**建议新增 7.2.1「并发与取消语义」（可直接粘贴）**：

```markdown
### 7.2.1 并发与取消语义

- 请求 `id` 由 Rust 侧生成，进程生命周期内全局单调、绝不复用；适配层重启后 id 带 epoch 前缀
  （如 `e3-42`），旧 epoch 的迟到帧一律丢弃。
- Python 主循环用线程池并发处理纯计算型方法（`config.*` / `site.parse*` / `live.parseM3u` /
  `parse.resolve`），默认 `max_workers = 8`，可配置；`spider.py` 一律转独立子进程，不占主循环。
  主循环只做读帧、派发、写帧，禁止在协议线程内做阻塞计算。
- 增加取消帧：`{"id":"<new>","method":"__cancel__","params":{"targetId":"<old>"}}`。
  Python 对未开始执行的请求直接丢弃；已执行中的纯计算任务标记取消，返回时不写 stdout；
  `spider.py` 由 Rust 直接强杀对应子进程（Job Object）。
- Rust 侧维护 `HashMap<id, oneshot::Sender>`。超时后将该 id 标记为 orphan，其迟到帧丢弃并写
  debug 日志；适配层崩溃或重启时，把所有 in-flight 一次性回 `RUNTIME_RESTART` 错误并清空映射。
- 墙钟超时以 Rust 侧 `tokio::time::timeout` 为准；对 `spider.py` 子进程必须同步执行进程级强杀，
  禁止只取消 future。
- 4.3 的 CMS 归一化同样走本节的线程池与取消语义，不另设通道。
```

**联动**：

- T-13 验收补「迟到帧丢弃、取消帧生效、崩溃重启 epoch 隔离、id 不复用」四类用例。
- T-17 验收补「20 源并发下无串帧、总耗时 ≤ 单源超时上限 + 归一化排队余量；3 个超时源的子进程/任务被取消且无残留」。
- 4.3 数据流补一句「所有走适配层的请求受 7.2.1 约束」。

**需拍板**：主循环用**线程池**（改动小，GIL 下短 JSON 任务可接受，推荐先落地）还是**多个常驻 Python 进程池**（隔离更好，但内存与进程管理成本翻倍）。选定后把上面 `max_workers = 8` 那句改成对应表述。

---

## R7【安全 · 需拍板】9978 proxy 无鉴权、动态端口注入机制未定义

**位置**：7.5、11.2、T-08、T-25、13 节。

**原文（7.5）**：「绑定 `127.0.0.1:9978`，只监听回环；**端口占用时改为动态端口并把实际端口注入各 runtime**」「路径 `/proxy?url=...`」；11.2「proxy 只监听 `127.0.0.1`，不暴露到局域网」。

**问题**：只听回环不等于安全——本机任意进程、任意网页都能拿它当开放代理，转发到内网或本机管理接口（SSRF）。另外「注入各 runtime」没写怎么注入：第三方 py/js/jar 里硬编码 `127.0.0.1:9978` 的代码，在动态端口下必然失效，而兼容这类代码恰是本项目的目标。

**建议替换 7.5 四条（推荐「白名单」方案，保留生态兼容性）**：

```markdown
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

#### 7.5.1 动态端口注入机制

由 Rust `process.rs` 在拉起每个 sidecar 时统一注入，实际端口对第三方代码可见：

| runtime | 注入方式 |
| --- | --- |
| Python 适配层 / py 源 | 环境变量 `TVBOX_PROXY_PORT` / `TVBOX_PROXY_BASE`，并注入 `os.environ` 与 `local.proxyBase` |
| JS 源 | `local.proxyBase` + 环境变量（同 py） |
| JVM / jar | JVM 参数 `-Dtvbox.proxy.port=<port>`，环境变量同上 |
| CMS / 播放器 URL | 由 Rust 生成，天然使用实际端口 |

第三方 spider 硬编码 9978 且端口被占用时不保证可用：7.5 的降级策略生效，并在 UI 给出原因。
可选的「一次性 token 鉴权」列为 P3 加固项，启用前必须评估对硬编码 URL 的破坏，未经批准不得默认开启。
```

11.2 第二条同步替换为：「proxy 只监听 `127.0.0.1`，按 7.5 做目标白名单与请求限制，不暴露到局域网，不带鉴权信息到日志。」

**需拍板**：**目标白名单（推荐，不破坏硬编码 9978 的 spider）** vs **一次性 token（更严，但第三方硬编码 URL 会全部失效，需在 14 节登记为已知兼容性损失）**。

---

## R8【契约】三处手工同步已经漂移（`rawSaved`）

**位置**：6.2 `AppError`、7.2 帧格式、T-04、T-13。

**原文**：6.2 `export interface AppError { code: string; message: string; cause?: string; }`；7.2 错误帧示例含 `{"code":"DIALECT_UNKNOWN","message":"...","rawSaved":true}`。

**问题**：`rawSaved` 不在 `AppError` 定义里。TS interface、Rust serde struct、Python 输出 JSON 三处各写一遍，没有单一真源，字段会持续漂移。

**建议（轻量方案，不新增依赖，推荐先落地）**：

- 6.2 定义改为：
  ```ts
  export interface AppError {
    code: string;
    message: string;
    cause?: string;
    rawSaved?: boolean;       // 7.2 错误帧：原始配置是否已留存便于诊断
    details?: Record<string, unknown>;
  }
  ```
- 6.2 末尾补：「归一化契约以 `contracts/tvbox.schema.json` 为唯一真源。`src/types/tvbox.ts`、`error.rs` 的 serde struct、Python 输出字段必须与之对齐；`tests/e2e/contract_check.py` 比对三端字段名，作为 T-04 与 T-13 的必跑断言。新增字段须先改 schema，再改三端实现与验收脚本。」
- 第 5 节目录树加 `contracts/tvbox.schema.json` 与 `tests/e2e/contract_check.py`。
- T-04 验收补「`contract_check.py` 通过」。

**备选（完整代码生成链）**：用 JSON Schema 生成 TS / Rust / Python 类型。需新增 `json-schema-to-typescript`、`typify` 等依赖，按 0 节第 3 条「不得引入本文档未列出的功能/依赖」必须单独批准，故本版不默认采用。

---

## R9【可行性】P2 缺真实样本 jar，`javap` 守恒与「跑通率」没有基准

**位置**：0 节第 6 条、7.4、T-20、T-27、8.4、14 节风险表。

**原文**：0 节第 6 条「修改或新增桩类前，必须先对**目标 jar** 实跑 `javap -p -s`」；T-20「对**目标 jar** 实跑」；T-27「用模板**自编** jar，不使用任何第三方站点代码」；14 节「jar 跑通率不满（冷门 Android API）」。

**问题**：0 节禁止内置外部源 + T-27 禁止第三方代码 → 仓库里不存在「目标 jar」。`javap` 守恒只能对自编模板跑，而模板签名由自己定义，必然 0 处不匹配，验收失去意义；「跑通率不满」也没有量化口径和样本集合。规格书自己承认风险，却没给判定线。

**建议替换**：

0 节第 6 条补一句：

```markdown
本文档的「目标 jar」在仓库内指 `tests/fixtures/jars/` 下的自编模板 jar（纯 class 与 dex 两种形态）。
用户在本机另行提供 jar 时，实现 Agent 应先对该 jar 实跑 `javap -p -s`、输出签名差异报告，
再决定是否调整桩类；该 jar 不得入库、不得提交、不得写入 fixture。
```

T-20 验收：「对 `tests/fixtures/jars/template-class.jar` 与 `template-dex.jar` 实跑 `javap -p -s`，守恒脚本输出 0 处不匹配；脚本须支持 `--jar <path>` 接收用户本机 jar（可选输入，不改变仓库内不含第三方代码的约束）。」

14 节风险表首行兜底列改为：

```markdown
定义：jar 跑通率 = 通过 T-23 逐方法断言的 jar 数 / 参与测试的 jar 数。
v1.1 的验收基准为自编模板 jar 100%；不对第三方 jar 的跑通率作承诺。
第三方 jar 不通过时源级灰显 + 原因提示，CMS / py / js 三类运行时仍须可用；
样本由用户在本机提供，不入库。
```

---

## R10【口径】JDK 8 与 `jlink --add-modules java.net.http` 冲突

**位置**：2 节 JDK 行、13 节 jlink 命令、7.4 / T-21 桩类编译。

**原文**：2 节「17（仅打包期做 `jlink` 裁剪）；**开发期可探测用户已有 JDK 8 直接跑 jar**」；13 节 `jlink --add-modules java.base,java.net.http,java.logging,jdk.unsupported ...`。

**问题**：`java.net.http` 是 JDK 11+ 模块，`jlink` 也是 JDK 9+ 工具，JDK 8 两者都没有；开发期与打包期用两套 JDK，还会带来字节码版本与桩类签名漂移。「开发期跑 JDK 8、交付跑 JRE 17」无法验证一致性。

**建议替换**：

- 2 节 JDK 行：「**JDK 17（开发、编译、`jlink` 裁剪统一使用 17）**；不探测、不兼容 JDK 8。用户机器无 JDK 17 时，README 指引安装或直接使用随包裁剪 JRE。」
- 13 节 jlink 命令后补：「`stubs.jar` 与 `SpiderRunner` 一律以 `--release 17` 编译，禁止用更低版本 JDK 生成字节码。」
- 7.4 签名基线补：「桩类编译产物与运行 JRE 版本必须一致，版本不一致时 T-20 判 FAIL。」

---

## R11【可行性】T-32 的「按需版 ≤25MB」与 Python 随包分发冲突

**位置**：2 节 Python 行、3.3、13 节、T-32。

**原文**：「Python 3.11 Windows embeddable ... **随产品分发**」；13 节「把 `Lib/site-packages` 和适配层源码一并放入」；T-32「NSIS 安装版 + 便携版；**JRE/mpv 可按需下载**」「安装包 ≤130MB（**按需下载版 ≤25MB**）」。

**问题**：按需下载版只把 JRE / mpv 摘出去，Python 仍随包，而 Python embeddable + Lib 加主程序与前端资源，25MB 几乎不可能达成。更根本的是 T-05（P0）就依赖 Python 做 `config.decrypt` / `config.normalize`，若 Python 也按需下载，P0 离线闭环不成立，且首启下载会违反 0 节「测试网络目标只能是 127.0.0.1」。

**建议（方案 A 推荐）**：明确 Python 随包、把 25MB 改为实测口径。

T-32 验收替换为：

```markdown
两种形态均能启动；安装包 ≤130MB；「不含 JRE / mpv」的按需下载版体积以
`docs/size-report.md` 的实测值为准（v1.1 目标 ≤45MB，含 Python embeddable 与前端产物）。
JRE / mpv 按需下载；Python 适配层为 P0 必备，一律随包分发，不得按需下载。
```

13 节补：「T-32 前产出 `docs/size-report.md`，逐项列出主程序、前端产物、Python embeddable、JRE、mpv 的实测体积（压缩前 / 后），指标以该文件为准，不在正文写未经实测的数字。」

**方案 B（不推荐）**：Python 也按需下载 → 必须同步修改 0 节离线约束、T-05 验收与 12.1 stub_server 说明，并新增「首启引导下载 / 离线降级」任务，P0 工期与验收口径都要重排。

---

## 需要你拍板的 5 个决策

| # | 决策 | 推荐 | 影响 |
|---|---|---|---|
| 1 | JS 隔离：A 下沉 sidecar / B 进程内 + 中断回调 | **A** | 决定 R4、R5、T-16、4.1、3.2、第 5 节、13 节 |
| 2 | Python 并发：线程池 / 多常驻进程池 | **线程池（8 workers）** | 决定 R6 的 7.2.1 措辞、T-13 / T-17 验收 |
| 3 | proxy 加固：目标白名单 / 一次性 token | **白名单** | 决定 R7、11.2、是否登记「硬编码 9978 失效」 |
| 4 | 25MB 指标：放宽为实测（Python 随包）/ Python 也按需下载 | **放宽为实测** | 决定 R11、T-32、13 节，选 B 还要改 P0 离线约束 |
| 5 | 契约一致性：轻量校验脚本 / 引入代码生成链 | **轻量校验** | 决定 R8 是否触发 0 节第 3 条「新增依赖须请求确认」 |

无争议、建议直接采纳：R1、R2、R3、R9、R10。

## 按章节汇总的改动清单（确认后据此改云端文档）

| 章节 | 改什么 |
|---|---|
| 0 节 | 第 1 条补 `N/A` 门禁语义；第 6 条补「目标 jar」定义 |
| 2 节 / 3.2 / 3.3 | JDK 统一 17；`rquickjs` 用途随 R4 改；Python 随包口径 |
| 4.1 / 4.3 / 5 | 拓扑图补 `config_remove`、JS sidecar 化；数据流补 7.2.1；目录树补 `contracts/`、`qjs-runner/`、`size-report.md` |
| 6.2 / 7.1 / 7.2 / 7.5 | `AppError` 补字段 + schema 真源；command 清单唯一真源；方法集合区分 + 新增 7.2.1；proxy 白名单 + 7.5.1 注入表 |
| 8.4 / 8.5 | 方法数量表述对齐（8.5 不动） |
| 9 节 | T-03、T-04、T-08、T-11、T-13、T-14、T-16、T-17、T-19、T-20、T-23、T-25、T-27、T-32 的验收列 |
| 10 节 | 超时行覆盖 py/js/jar；并发行与 7.2.1 对齐 |
| 11.1 / 11.2 | 删 `shell:allow-spawn`、明确 Rust 唯一拉起；隔离表述按 R4 方案；proxy 白名单 |
| 12.2 / 13 / 14 | 累积断言矩阵；`externalBin` 清单 + 体积报告；jar 跑通率量化 + 风险项 |

## 确认后我会怎么做

1. 按你选定的方案，逐条把「建议替换文本」写进云端规格书（或你自行粘贴，我不动云端文档）。
2. 在文首把版本号改为 v1.1，并加一条简短的「v1.1 修订说明」（列出改动章节与决策结论）。
3. 同步更新本地 `AGENTS.md` 的「开工前待澄清」段，把已确认项从待办移除。
4. 之后才按 P0 / T-01 起建工程。

> 本轮未改动云端规格书，未创建任何源码、构建脚本或 Git 仓库。
