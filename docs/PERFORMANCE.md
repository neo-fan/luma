# 性能链路分析（PERFORMANCE）

> 给维护者的性能观测入口。架构总览见 `docs/ARCHITECTURE.md`；环境/调试见 `docs/DEVELOPMENT.md`。
> 本文写「性能怎么看、测了什么、瓶颈在哪」，不重复功能说明。

## 1. 为什么要链路级分析

Luma 的一次用户操作跨三层：**前端 WebView2（React）→ Tauri 主进程（Rust）→ sidecar / 源站**。
历史上性能排查是点状的：

- `switchTrace`（`src/lib/switchTrace.ts`）只覆盖「解析 / 换台 / 换集」两个业务点；
- `tools/diag/diag_resolve_timing.mjs` 只计时单个 command；
- CDP Performance 面板能看到主线程任务，但和日志里的业务阶段对不上。

结果就是「点下去卡了 20 秒」时无法回答**卡在哪一层**。本工具把三层合成一条时间线。

## 2. 三层观测模型

| 层 | 数据源 | 采集方式 | 回答的问题 |
|---|---|---|---|
| 前端主线程 | CDP `Performance.getMetrics` + `PerformanceObserver` | `tools/perf/analyse.mjs` | JS / 布局 / 长任务是不是瓶颈？ |
| IPC | `src/lib/perfTrace.ts` 环形缓冲 | `invoke.ts` 的 `call()` 单点计时，CDP 探针 drain | 哪个 command 慢、慢多少？ |
| 单站分解 | 后端 `aggregate` 返回行的 `timing` 字段 | `onSearchChunk` 单点采集 → 同缓冲 drain | 这条长尾是排队还是源站？ |
| 业务阶段 | `startTrace` 写入 ui 日志的 `trace` 行 | 工具按采样时间窗过滤日志 | 解析 / 出画各阶段耗时？ |

关键设计：

- **IPC 埋点只在 dev 生效**：`perfTrace.ts` 用 `import.meta.env.DEV` 守卫，生产构建里 `record` 是 no-op，连 `performance.now()` 都不调。
- **缓冲有界**（500 条，覆盖最旧），不记 args / 返回值，播放直链与配置地址不会进可导出数据。
- **工具不做断言**：只产出 JSON + 可读摘要，断言仍归 `tools/probes/`。

## 3. 用法

前置：dev 窗口已就绪（CDP `:9222`，见 `docs/DEVELOPMENT.md` §2.3）。

```bash
# 空闲基线（无操作，测后台噪声）
node tools/perf/analyse.mjs --scenario idle --wait 3000

# 冷搜索：等到 IPC 静默再收尾（扇出 70 个源常需 20~40s）
node tools/perf/analyse.mjs --scenario custom \
  --expr "location.hash='#/search?q=流浪地球'" \
  --until-idle --wait 4000 --max-wait 90000

# 播放启动：走真实导航桥，指定站点/片/线路
node tools/perf/analyse.mjs --scenario play --site 创享 --vod 92593 --line 量子 \
  --until-idle --wait 4000 --max-wait 90000

# 缓存命中的首页（第二次跑，用于对比冷/热）
node tools/perf/analyse.mjs --scenario home --until-idle --wait 2500
```

内置场景：`idle` / `home` / `search` / `detail` / `play` / `custom`。
参数：`--wait`（静默判定毫秒）、`--until-idle`、`--max-wait`、`--site`、`--vod`、`--line`、`--expr`、`--out`。

输出落在 `tools/.out/perf/<scenario>-<timestamp>.json`，字段：
`wallMs`（采样墙钟）、`metrics`（Performance 增量）、`ipc[]`（command 耗时）、
`sites[]`（单站耗时分解，仅聚合搜索有值）、
`longtasks[]`（>50ms 主线程阻塞）、`paints[]`（LCP/FCP）、`traces[]`（业务阶段）。

### 两个易踩的坑

1. **`--until-idle` 的静默计时从第一次 IPC 之后才作数**。若一个 IPC 都没有，`wait*2` 的启动宽限期内不结束——否则「页面初始化还没发请求」会被误判成链路已结束。
2. **场景导航必须走真实桥**（`navNavigate`），不能自己 `history.pushState`：React Router 不感知裸 pushState，会出现「URL 变了但 PlayerPageRoute 没收到 state」的假场景。`play` 场景已内置正确做法。

## 4. 实测基线（2026-11-24，dev / 2.1.1）

测试机：Windows 11 x64，WebView2 常青版，配置 101 站点 / 73 启用。以下为多次采样后的有效数据（已剔除工具修正前的脏样本）。

