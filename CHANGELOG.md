# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循语义化版本。**唯一版本来源**是 `package.json`，同步清单与发布流程见 `docs/RELEASING.md`。

---

## [1.0.3] — 2026-11-14

补丁版。修掉中文 Windows 上的导入失败（`malformed frame: Expecting property name enclosed in double quotes`）。

### 修复

- **没有导入配置时进入「直播」页白屏**：`src/routes.tsx` 的 `LivePageRoute` 用 `useAppStore((s) => s.cache?.lives ?? [])` 取直播源，`cache` 为 null 时选择器每次渲染都返回一个新数组，zustand 的 `Object.is` 比较永远判「变了」，于是无限重渲染直到 React 抛 `Maximum update depth exceeded`。改为 `selectLives` + 模块级 `EMPTY_LIVES` 常量（与站点选择器的 `EMPTY_SITES` 同法），并补 3 条单测锁住「空 cache 时引用恒定」。
- **导入报 `malformed frame: Expecting property name enclosed in double quotes: line 1 column 8189`**：Python 适配层的 stdin/stdout 在 Windows 上默认按**系统 ANSI 代码页**解码（中文系统是 cp936/GBK），宿主写入的 UTF-8 帧被按 GBK 解码，中文站名处字节错位，`json.loads` 在 ~8 KiB 处失败。1.0.1 时这类坏帧被静默丢弃，表现为「`config.decrypt exceeded 15000ms`」；1.0.2 补上坏帧回帧后，同一个根因才以 `malformed frame` 现形。现场日志特征：`config decrypt bytes=31255 took_ms=2 ok=false` 紧跟一条 `INTERNAL / malformed frame`。
- 适配层启动即把 `stdin` / `stdout` / `stderr` 固定为 UTF-8（`reconfigure`），并把 `PYTHONUTF8` / `PYTHONIOENCODING` 写入环境变量，让 `pyspider` 派生的子进程继承；宿主 spawn sidecar 时也注入这两个变量（新增 `Guarded::spawn_with_env`），解释器从启动就是 UTF-8 模式。
- `sidecars/py/pyrun.py` 改成按字节读写（`json.load(sys.stdin.buffer)` + `sys.stdout.buffer.write(..., "utf-8")`），彻底不依赖 locale；JVM runner 早已显式用 UTF-8，无需改动。
- **首页卡片右侧一直空一条**：`.vod-grid` 的列宽写死了 `minmax(220px, 260px)`，1440 窗口扣掉滚动条后只放得下 4 列、每列顶到 260px，行尾白空约 80px。改成只给下限、上限交给可用宽度均分（`minmax(200px, 1fr)`），列数按 `下限 + 列距` 自动增加：1440 窗口从「4 列 × 260px + 80px 空白」变成「5 列 × 222px 铺满」，1024/1280/1680 分别是 3/4/6 列，`.sk-grid` 骨架同步。卡片高度随之变小，`contain-intrinsic-size` 的占位值从 418px 校正到 364px。
- **点「下一集」时下方的封面、标签、简介、选集会先消失再长回来**：`PlayerHost` 的 key 含 `playUrl`，换集必然整块重挂（为防双流双声刻意保留）；重挂后 `useEpisodeList` 的片单从空开始，`PlayerAbout` 先渲染「无封面」、选集面板整个消失，等 `api.detail` 回来才恢复。现在用前端 `pageCache`（10 分钟 TTL）里的详情做首帧种子：先按播放地址精确匹配线路/集，再按 `playFrom + 集名` 兜底；海报的代理地址也会记住（上限 400 条 FIFO），重挂时直接复用。debug 窗口实测换集后 40/120/260/500/1000/2000/3500 ms 七个采样点，标题、4 个标签、简介、36 集选集、海报全程在位，只有当前集与视频地址在变。
- **粘贴文本导入后首页报 `fetch ./py/douban.py failed`**：文本导入的 origin 是 `inline`，没有 base URL，配置里 `./py/douban.py` 这类相对脚本地址解析不出来，运行态却仍把这些站点当可用（这份 `box.json` 的 101 个站点里有 53 个是相对写法）。现在派生运行策略时把「相对地址且没解析成绝对地址」的站点标 `enabled=false`，原因写「相对地址只有从 URL 导入的配置才能解析，请改用「导入 URL」」；导入原件一个字段不动，之后改从 URL 导入同一份配置仍会解析成绝对地址并启用。导入成功提示也改成按 `disabledReason` 去重展示（不再写死「不支持的 jar 源」）。
- **空态被一整块虚线框包住、下方大片空白**：`.empty` 原来是整宽虚线框 + 76px 内边距，首页「该站点暂无推荐内容」看着像坏掉的占位图。改成无边框居中列（限宽 460px、`min-height: clamp(240px, 44vh, 420px)`），图标换成 52px 细描边圆底里的语义图标（缺省 `Inbox`；首页 `FolderOpen`、直播 `Tv`、搜索 `SearchX`、收藏 `Star`、历史 `History`），动作按钮是唯一的强调色元素；直播页占位框与站点选择器里的空态单独收掉 `min-height`，避免重复撑高。
- **搜索页初始态还是一行灰字提示**：没输入关键词时的引导是手写的 `.search-hint` 段落（旧样式的虚线框），和新的空态组件不是一套东西。现在初始态也走 `Empty`：有可搜索站点时给「输入片名或关键词开始搜索」，一个站点都没有时给「还没有可搜索的站点」+「去导入配置」（直接跳设置页）；`styles.css` 里删掉 `.search-hint` 规则。新增 `tests/frontend/emptyStates.test.ts`（5 条）锁住「所有列表页的空态走同一个组件、搜索页不再退回手写提示」。
- **直播页与其它页不是一套版式（播放器还被压扁、节目单挤不下）**：原来直播页是自成一体的「工作台」——宽度改到 1560、内边距 24、右列 `overflow-y: auto`，节目单展开时列高不够，16:9 的 `.player-stage` 被 flex 压成 1030×262 的扁条。现在：页面宽度/内边距/页头与其它页一致（1360 / 30+36，页头天然吸顶）；右列不再滚；画面按 `aspect-ratio: 16/9` 锁死、宽度 `min(100%, calc(56vh * 16 / 9))` 居中；频道名与清晰度并成画面左上角一块半透明胶囊（原 `LiveChannelBar` 整行删除），线路切换留在播放器自带控制条里；节目单上移到画面下方，默认展开，自己内部滚（`flex: 1` + `overflow-y: auto`），不再压画面。
- **直播停在后台就没声了 / 直播和点播能同时出声**：直播页现在和点播播放器一样常驻在 `AppShell`（首次进过 `/live` 才挂载，之后切页只切 `visibility`，不销毁 `<video>`），切到搜索/设置/详情时后台继续播；进点播播放页时直播暂停（记下「是我暂停的」），回到 `/live` 时恢复；反向「直播出画就按停点播、换台也先按停点播」，两边不会同时出声。
- **页面异常不落日志**：React 渲染异常被 react-router 的默认错误页接住后不会冒泡到 `window`，`installGlobalErrorLogging()` 抓不到。现在根路由挂 `errorElement`（`RouteError`），异常会写一条 `route error`（message / stack / hash）到前端日志通道，同时给「重试 / 回到首页 / 复制错误」三个动作。
- **搜索页「封面一直在渲染」**：流式结果每来一批，列表增长就会让 `key` 里的数组下标变化，React 把卡片当新节点重挂，`<img>` 跟着重新下载封面（实测早期 18 张卡在 10 秒内全部被重挂、同一张封面重复请求）。`key` 改成 `siteKey + vod_id`（首页列表同理）；另外反代 `/image` 以前对「状态 200 但 `Content-Type` 是 `binary/octet-stream`」的真图直接 502（`pic.drleao.cn`、`pic.cdn.drama.9ddm.com`、`xjimg.cdn-xj.cc` 都这样），现在按魔数嗅探 JPEG/PNG/GIF/WebP/AVIF/BMP 后补对类型放行，认不出才拒；代理仍失败时前端直连原图再试一次。搜索 167 张卡片的封面失败数从约一半降到个位数。
- **搜索等待态的进度面板观感**：原来的「扫光条 + 一行灰字」在结果区上方，配合卡片骨架里的 22px 蓝色转圈，看起来像一屏坏图；改成单行「呼吸点 + 进度文案（超宽省略） + 已等待 N 秒 + 取消」，底部发丝线与结果区分隔；骨架去掉转圈只留扫光。

### 工程

- **配置解密与归一化搬进 Rust**：`config.decrypt` / `config.normalize` / `config.mergeRepos` 以前每次导入都要绕一趟 sidecar（排队、序列化、超时预算都在这条链上），现在是进程内的纯函数调用 —— 新增 `src-tauri/src/domain/config/decrypt.rs`（明文/图片马/XOR/base64/gzip/数字前缀/JSONC 清洗）与 `normalize.rs`（别名、相对地址解析、headers 表、lives/parses、多仓合并），`import.rs` 只剩取字节、解密、归一化三步。真实 `box.json` 导入实测 144 ms（直连）／562 ms（走加速），101 站点 / 17 直播 / 21 解析。两条往字节里塞字符的路径（`strip_jsonc`、`drop_trailing_commas`）改成按字符走，否则中文站名会被拆成替换符。
- **外部文本一律洗成 UTF-8 再进内存**：新增 `src-tauri/src/infra/textio.rs`（BOM → 严格 UTF-8 → `Content-Type` 声明 charset → GB18030 兜底 → 宽松解码），接入配置拉取、配置文件读取、Python 源码快照、qjs 引擎脚本、反代 m3u8 与百分号解码、诊断导出。`reqwest` 不带 `charset` 特性，`Response::text()` 恒按 UTF-8 硬解，中文圈配置（GBK/BOM）以前会整份变问号。
- **CMS 与直播解析搬进 Rust**：新增 `src-tauri/src/domain/spider/cms_parse.rs`（JSON/XML 采集响应 → 契约字段，含 `class` 对象转列表、`ac=detail` 的 `data`/`result`/`vod` 包裹兜底）与 `src-tauri/src/domain/live/{m3u,epg}.rs`（M3U 属性/多线路合并、XMLTV 流式两遍扫描 + 频道名匹配 + 当天节目窗口）。`site.parse*` / `live.parseM3u` / `live.parseEpg` 不再经过适配层，sidecar 只保留第三方源脚本的执行（`site.*` 的 py/js/spider 运行时一行未删）。
  - M3U：连续多条 URL 归并到上一条 `#EXTINF` 的频道（TVBox 的 `一个台名 N 条线路` 写法），同名同组频道合并 `urls` 去重。
  - EPG：覆盖率 9 天的 `e.xml` 单频道可吐 2000+ 条，按 `date` 当天 / 前后 3–21 小时裁剪到 240 条；`CCTV1` 不会被 `CCTV11` 的节目单污染；XML 实体二次转义（`&amp;apos;`）在上屏前解开。