| 场景 | 墙钟 | 主线程 task | script | layout | IPC | 最慢 IPC | longtask | 业务 trace |
|---|---:|---:|---:|---:|---:|---|---:|---:|
| 空闲 3s | 3006ms | 0.26ms | 0.005ms | 0.03ms | 0 | — | 0 | 0 |
| 首页（缓存命中） | 5126ms | 0.70ms | 0.09ms | 0.002ms | 0 | — | 0 | 0 |
| 冷搜索（扇出 70 源） | 10197ms | 0.30ms | 0.19ms | 0.007ms | 1 | `spider_invoke` **21351ms** | 0 | 0 |
| 播放启动 | 5516ms | 0.60ms | 0.07ms | 0.05ms | 12 | `spider_invoke` 182ms | 0 | 5 |
| 原地换集 | 3581ms | 0.41ms | 0.01ms | 0.001ms | 1 | `spider_invoke` 493ms | 0 | 0 |

## 5. 可控边界与瓶颈结论

**前提**：搜索 / 播放都依赖第三方源站，源站的响应速度、可用率、返回质量是**外部不可控变量**。
因此「让慢源变快」不是优化项——性能工作的目标只能是：**在源站不可控的前提下，把我们自己这一侧的行为做到最优**。
下面按「可控 / 不可控」分开陈述。

### 5.1 可控：前端主线程不是瓶颈（已达标）

所有场景主线程 `TaskDuration` **< 0.8ms**，`ScriptDuration` < 0.5ms，longtask **为 0**，布局 < 0.05ms。
即便冷搜索墙钟 10 秒时主线程仍几乎空闲。React 渲染 / 布局优化在本项目规模下**收益极低**，不作为方向。

### 5.2 不可控：源站质量决定了绝对耗时

冷搜索单次 `spider_invoke` 21.4 秒，同窗口 ui 日志 `elapsedMs:31837 / failed:19 / failureGroups: unknown:7, timeout:...`。
这是 70 个第三方源并发扇出的客观结果——**哪些源快、哪些源挂、证书是否过期、CDN 是否加速**，都不由我们决定。
把这些数字当「要优化掉的瓶颈」是错配；它们只能作为**输入约束**，用于检验我们的应对策略是否有效。

但 §6 的分解补了一个重要限定：总墙钟里**有一半不是源站造成的**。70 站 / 20 并发时
`queue>run = 33/70`，即近半站点的排队时间超过它自己的执行时间；这些站的 `runMs` 常在
8~14s，说明源站响应慢（不可控），但让它们**重叠得更充分**是我们的并发度问题（可控）。
所以「源站不可控」不等于「时长全归源站」——归因要靠分解，不靠直觉。

### 5.3 可控：应对策略（现有实现已正确，勿回退）

针对「慢源不可控」，本项目已经做了正确的事，保护区如下：

| 机制 | 实现 | 作用 |
|---|---|---|
| 流式上屏 | `SearchPage.tsx` 订阅 `onSearchChunk`，每站回包即并进结果 | 用户看到结果的时间 = **最快源**，不是最慢源 |
| 合批降载 | 80ms 节流 + 预存 `matchScore` | 100+ 站陆续回包不触发上百次全列表调和 |
| 代次过滤 | `row.streamId === String(gen)` | 改词重搜后旧词结果不混入 |
| 去重 / 归类 | `seen` 集合 + `classifyFailure` | 慢源失败不刷屏，折叠成原因标签 |
| 总墙钟上限 | `streaming_budget_ms` clamp `[45s,120s]`，到点 `abort_all` | 防止慢网尾段把一次搜索拖到 637s（实测历史） |
| 单站超时 | `SITE_TIMEOUT` clamp `[2000,15000]` | 单源有界，不妨碍其它源 |
| 慢 ≠ 死 | 播放侧 4xx/5xx/非 m3u8/图片首分片才判死，超时算 unknown 连续 3 次 | 不因慢而误换源 |

**结论**：响应式体验已经与最慢源解耦（陆续上屏），总耗时也有硬上限。这部分**没有待办的架构改造**——
后续任何「优化搜索性能」的提议，先确认它没有破坏上表任一机制。

### 5.4 可控但需另测：播放首帧

播放启动 12 次 IPC 最慢 182ms、5 条业务 trace 均在 9ms 内——**解析链不慢**。
首帧出画耗时由源站 m3u8 + 首分片下载决定（不可控），但我们的**等待期表现**可控：
是否及时出画提示、stall 看门狗是否误判、重试是否正确。这些要配 `playerThroughputMeter` /
媒体事件计时单独看，不在本工具的 IPC 范畴。

### 5.5 原地换集 493ms 主要是单集解析

换集仅 1 次 `spider_invoke` 493ms（集级缓存未命中时的 playerContent + resolve）。命中缓存时这段接近 0。这是当前设计里可接受的开销。

## 6. per-site 耗时分解