- `tests/offline/adapter_isolation.py` 增至 **14 项**：新增「`PYTHONIOENCODING=gbk` / `cp936` 下 14 KB 中文配置仍能原样解出」两条。用修复前的 `main.py` 跑这两条必失败（乱码或拆帧错位），修复后全绿。
- **直播页常驻层与错误边界**：`routes.tsx` 里 `/live` 只留占位路由，页面本体由 `AppShell` 在首次进入后 `lazy` 挂载并常驻（外层自带 `Suspense`，否则点侧栏这种同步输入挂载懒组件会抛 `A component suspended while responding to synchronous input`）；根路由挂 `RouteError` 错误页。新增 `tests/frontend/posterFallback.test.ts`（2 条源码契约）锁住「代理失败只直连重试一次」。
- `vitest` 排除 `.agents/`：隔离用的 git worktree 也在这棵树里，默认会被扫进去，导致用例数翻倍（326 → 658）、失败还分不清归属。
- **日志按用途分三个通道**：`logs/app/`（宿主 Rust）、`logs/ui/`（前端，`tracing` target 固定 `ui`）、`logs/spider/`（Python 适配层）。滚动与过滤换成官方库 —— `tracing-appender`（`Rotation::DAILY` + `max_log_files`）与 `EnvFilter`，删掉自写的 `DailyFile` / `SharedWriter` / 级别解析；前端通道靠 `Targets` 过滤，两路写入各自 `non_blocking`（guard 常驻，退出时 flush）。
  - 每个通道保留最近 7 天，硬上限 **10 MiB**：超出时删最旧的一整天，不去切正在追加的句柄（`tracing-appender` 上游只支持按时间滚动）。适配层同样 10 MiB，超出滚成 `.1`。
  - 升级时就地迁移：旧的 `logs/luma-*.log` 搬进 `app/`，`logs/spider.log*` 搬进 `spider/`，用户不会看到「新旧两套目录」。
  - 适配层路径由宿主 spawn 时注入 `LUMA_ADAPTER_LOG`，诊断/反馈文件里的日志项带上 `channel` 字段。
- **调试构建与正式版可区分**：`tauri dev` 起的窗口和同机安装的正式版版本号、图标完全一样，打包前不好认。后端用官方 `tauri::is_dev()`（未启用 `custom-protocol` 即 dev）把窗口标题改成「Luma <版本> (Dev)」；前端用 `import.meta.env.DEV` 在侧栏版本号后加一枚 DEV 胶囊。不用 `debug_assertions`，因为 `tauri build --debug` 也满足但那是产物包。
- **测试目录按四层归口**：前端纯函数用例从 `tests/frontend/` 迁到被测模块旁（`src/lib/*.test.ts`，12 个文件、import 一次性改写），`tests/frontend/` 只留 6 个读源码文本的跨文件约定测试；`tests/e2e/` 拆成 `tests/offline/`（9 个确定性检查，全部接进 `tools/check.py`）与 `tests/acceptance/`（spec 12.2 阶段验收 `p0.py`~`p3.py`），`t05_config.py` 更名为 `config_shapes_check.py`。新增 `docs/TESTING.md` 说明四层各自放什么、跑什么命令。`python tools/check.py` 的语法检查范围随之覆盖整个 `tests/`。
- **移除随包 mpv 与「解码失败自动转外部播放」**：这条兜底从来没真正可用 —— `domain/mpv.rs` 去 `<resource>/sidecars/mpv/mpv.exe` 找可执行文件，但 `tauri.conf.json` 从未把它打进安装包，安装版永远只会得到 `mpv.exe not found`，而前端文案却在说「已自动交给 mpv」。现在整条链路删掉：`mpv_play` command、`domain/mpv.rs`、前端 `api.mpvPlay` 与 `mpvTried` 状态机、`tools/probes/probe_mpv.mjs`、`sidecars/mpv/`（117 MB）、`prepare_runtime.py` 的 stage 步骤、以及 `PlayTarget.kind` 里的 `"mpv"`。`<video>` 报 `MEDIA_ERR_DECODE` / `SRC_NOT_SUPPORTED`（HEVC 常见）时只走换线路 → 换源；`EXTERNAL_PLAY_ENABLED` 继续只管 `open_external`，源码契约测试同步断言前端不再出现 `mpv`。
- **移除 jar/JVM 运行时**：社区配置里的 jar 是 Android dex，Win x64 跑不起来（父类 `com.github.catvod.crawler.Spider` 不在 jar 内 + 缺 Android 运行时），`sidecars/java` + `sidecars/jre`（27.5 MB）此前只服务维护态回归。现在整条链路删掉：`domain/spider/jvm.rs`、`spider/mod.rs` 的 `Jvm` 运行时与 `JVM_RUNTIME`、`sidecars/java/`、`sidecars/jre/`、`tauri.conf.json` 的打包 resources、`prepare_runtime.py` 的 jlink 步骤、`tests/acceptance/p2.py`、`tools/javap_conserve.py`、`tools/probes/probe_jvm_ui.mjs`、`tests/fixtures/jars/`。**契约里的 `"jvm"` 分类保留**：`contracts/tvbox.schema.json`、`normalize.rs` / `normalize.py` 的 route、`derive.rs` 的 `disabledReason` 都不动，jar 站点仍被识别为 `jvm` 并在导入时屏蔽（「jar 源为 Android dex，Windows 端暂不支持」），只是不再有任何 JVM 通道。`cargo test --lib` 159 → 151（`jvm.rs` 的 8 条回归随运行时删除）。

---

## [1.0.2] — 2026-11-14

补丁版。修掉「导入配置偶发 15 秒超时」，并让这类故障以后能被复盘。

### 修复

- **导入报 `python adapter config.decrypt exceeded 15000ms`**：这行字是宿主对 sidecar 的单次墙钟（15s）到期，不是解密失败 —— 同一份 `box.json` 实测解密 7ms、归一化 3ms。根因是 Python 适配层只有一条 8 线程 FIFO 队列，`config.*` 与 `spider.py` 共用：一次 `spider.py` 能占住 worker 到子进程结束（最长 15s），导入就排在它后面一路等满 15s，字面却像「解密花了 15 秒」。现在 `config.*` / `ping` 走独立车道（2 线程），导入不再排在爬虫调用后面。
- **导入预算与爬虫预算分离**：`config.decrypt` / `config.normalize` / `config.mergeRepos` 使用独立的 30s 预算（`CONFIG_CALL_TIMEOUT`），不再与单站请求共用 15s。
- **超时不再留下继续跑的调用**：宿主放弃某次调用时补发 `__cancel__`，避免 sidecar worker 白跑、用户重试排在它后面。
- **坏帧不再静默丢弃**：帧解析失败时，只要还能从残帧里捞出 `id`，适配层就回一帧 `malformed frame` 错误帧，而不是让宿主干等 15s（静默丢正是「超时」伪装成「慢」的另一条路径）。