聚合搜索只报一个 `tookMs` 时，「这次 33 秒」无法归因：可能是 20 个源都很慢，也可能是
4 个死站各占满 15s 超时、把健康源挤在后面排队。这两件事的处置完全不同，所以 `aggregate`
给每个站点回三段时间。

### 6.1 三段怎么切

后端在 `spawn` 前取一个共享 `Instant` 原点，站点返回时用同一把尺子量三个时刻：

| 字段 | 定义 | 长了说明什么 | 归谁 |
|---|---|---|---|
| `queueMs` | 拿到并发许可 − 入队 | 扇出并发度不够（`MAX_FANOUT = 20`），站点在等前一波让位 | **我的问题**：调并发 / 减站点 |
| `runMs` | 执行完 − 拿到许可 | 源站慢或挂，贴着单站超时即 `timeout` | **源站问题**：屏蔽候选 |
| `doneMs` | 执行完 − 聚合起点 | 瀑布图 X 坐标，也等于「这一站拖了总预算多久」 | 读数 |

三段同原点，因此 `doneMs ≈ queueMs + runMs`，差值就是任务调度延迟（通常 <5ms）。
`status` 取 `ok` / `failed` / `timeout` —— 超时与业务失败必须分开：前者屏蔽源，后者改配置。

行级字段同时出现在流式 `search-chunk` 与最终聚合结果里（同构），所以边搜边能看到分解。
总预算耗尽被 `abort_all` 掉的站点拿不到耗时，聚合结果用 `dropped: string[]` 单独列出它们的 key。

### 6.2 实测示例（dev / 2.1.1，70 个启用源，`MAX_FANOUT = 20`）

```
sites=70  status=ok:51 failed:15 timeout:4
runMs p50=8159 p90=14051 max=15016  queue>run=33/70（排队超过执行段）
slowest sites (done = queue + run):
  py_kkys        done= 32466ms  queue= 17450  run= 15016  timeout 源站超时→屏蔽候选
  py_xlys        done= 32263ms  queue= 17250  run= 15013  timeout 源站超时→屏蔽候选
  py_mifun       done= 31411ms  queue= 17572  run= 13839  ok      双高→慢源+排队
  py_shanzha     done= 30260ms  queue= 15253  run= 15007  timeout 源站超时→屏蔽候选
  py_dsystv      done= 27215ms  queue= 14454  run= 12761  ok      双高→慢源+排队
  py_qiyoudy     done= 26864ms  queue= 16773  run= 10091  ok      双高→慢源+排队
  py_YYMP3       done= 25222ms  queue= 10221  run= 15001  timeout 源站超时→屏蔽候选
```

同配置第二次采样（换关键词）复现同一形态：`ok:43 failed:14 timeout:13`、`queue>run=32/70`、
最慢三站 queue 16~18s。**排队段稳定在 15~18s，说明它不是偶发抖动**：70 站 / 20 并发
= 4 波，处在后段的健康源必然先等前几波放许可。

### 6.3 怎么读

| 形态 | 判定 | 动作 |
|---|---|---|
| `status=timeout`，`runMs ≈ 单站超时` | 源站死/被墙 | 进配置层屏蔽清单，别再让它吃满 15s |
| `queueMs > runMs` 且 `runMs < 1.5s` | 源站本身很快，纯粹在排队 | 我的问题：调 `MAX_FANOUT` 或裁站点数 |
| `queueMs` 与 `runMs` 都大（双高） | 慢源 + 排队叠加 | 先按慢源处置，压掉它 queue 自然回落 |
| `runMs` 占 `doneMs` 大头 | 执行主导 | 关注该源长期趋势，单次慢不算 |

不要只看 `doneMs` 排名：第 4 波的健康源 `doneMs` 和跑满超时的死站一样难看，
但前者 `runMs` 只有几百毫秒。**这正是加分解的唯一理由。**

### 6.4 命令

```bash
node tools/perf/analyse.mjs --scenario search --site 庆余年 \
  --until-idle --wait 6000 --max-wait 70000
```

摘要直接打印上表；完整 70 站明细在 `tools/.out/perf/search-*.json` 的 `sites[]` 里。

## 7. 后续可做（都只在可控侧）

- 把 `perfTrace` 的 IPC 采样接进 `tools/run_probes.mjs`，给**我们自己代码**的耗时加阈值告警（如 command 从 10ms 退化到 1s）；阈值只覆盖本地路径，不对源站响应设限；
- 拿 §6 的 `timeout` 清单做一次 `MAX_FANOUT` A/B（20 → 32）：若 `queue>run` 比例明显下降而
  `timeout` 数不变，说明长尾是并发度造成的，可以调；若 `timeout` 上升，说明源站承载到顶，保持原值；
- 播放首帧链路（`playing` / `loadeddata` / 首分片完成）单独做媒体计时，用来验证**我们**的 stall 判定与提示时机是否合理。