### 工程

- 新增 `tests/offline/adapter_isolation.py` 并接入 `tools/check.py`（回归基线 7/7 → **8/8**）：占满 8 个爬虫 worker 后 `config.decrypt` / `ping` 必须立即返回；坏帧必须回错误帧；每次 `config.*` 必须落一条 `adapter_latency`。
- 诊断补齐：`config.decrypt` 在 `luma-*.log` 记 `bytes` / `took_ms` / `ok`；适配层日志记 `adapter_latency`（耗时 + 字节数）与 `bad_frame` —— 1.0.1 那种「只有一句超时、没有耗时」的现场以后可复盘。
- 版本号五处同步至 `1.0.2`（`package.json` 为唯一来源）。
- 构建产物：官方 `tauri build` 产出 `src-tauri/target/release/bundle/nsis/Luma_1.0.2_x64-setup.exe`（**38.75 MiB** / 40,629,359 字节；`luma.exe` 7.83 MB，内含 `1.0.2` / `dev.luma.desktop` 与应用 chunk `usePlayerEngine`）。比 1.0.1 的 40.48 MiB 小 1.73 MiB，主因是 `Luma.exe` 18.10 → 7.83 MB：1.0.1 的安装器构建于 `d9a4994`（release profile 对齐官方 App Size 建议）之前，1.0.2 是首个吃到 `lto = true` / `opt-level = "s"` / `panic = "abort"` 的发行包。体积口径见 `docs/size-report.md`。

---

## [1.0.1] — 2026-11-14

补丁版。修复正式版发布当日发现的一个 GUI 体验缺陷。

### 修复

- **拉起 sidecar 时弹出控制台窗口**：`luma.exe`（GUI 子系统）此前以默认标志启动 `qjs-runner.exe` / `python` / `java` 等控制台子系统 sidecar，Windows 会为子进程分配一个新控制台窗口（黑框）。统一在 `infra/process.rs::Guarded::spawn` 注入 Windows `CREATE_NO_WINDOW (0x08000000)`，并同步覆盖 `mpv.rs` 直接拉起 `mpv.exe` 的点位；一处修复覆盖全部 sidecar 出入口。安装版启动不再出现任何命令行窗口。

### 工程

- 版本号在 `package.json` / `Cargo.toml` / `Cargo.lock`(luma) / `tauri.conf.json` / `sidecars/py/main.py` 五处同步至 `1.0.1`，保持单来源 `package.json` 不变。
- 构建产物：官方 `tauri build` 产出 `src-tauri/target/release/bundle/nsis/Luma_1.0.1_x64-setup.exe`（**40.48 MiB**；`luma.exe` 内含 `1.0.1` / `dev.luma.desktop` 与应用 chunk `usePlayerEngine`）。体积口径见 `docs/size-report.md`。

---

## [1.0.0] — 2026-11-14

首个正式版。交付形态为 **NSIS 安装器**（官方 `tauri build` 打包，双击安装；不再出便携 zip）。

### 能力范围

- **配置**：导入 URL / 本地文件 / 文本、多配置保存与切换、自定义命名、订阅定时刷新、GitHub 资源加速（3 个内置前缀 + 直连，可测速切换）。导入与运行双快照隔离，`imported` 永不被策略改写。
- **点播**：CMS 采集、Python `base.spider`、JS（drpy2 / ESM，`qjs-runner`）三类源；全站聚合搜索逐站流式上屏且可打断（改词重搜不串结果）；失败源按原因分组并可单站重试；详情页线路/选集、手动换源、跨站自动换源。
- **播放**：ArtPlayer + hls.js / mpegts.js（FLV）；本地反代 `:9978` 重写 m3u8 相对分片、透传 UA/Referer/Cookie、封面 `/image`；第 4 级隐藏 WebView2 嗅探；解码失败转 mpv；播放偏好记忆、自动下一集、历史进度续播。
- **直播**：m3u/m3u8 解析与代理重写、多线路切换、XMLTV EPG 与台标。
- **数据**：SQLite 单库（配置快照 / active / 收藏 / 历史），便携模式数据随 `data/` 目录移动。
- **诊断**：结构化日志（7 天轮转、URL 脱敏）、设置页复制诊断信息 / 打开日志目录 / 导出反馈文件、`LUMA_SELFCHECK=1` 启动自检。

### 工程

- **随包运行时优先**：`sidecars/jre`、`sidecars/python-embed` 由 `sidecar_roots()` 统一探测，dev 与交付同源，**用户无需安装 JDK 17**。JDK 17 仅在重建 JRE / 编译 `runner.jar` 时需要（构建期）。
- **契约**：`contracts/tvbox.schema.json` 补齐 `Site.searchableDeclared`、`SpiderRequest.stream` / `streamId`，schema 与 TS 的 8 个类型、7 个 SpiderMethod 全对齐。
- **回归**：`tools/check.py` 一键离线检查；`tools/run_probes.mjs` 窗口探针；版本探针改为从 `package.json` 动态读取，升版本不再假失败。
- **文档**：新增 `CHANGELOG.md`、`docs/ARCHITECTURE.md`（架构 + ADR）、`docs/DEVELOPMENT.md`（调试）、`docs/MAINTENANCE.md`（维护/升级）、`docs/RELEASING.md`（发布）；`docs/project-layout.md` 目录树同步。历史评估类资产（旧修订建议、UI 走查、逐站实测快照等）不再随仓库分发，只保留在 git 历史中。
- **体积达标**：官方 `tauri build` 产出的 NSIS 安装器 `Luma_1.0.0_x64-setup.exe` **40.38 MiB**（约 42.3 MB 磁盘）。做法是移除 `qjs-runner.exe` 的运行期永不命中的第二份副本（-1.50 MB），而非删功能或放宽目标；`[profile.release] strip = "symbols"` 实测无额外收益，作为常规优化保留。详见 `docs/size-report.md`。
- **构建产物**：官方 `tauri build` 产出 `src-tauri/target/release/bundle/nsis/Luma_1.0.0_x64-setup.exe`（40.38 MiB）。前端由 Tauri 在构建期嵌入 exe，不再单独产出 zip。本次完成**无窗口静态验收**（安装器内 `luma.exe` 含 `1.0.0` 与 `dev.luma.desktop`、不含 `1.0.0-alpha`；嵌入的应用 JS chunk `usePlayerEngine` 可命中），GUI 启动冒烟与 `LUMA_SELFCHECK` 按计划本地确认。
- **可追溯性**：构建时工作区存在的 2 个既有改动（`src/pages/SearchPage.tsx`、`src/styles.css` —— 搜索框内嵌清除按钮，含清空结果/复位状态/作废在途代次）已在发版整理阶段单独提交。release 包、`v1.0.0` tag 与 HEAD 内容一致，无需重新打包。

### 明确不支持 / 已知限制

- **jar 源（社区配置）不支持**：Android dex jar 依赖 ART / OkHttp / gson / `android.util.*`，Win x64 无法加载；导入时 `runtime=jvm` 站点自动屏蔽。JVM 通道仅为 `p2.py` 回归与自编纯 class 模板 jar 保留。
- `parses[]` 只实现 type 0 / 1 / 4；type 2/3 依赖 jar 反射，直接返回「不支持」。
- JS 源尚未覆盖 drpy2 `initEnv` 完整 polyfill 与 FongMi class-based `Spider` 规范。
- T-31（`tvbox://` 协议关联、JumpList、全屏勿扰）未实现，规格要求逐项手工验收。
- mpv 不随安装包分发（单文件约 117MB），需要时自行放入安装目录的 `sidecars/mpv/`。
- 公开源失效频繁，属正常现象；自动换源与源级原因提示是必需能力。

---

## [1.0.0-alpha] — 2026-11-11 ~ 2026-11-14

试运行版本。完成 P0 ~ P3（T-31 除外）：Tauri v2 + React 骨架、四类源适配层、SQLite、ArtPlayer、便携打包、CDP 探针回归体系。真实配置「导入 → 全站搜索 → 详情 → 播放」出画（101 站点 / 17 直播源）。逐轮过程记录不随仓库分发。
