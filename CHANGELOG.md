# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循语义化版本。**唯一版本来源**是 `package.json`，同步清单与发布流程见 `docs/RELEASING.md`。

---

## [Unreleased]

### 修复

- **直播「爬虫自带代理」(localProxy) 回调对齐 TVBox/FongMi**：央视频 yangshipin（`py_yangshipin`，首页选择器里的「直播[py]」）这类 `live_mode=proxy` 的 python 爬虫，`play()` 不给直链，而是返回 `proxy?url=&type=m3u8&slug=cctv2` 让播放器回打宿主反代、再由爬虫自己的 `localProxy()` 现拉滚动直播列表。Luma 此前有两处不兼容：① `handle_proxy` 只在 URL 带 `do=` 时才回调爬虫，而这种爬虫的基址来自 `getProxyUrl()`（Luma 返回 `?url=` 而非 FongMi 的 `?do=py`），拼出的 URL 没有 `do=`、`url=` 又空 → 被当普通直连 `Url::parse("")` → 400；② 基类 `spider.py::proxy()` 是返回 404 的桩、不委派 `localProxy()`，而社区爬虫只实现 `localProxy`。修复：`handle_proxy` 对「`url=` 为空且带其它参数」的请求路由到爬虫 proxy 回调（正常分片/清单恒带非空 `url=`，不受影响）；基类 `proxy(params)` 委派 `self.localProxy(params)`（直接覆写 `proxy` 的爬虫不受影响，两者都不实现的仍回 404 桩）。实测该频道经反代首拉从 400 变为 `200 #EXTM3U` 滚动直播列表。`tests/offline/py_base_spider_check.py` 加「proxy 委派 localProxy」回归。

- **直播 m3u 解析对齐 TVBox：识别 `#EXTINF http-header="…"` 通用请求头属性**：TVBox 的 `ParseM3u8` 除 `http-user-agent` / `http-referer` 外，还读 `http-header="Referer=…;User-Agent=…"` 这种通用头；`domain/live/m3u.rs::parse_extinf` 此前只认前两支专用属性，遇到只把必需 Referer 写在 `http-header` 里的频道（如 Kimentanm/suxuang 源的「江苏卫视」非 4K 版：`http-header="Referer=https://litchi-play-encrypted-site.jstv.com/"`、五星体育 `Referer=https://live.kankanews.com/`）会把 Referer 整段丢弃，反代取清单被源站 403、表现为「直播播不出」。修复让 `m3u.rs` 成为唯一的头写法归一化点：拆 `http-header`（`;`/`,` 分隔，只取 Referer/User-Agent，未知键忽略），在专用属性未声明时补进频道的 `referer`/`ua`（专用属性优先，避免覆盖）。这两个字段本就全链路（`LivePage`→`usePlayResolution`→`resolve_play`→`build_proxy_url`→反代 `Fwd`）送达源站，故**未动 PlayRequest/前端/反代**。补 3 条单测（Referer 补齐、UA 补齐、多对拆分与优先级、未知键忽略），`live::m3u` 11 测全过。

### 变更

- **debug 与正式版反代端口分离（9978 → debug 9979）**：`proxy::DEFAULT_PORT` 按 `cfg!(debug_assertions)` 分叉——正式版仍 9978、debug 固定 9979。此前 debug 与在跑的正式版抢 9978、靠 `bind_listener` 回退到随机临时端口，端口不固定，且 JS/py 侧若按默认 9978 兜底会指向错实例。绑定后宿主把实际端口 `set_var("LUMA_PROXY_PORT")` 注入子进程环境（补齐此前只有 qjs 经 `active_port()` 拿真实端口、py `base/spider.py` 的 `getProxyUrl()` 因环境变量缺失误落 0 的缺口），让 py 运行时也跟随 release/debug 分离。CDP（9222）与 vite（1420）本就仅 debug 使用、与正式版不冲突，未改动。同步更新 `docs/DEVELOPMENT.md` §2.1 并存表与 env 表、`docs/ARCHITECTURE.md` §6、`docs/spec.md`。

### 新增

- **直播源头写法取证脚本**：`tools/diag/diag_live_headers_all.mjs`（遍历活跃配置所有直播源，按源统计 `#EXTVLCOPT` 独立行 vs `#EXTINF` 行内属性 vs `http-header`，并定位 jstv/litchi/migu 等高危频道落在哪个源、怎么声明头——正是据此发现上面的 `http-header` 缺口）与 `tools/diag/diag_live_resolved_stream.mjs`（对 `resolve_play` 返回的资源直链经反代 Range 实拉并用真实 `<video>` 观察解码出画）。实测修正了「加密 HLS 播放器解不开」的旧假设：`江苏卫视` 403 来自缺 Referer（头解析层，已修），master 清单里的相对变体 URI 经 `playlist.rs::absolutize`（`Url::join`）已能正确解析、非缺口；当前 `cluntop` 那路 `jsws4k.php` 实际映射到一个可正常解码的 1080p MP4。

---

2.0.0 是一次**允许破坏性改造**的大版本：用户会重新初始化配置。主线是「优先主流开源库、去手搓」与「给最脆弱的播放内核建立可测的行为模型」。

### 破坏性变更（BREAKING）

- **配置 id 哈希 `sha1[..12]` → XXH3（`xxhash-rust`）**：配置快照 id、EPG 磁盘缓存文件名、spider-src 快照文件名统一改用 XXH3，**移除 `sha1` 直接依赖**。换算法会让所有已导入配置换 id、收藏与历史对不上——需重新初始化配置（已授权）。spider-src 原先手搓的 FNV-1a 一并换成 XXH3（非加密的稳定指纹场景，XXH3 比加密哈希更合适、更快）。
- **豆瓣取数改为「后端主动推」**：移除 1.x 里为「封面两段式」临时加的 `douban_cover` 命令，改为单一入口 `douban_request` + `douban-meta` 事件（四相 `cover`/`full`/`none`/`error`）。并发/限流从前端队列上收到后端优先级调度器（2 worker + 全局令牌桶 + `active` 去重）。前端 `useDoubanMeta` 走中心 store（`useSyncExternalStore`），`fetchDoubanMeta` 保留为同一 store 的 Promise 视图。
- **播放内核引入 XState 会话状态机（点播 / 直播各一台）**：`vodSessionMachine`（idle/resolving/attaching/buffering/playing/probing/switching/recovering/failed）与 `liveSessionMachine`（无剧集与续播语义），按 `siteKey` 选用，均带 node 行为测试。接管为真源的：会话身份 `switchGeneration → sessionId`、续播取消 `resumeCancelled → resumeAborted`、首帧 `hasPlayed`、切换中 UI（`matches("switching")`，带 15s 兜底）、看门狗判决（见工程一节）。墙钟窗口（音量 ramp、初始化与倍速静默）仍留在解释器。
- **看门狗「慢 ≠ 死」判决收进状态机，删掉重复的纯函数判决**：`lib/watchdogVerdict.ts` 与 `vodSessionMachine` 各自实现了一遍「unknown 累计到 3 次判死、dead 一次即判死、ok 复位」，解释器还另持一份 `unresponsiveProbes` 与 `STALL_UNRESPONSIVE_LIMIT` —— 同一套判决三份实现，改阈值要改三处。现在**机器转换表是唯一真源**：`UNRESPONSIVE_LIMIT` / `LIVE_UNRESPONSIVE_LIMIT` 由机器导出，解释器只负责取证据（计时闸门 + `probeLineVerdict`），把三态结论原样 `send({type:"PROBE", verdict})` 喂进去，再看 `recovering` 决定是否交棒换线（不再翻译 `ok`↔`alive`，词汇直接用 `playProbe.LineVerdict`）。顺带把两处模型与现实的偏差按现实改写：① **「出过画就再也不自动换线」这条产品红线原先只写在解释器的一个 `if` 里**，机器收到 dead 照样进 recovering——现在写进转换表（`STALL: {target:"probing", guard:"notPlayed"}`），删掉那个 `if` 也不会破，并补了断言；② `recovering` 的出边原先是无人发送的 `RECOVERED`（死支），真实的恢复路径是上层换源后重建实例（`LOAD`）或用户手动换集（`USER_SWITCH`）/直播换线（`LINE_SWITCH`），出边照此改写。同时把三个「从来没喂进机器」的事件接上：`FRAG_GROWTH`（反代 `/meter` 字节在涨 = 极慢但活着，复位 unknown 累计，此前是解释器直接 `unresponsiveProbes = 0`）、`FAILED`（`<video>` 解码错误与 hls fatal 的换线分支），probing 期间补 `FAILED` / `USER_SWITCH` / `LINE_SWITCH` 出边（复核在途时用户抢先动作，旧结论不再判死）。`watchdogVerdict.ts` 与其 6 条单测删除；用例总数持平（519），但新增的是真实状态覆盖：出画后 STALL 进不了 probing、`FRAG_GROWTH` 复位、recovering 的两条恢复路径、复核在途换集不被误杀、探活期解码报错。`tests/frontend/stallLiveness.test.ts` 的源码契约随之改写（钉「解释器不再持阈值/计数器副本」+「红线同时在转换表上」）。这是对上一轮「watchdog 三态由纯函数承载」边界的正面收口：边界精神是别让判决有两份实现，而当时恰恰有两份。
- **手搓页面缓存 `pageCache` → TanStack Query**：首页 / 分类 / 搜索 / 详情 / 直播解析的读结果缓存，从自研 `pageCache`（TTL + 上限 60 条 LRU + 手写 in-flight 去重 + 配置 scope 整体失效）迁到 `@tanstack/react-query` 的 `QueryClient`。保留 `api.*` **命令式门面**、没有改成 `useQuery`：`home`/`category`/`detail` 各自背着「空结果不缓存 / 按名自愈回查写回 / 命中也要 `rememberCards` / 空结果强制重试一次」这些历史 bug 修复逻辑，是 effect 与事件驱动的读取，命令式 `fetchQuery` 比声明式 hook 更忠实。适配层：`loadCached`（`fetchQuery` + `staleTime`/`force`，内置并发去重）、`peekFresh`（首帧直出，自带 TTL 闸门——`useEpisodeList` 靠它「命中种子即不回源」，把过期当命中会漏一次必要请求）、`putCached`（自愈回查写回）、`dropCached`（空结果不缓存 / 重试前清旧）、`resetCacheForScope`（换配置整体作废、同 id 幂等）。**行为差异**：容量上界从「60 条 LRU」换成「30 分钟 `gcTime`」的时间维度回收（条目都是小 JSON，足以覆盖「看几部再切回来仍秒开」）。删除 `pageCache.ts` 与其单测，新增 `queryClient.test.ts` 覆盖适配层手搓语义（force / 并发去重 / TTL 过期 / 错误不写缓存 / `peekFresh` TTL 闸门 / scope 幂等）。

### 新增

- **设置页「存储与清理」**：日志 / 反馈报告 / 封面与页面缓存三项各自显示真实占用（字节 + 文件数），可分别手动清理，带二次确认与「释放 X、剩余 Y」结果回执。这三类都只增不减——日志按 7 天轮转、反馈报告每导一份多一份、封面缓存换配置后留着不再引用的条目——此前只能自己去数据目录删。新增 `domain/storage.rs`（`storage_usage` / `storage_clear`），当天正被 writer 持有的日志删不掉时改为清空内容，剩余量按实测量回报，不虚报。
- **豆瓣封面两段式到货（推荐卡片）**：搜索级封面（1 跳）先出、详情级评分/简介后补，实测《庆余年》封面 1.36s vs 完整 2.70s，海报出现快约 2 倍；搜索经后端 `search_cache` 合并，总豆瓣请求量不增。头图不适用这条——见「变更」里的到货一次性。
- **`vodSessionMachine` / `liveSessionMachine` 两台机器 + node 行为测试**：播放内核第一次有可脱离 DOM、在 node 下单测的行为模型（换集 / 续播 / 自动播放受阻 / 探活判决与换线 / 失败重开；直播机器覆盖冷启动与直播换线）。「写策略时间窗」按设计不进机器，故不在此测试范围。

### 变更

- **首页头图的豆瓣资料改成「等齐一次到位」**：`cover`（仅封面）与 `full`（评分/类型/简介）分两段推给前端，卡片只吃图、无所谓；头图是封面与简介同屏的位置，逐字段就地应用就成了「先跳一次 meta 行、再跳一次评分简介、海报还顺带硬切一下」——同屏最多动三次。现在头图只认终态（新 `useDoubanFullMeta` / `getDoubanFullSnapshot`，中间态一律给 null，源站封面与文字全程不动），`full` 到货时封面、评分、简介同一批替换；海报替换也补进了双缓冲淡入的判据（`HeroFrame` 加 `origin`，来源从源站变豆瓣要走交叉淡入，同来源内改写 URL 仍原位更新，不做无意义的闪）。代价是豆瓣海报晚约 1.3s 出现，但这一屏不再有连跳。
  - 只认终态还不够：`proxy_status` 冷启动那一帧代理地址还没拼出来，海报会再晚一帧才换上，文字照样先跳。现在整组字段一起等地址就绪（`doubanReady`），没给海报或海报裂了则不必等。探针实测这条不是理论问题——修之前 `★` 比海报早一个状态到货。
  - 海报来源由组件声明为 `.home-hero__poster[data-origin]`（`source` / `douban`）：靠 URL 里有没有 `douban` 判「换过封面」不成立，推荐位的海报本身就挂在豆瓣域名上，那时探针从一开始就判成豆瓣态、断言全空过。
  - 探针 `tools/probes/probe_hero_douban_once.mjs`：冷 reload 起每 50ms 采样头图状态序列，断言「豆瓣海报与 ★ 出现在同一批」「到货后不再回退」「简介不第二次替换」「淡入窗口内两层同时有图」；采样期间把焦点落进头图借「聚焦暂停轮播」稳住这一屏。没有可比两段（豆瓣无匹配 / 已命中缓存 / 源站海报没画出）时报 SKIP 或打 info，而不是放宽断言蒙过。
- **豆瓣富化支持「按 subject id 直取」**：`douban_request` 新增可选 `subject_id`。有值时跳过搜索那一跳，直接用 id 走详情链出 `full` 相（实测 62% 的 CMS 条目带 `vod_douban_id`，抽检 6/6 指向同一部作品，比标题匹配强得多）。三条配套约束：
  - **弱校验**：id 反查到的标题要能过 `title_score`、年份相差 ≤1（源年份常是「2026韩国」这种脏值，取开头四位）；对不上就 WARN 并回退标题匹配路径。理由是有值即可信只验过 6 条样本，而「整库填同一个 id」这类脏数据形态检查发现不了。任一边缺年份不否决——宁可用 id，也不退回更弱的匹配。
  - **缓存分槽**：按 id 走的键是 `id:{subject_id}`，按标题走的键仍是归一 title+year。两条证据链不互相污染：标题路径写下的「无匹配」负缓存不能压掉 id 直取，反之填错的 id 也不能把该剧的标题路径一起废掉。
  - 详情页与播放页也已接入：`fetchDoubanMeta(title, year, { priority, subjectId })`，两处都从 `vod.vod_douban_id` 取值并进 effect 依赖。
  - **`cardIndex.slim()` 必须带上这个字段**：卡片索引是白名单形状，从卡片进详情/播放页是主路径，不在白名单里就等于在导航环节把 id 丢掉、按 id 直取永远轮不上。已补契约测试。
  - 端到端实测（`tools/probes/probe_douban_subject_id.mjs`）：取样不能靠点首页卡——首页推荐来自 `豆瓣[py]` 这类源，条目天然没有 `vod_douban_id`，第一版探针就是这么空转 4 张卡。现改为直接从 CMS 站抓列表、找一个真带 id 的条目再导航进详情，日志里出现 `走 subject_id 直取` 即成立；实测样本 360 站《碰撞搜查线 第二季》`id=36996291`、`matched=true`（豆瓣回查标题 `碰撞搜查线 第二季 (2026)`）。源侧没填 id 时按 SKIP 分流，不冒充通过。
- **CMS 归一化保留 `vod_douban_id`**：这个字段此前不在 `cms_parse.rs` 的 12 项白名单里，采集库给了也在归一化阶段被丢掉。实测 20 个 CMS 站 260 条样本：62% 带值、形态全部是 6~9 位数字，抽 6 个反查 `subject_abstract` 全指向同一部作品（其中「粤语/国语」两个源变体指向同一个 id，正是标题匹配会拆成两部的那类）。数字统一转字符串、`0` 归空串（表示没填），契约 schema 与 TS 同步加字段。豆瓣富化「按 id 直取」的下一步建立在这条之上。
- **豆瓣标题匹配放行「原文别名」尾缀**：豆瓣对非中文作品的标题格式是 `中文名 原文名 (年份)`，而 `title_score` 的尾缀上限是 4 个字符（保守是对的，挂错作品比漏匹配更糟），于是韩剧/美剧/日剧整批被判成「不是同一部」。实测《我的有罪之人》候选是 `我的有罪之人 나의 유죄인간‎ (2026)`，多出的谚文别名约 10 字符 → 拒 → 写负缓存 → 头图退回源站字段（`剧集评分 9.1 · 2026韩国`）。现在尾缀若**只含非中文、非数字**的字母（谚文/拉丁/假名）就按别名放行，仍走原来的 90/85 档；混进汉字或数字（`美版`、`2019`）不放行，长汉字尾缀的既有拒绝不变。
  - 顺带补观测缺口：判「无匹配」的日志原先只有 `candidates=1`，答不出「那 1 条是什么」；现在带上候选标题（最多 6 条）。这条日志才是上面结论的来源。
- **倍速改按剧记忆，不再是全局一份**：`luma:player:prefs` 里的 `rate` 删掉，倍速落到 history 那一行（`HistoryItem.rate`，0 = 从没设过 → 按 1.0 起播）。理由是这张表**按剧名合并同一部剧**，换源、换线路时行会跟着走，倍速因此天然跨源共享，不需要再发明一个「剧身份」；而「今晚看悬疑想 1.5 倍、看综艺想 1 倍」是常态，全局一份会互相冲掉。老偏好里的 `rate` 直接忽略，不迁移给任何一部剧（迁到谁身上都是猜）。
  - 取值走 `rememberedRate: () => number` 而不是数值参数：它随 history 查询异步落地，进了内核 effect 的依赖就会因为一次查询完成而重建正在播的实例（与 `resumeMsRef` 同理）。构造后设一次、`loadedmetadata` 再确认一次，写入器 1.2s 的重放本身也是兜底路径。
  - `playerPrefsWriter` 的字段隔离契约不变（倍速事件只写倍速、音量事件只写音量），只是倍速那一路的落点从 localStorage 换成「立即补写一次历史」。探针 `probe_playback_ux` 的 A 段照此改写，并新增「全局偏好里不该再有 rate」的断言，防止第二个真源长回来。
  - 同一张表同时备好 `skip_json`（这部剧的跳过片头/片尾配置；空串 = 这次写入没带、`[]` = 用户真清空过片段）。
- **设置页去掉「观看历史 / 清空历史」入口**：历史页头部本来就有同名的清空按钮，两处做同一件事、语义还不一样（设置里那句不给条数，历史页给）。清理入口归历史页一处，设置页腾出的位置给了「存储与清理」。
- **豆瓣代理通道可观测性**：成功时每代理模式 INFO 一次实际 host、连接层失败 WARN 带 host、非 2xx 把 `proxy`+`host` 挂进 `error.details`，回答「配的代理生效没、改写成哪个域名」。
- **首页 hero「电影感暗底」**：背景重模糊 + 近乎去色 + 均匀深遮罩，根治浅色海报糊出的脏棕「泥」背景；「下一张」改为右缘全高常驻热区 + 浅色玻璃圆衬。
- **播放器「下一集」切换态**：转环取代箭头 + `cursor:not-allowed` 锁定态（旧版描弧叠箭头「不协调」、且点击无「已禁用」反馈）。
- **豆瓣缓存键保留季标记**：`cache_key` 不再剥掉「第X季」，年份仍是首选区分、季标记兜底。

### 工程

- **判死交棒集中到状态机**：原先 5 个交棒点各写一遍「撤冻结帧 → 报错 → `switchOrFailoverRef`」（看门狗判死、`<video>` 解码错误、hls fatal、FLV fatal、直播 FLV EOF 停住），现由机器进入 `recovering` 时发起（点播 `navigateFailover` / 直播 `requestLineSwitch`），实现经 `machine.provide({ actions })` 注入，引擎只留一个 `handOverLine`。
  - `src/lib/sessionFailover.ts`：`FailoverCause`（`probeDead` / `probeUnresponsive` / `mediaDecode` / `hlsFatal` / `flvFatal` / `flvInterrupted` / `linesExhausted`）与对应用户文案、日志 stage。状态机只表达原因，文案集中一份。
  - `FAILED` 事件由自由文本 `reason` 改为 `cause` + `detail`；`PROBE` 直接复用 `playProbe.LineVerdict`。
  - 卸载时先摘掉副作用实现：机器 actor 按 `siteKey` 存活，比实例久。
  - 所有交棒原因统一置看门狗闸门（此前 hls / FLV / 解码错误三条不设，同一实例内可能与看门狗各交棒一次）。
- **续播时机修正**：`resumePlayback` 原挂在 `MEDIA_ALIVE`（首帧之后）上，实际要求新地址挂上后立即 `play()` + `canplay` 兜底。新增 `SWITCH_ATTACHED` 事件，由解释器在 `art.switchUrl`、倍速复位与淡入武装之后发出；`switching` / `playing` / `probing` 三态都接受，15s 兜底之后才挂上的慢源仍能续播。
  - XState v5 不识别动作对象上的 `guard`，条件动作改用转移数组 `[{ guard, actions }]`；否则「切换前是暂停态」也会被强制续播。
  - 删除无实现的动作描述符 `acquireDecoder` / `releaseDecoders` / `showSpinner` / `hideSpinner` / `pinControls` / `unpinControls` 与无发送点的 `FADE_DONE` / `fadeDone` / `canPersistVolume`：解码器生命周期归 ArtPlayer 的 `customType`，转环与钉控制栏由 `matches("switching")` 驱动。
- **`usePlayerEngine` 拆出五个模块（1760 → 1481 行）**，各带 node 行为测试：`playerVolumeFade.ts`（10，冷启动与换集共用一台淡入）、`playerPosterHold.ts`（6）、`playerPrefsWriter.ts`（9，静默期纠正 / 节流 / 字段隔离）、`playerStallWatchdog.ts`（12，只取证据）、`playerThroughputMeter.ts`（6，反代 `/meter`）。机器的动作出口相应缩减为 `navigateFailover` / `requestLineSwitch` / `resumePlayback` / `cancelResume`，另有 `restartQuietClock` 等取证记账退回看门狗。
  - 淡入抽取时修掉两处：`addEventListener` 第三参数被当 `once` 使用（实为 capture，监听永不摘除，冷启动淡入会在换集后复活）；在途 ramp 缺代次校验（原实现同样存在，冷启动淡入未走完就换集时两个帧闭包往不同目标写）。
- **`src/lib/watchdogVerdict.ts` 删除**：判决（unknown 累计、阈值、出画后不判死、判死后交棒）此前在解释器变量、该模块与状态机里各有一份，现在只在转换表里；`UNRESPONSIVE_LIMIT` 由机器导出。红线「出过画不再自动换线」同时写进 guard。
- **新增探针 `probe_session_machine`**：读 dev 观测点 `window.__lumaPlayerSession`，比对状态机与现实：出画后 `playing` + `hasPlayed`、健康播放 12 拍内不得出现 `probing` / `recovering` 或计数非 0、换集分原地（同 `instance`、`sessionId` 自增）与整页重建（`instance` 变化）两条路径分别断言、注入坏源验证判死链。观测点补 `instance` 字段（dev-only，不参与产品逻辑）。
- **`probe_live_audio` 场景 3 改为对齐常驻层契约**：原断言「离开直播页后 DOM 里不该有 `<video>`」与常驻层「只藏不卸载、音频照播」的设计冲突。改为断言不堆叠（至多 1 条流）、不双声、无幽灵音、隐藏态真的断掉命中测试（`is-idle` + `aria-hidden` + `visibility:hidden` + `pointer-events:none` + `elementsFromPoint` 命中栈不含常驻层节点）。
- **`probe_playback_ux` 的构建自检改为从磁盘源码推导**：原实现硬编码两条产品字符串，内核一搬模块就假报 stale。现在从磁盘 `usePlayerEngine.ts` 读出它引用的同目录模块清单，逐一验证被 service 的版本同样引用；行为指纹取磁盘上倍速字段隔离那行原文。
- **`infra/pct.rs` 的编码改用 `percent-encoding`**：库的 `NON_ALPHANUMERIC` 连 `- _ . ~` 一起编掉，用 `AsciiSet::remove` 放回，既有单测逐字钉住。解码保持自研（要的是坏转义 / 非法 UTF-8 整串退回）。
- **`docs/MAINTENANCE.md` §11**：第三方库替换清单的逐项结论与依据。
- 回归：`cargo test --lib` 233 passed / 2 ignored；`pnpm test` 577（70 个文件）；`tools/check.py` 9/9；窗口探针 `artplayer` / `playback_ux` / `episode_switch` / `player_nav` / `live_audio` / `session_machine` 通过。

- **选集快速切换改为串行合并**：原先切换进行中再点别的集会被重入守卫直接丢弃，用户点了没反应、只能再点一次；同时「正在播放」高亮在点击瞬间就跳到目标集，遇到同地址 no-op 或解析失败时高亮停在根本没在播的那一集。现在点击进 `lib/switchQueue`：忙时覆盖成新的 pending，上一次收口后立即执行，burst 内只跑首个与最后一个（中间集不解析、不闪画面）；高亮只在切换成功后移动，未落地的目标用独立的排队态表达。实测三连锁点（间隔 160ms）：`sessionId` 1→3 两次切换、中间集零解析、`active` 全程停在真实在播集、最终落在最后点击的一集。

- **状态机补两条丢了的边**（窗口实测暴露）：① `playing` 原先没有 `MEDIA_ALIVE` 转移，而进入 `playing` 有两条不带首帧的路径（`switching` 的 15s 兜底、`probing` 的 unknown），一旦走了它们，`hasPlayed` 就永久停在 `false` —— 「已出画不再自动换线」这条红线被无声解除；② `buffering` 没有 `USER_SWITCH` 出边，冷启动还没出画时点下一集，引擎切了、模型没切，spinner 与代次都对不上。各补一条转移与行为测试。

- **暂停态换集不再「看着像卡住」**：切换前是暂停就不自动播（不跟用户抢控制权），但画面会停在 0:00、什么都不说。现在收口时给一条常驻提示「已切到「X」，点播放继续」，播放中切换则不加。选集格的无障碍文案同时从「正在播放」改成「当前集」——暂停时它本来就不成立。

- **日志噪声按语义分级**：豆瓣 rexxar 双路径探测里「另一条必然 404」是探测机制，不是故障 —— 从 WARN 降为 `douban rexxar path not found`（debug），其它错误保持 WARN。debug 级实测：404 探测 2 条 DEBUG、0 条 WARN。`narrowLives` 原先把「分组容器（只有 channels、无 url）」和「结构漂移」混成同一条 WARN，而前者每次读站点缓存都会重复出现（实测 UI 日志里 45 次），把真问题埋掉了：现在容器记 `ipc narrow skipped live groups`（info，带 kept 数），真正的数据丢失仍记 WARN。
- **`probe_live_audio` 的频道轨道改带超时轮询**：原先固定 sleep 1.5s 后读轨道，冷缓存下读到 0 个台就假 SKIP（把「源不可用」和「还没加载完」混成一件事）。现在轮询到 ≥2 个台为止（30s 上限）。实测同一配置读到 2945 个台并通过。
- **解码器挂载搬出内核：`hooks/playerDecoders.ts`**（`usePlayerEngine` 1469 → 1256 行）。hls.js 与 mpegts.js 两条分支（共 259 行）从 `customType` 里整体迁出，接口按关注点分组（`media / identity / signals / ui / session / lifecycle / log`）而不是平铺 16 个回调。搬动过程中一并处理两处：① `instance.on("destroy", ...)` 原先经共享变量 `teardownDecoders` 间接调用，现在直接调本实例的 `destroy`（幂等标志保护），避免旧实例的 destroy 事件打到新解码器；② mpegts 的 `LOADING_COMPLETE` 生命信号加了 disposed 守卫，已销毁的播放器不再上报「还在动」。行为契约由三条源码测试改指新归属，窗口复跑 `artplayer` / `flv` / `session_machine` / `live_audio` 全绿。
- **从 `usePlayerEngine` 切出三块纯计算**（1480 → 1469 行，另加 8 条单测）：`lib/hlsBudget.ts`（hls.js 加载预算：清单/层级 20s、分片直播 20s / 点播 45s，以及为什么宁大不小）、`lib/mediaMeasure.ts` 的 `smoothBitrate`（实测码率 0.7/0.3 平滑 + 10% 抖动阈值）与 `hasMediaStopped`（直播 FLV EOF 后「画面到底停没停」的 0.2s 容差判据）。三块原先都埋在异步回调里，只能靠窗口探针间接验证；现在是可直接单测的纯函数，`hasMediaStopped` 的暂停/播放两条分支各钉了边界值。窗口复跑 `artplayer` / `flv` / `session_machine` / `live_audio` 全绿。
- **清掉前端死代码与多余导出**：`navResetTo`、`pageStateSize`、`clearProxyBaseUrl`、`doubanProxyLabel`、`clearLiveGroups`、`version.BUILD_HASH` 六处无任何调用点（诊断数据里的 buildHash 来自 Rust 的 `env!("BUILD_HASH")`，前端那份是重复注入）；`STALL_TICK_MS` / `STALL_PROBE_TIMEOUT_MS` / `normalizeEpisodeName` / `readLiveSource` 收为模块私有。

### 修复

- **豆瓣缓存跨季串数据**：无年份时「庆余年 第一季 / 第二季」曾归一到同一缓存键，第二季会命中第一季的条目（缓存早于 `pick_candidate` 打分）。缓存键保留季标记后消除。
- **hero「下一张」右缘命中失效**：WebView2 里绝对定位元素右边缘贴到视口边（`right:0`，`innerWidth` ±2px 内）既不上屏也不接收点击，导致图标「消失」；改 `right:4px` 后实测可命中、可点。

---

## [1.1.0] — 2026-11-15

1.1.0 的主线：**适配层只剩「执行第三方源脚本」一条职责**（py 源的结果映射不再随 sidecar 走）、**播放页体验重做**（原地换集/换源、失败可一键换线、后台播放指示）、**封面 HTTP 缓存**与**一键安装器**；版本号与 build 号同时收敛到单一来源。

### 变更

- **品牌统一为 Luma，剥离历史 TVBox 拼写**：产品标题 / meta / `Cargo.toml` 描述、README 与规格书开篇文案不再出现「TVBox 播放器」的品牌位（兼容 TVBox 配置格式这一事实性描述保留）；`contracts/tvbox.schema.json` → `contracts/luma.schema.json`、`src/types/tvbox.ts` → `src/types/luma.ts`，全库 import 与文档路径同步；`env.rs::get/set` 只识别 `LUMA_*` 前缀，`TVBOX_*` 别名从 Rust / Python 适配层 / 探针 / 验收脚本 / 文档中移除；qjs-runner 内部标识符 `__tvbox_*` 与模板占位符 `__TVBOX_*__` 统一改为 `__luma_*` / `__LUMA_*__`；反代响应头 `x-tvbox-proxy` → `x-luma-proxy`；py 模块名 `tvbox_py_spider` → `luma_py_spider`；`server_version` `TVBoxStub` → `LumaStub`；`prepare_runtime.py` 临时目录前缀 `tvbox-py-` → `luma-py-`；T-31 计划协议由 `tvbox://` 改为 `luma://`。**保留的 TVBox 拼写仅两处**：`domain/config/decrypt.rs::XOR_KEY = b"tvbox-stub-key"`（TVBox 社区固定的 `****` 外壳解密密钥，属外部协议字段）与描述上游 `cluntop/tvbox` / TVBox 生态 / TVBox `base.spider` 框架 / `vod_pic` 协议字段等事实性文本。
- **build 号前后端统一为「本次启动时刻」**：设置页原先分「前端构建 / 后端构建」两行，`tauri dev` 下 Vite 与 cargo 的构建时刻必然不同，两行永远对不上。现在后端在 `run()` 最开始 `started::mark()`（`infra/started.rs`），`Diagnostics` 增加 `startedAt`；前端 `src/lib/appInfo.ts` 取一次诊断快照后缓存，侧栏与设置页共用同一个 14 位 build 号，设置页两行合并为一行「构建号」。`buildHash` / `buildTime` 仍在诊断数据里供排障，界面不展示。
- **py 源归一化搬进 Rust，`sidecars/py/cms.py` 删除**：1.0.2 已把 CMS 采集解析搬进进程内（`domain/spider/cms_parse.rs`），但 py 源仍走 `pyspider.py::_normalize` → `cms.py` 再映射一次，同一套契约两份实现，改字段要改两处。现在 `cms_parse.rs` 新增 `normalize_spider_result()` / `detail_items()` / `empty_page()`，接管 `detailContent` 的 5 种包裹形状（`list` / `data` / `result` / `vod` / 裸 vod 对象）、`playerContent/liveContent/proxy` 的字典直通、其它方法的 page 形状；`pyspider.py` 只把 `pyrun.py` 的结果（已 `json_safe` 净化）原样交回。`cms.py` 移到 `tools/audit/cms.py`，只给离线审计脚本 `tools/audit/scan_sources.py` 用，运行时不 import。
- **适配层协议面收敛到 `ping` + `spider.py`**：`site.parseHome/parseCategory/parseDetail/parseSearch` 从 1.0.2 起宿主就不再调用；`config.decrypt` / `config.normalize` / `config.mergeRepos` / `site.route` / `live.parseM3u` / `live.parseEpg` / `parse.resolve` 的重实现早已在 Rust（`domain/config/{decrypt,normalize}.rs`、`domain/live/{m3u,epg}.rs`、`domain/parse.rs`），适配层里只剩一条从宿主不可达的死分支。现在全部删除，任何已删方法都会明确回 `{"code":"INTERNAL","message":"unknown method: …"}`，不会静默成功；`decrypt.py` / `normalize.py` 挪到 `tools/audit/` 供离线审计脚本复用，`live.py` / `parse.py` 直接删（Rust 侧已有移植与单测）；契约（`docs/spec.md` §5）同步改成「`ping` + `spider.py`」。

- **播放页不再用全屏过渡幕盖画面**：换集是在同一份剧集列表里换地址，原来要走「压暗 180ms → 导航 → 等解析 → 揭幕 320ms」，用户体感是黑屏好几秒；现在换集不盖幕、不延迟，缓冲交给 ArtPlayer 自己的 loading。删除 `PlayerSwitchVeil`、`lib/playSwitch.ts` 与 `.player-veil*` 样式。
- **换集 / 换源改为播放器内部换地址，不再重建播放组件**：整页 navigate 会重建 ArtPlayer，控制栏闪一下、全屏被退出（重建后没有用户手势，`requestFullscreen()` 会被浏览器拒绝，回不去）。现在引擎提供 `switchSource(url)`（只停解码器再 `art.switchUrl`），换集与跨站换源都在同一实例里完成；跨站换源用 `switchedSource` 覆盖站点/片名/剧集列表，历史与收藏跟着写新站，失败或跨协议才退回整页跳转。`PlayerPage` 换集时只更新 `manualPick`，`PlayerHeader` / `PlayerAbout` / 选集面板 / 下一集按钮同步读覆盖后的值。
- **播放相关提示移进播放器 notice 层**：换集/换源进度与「源侧慢、已等待 Ns」不再挂在页面顶部，改走 ArtPlayer 的 `notice.show` —— 贴着画面、全屏时也看得见；页面顶部只留需要用户决策的错误条。直播页同步：换台/换线提示进 notice，换源时清掉上一源的错误与换线记账，频道列表还在加载或已选台未落定时显示「正在读取频道… / 正在选择频道…」而不是「没有可播放的频道」。
- **播放加载态改用 ArtPlayer 原生样式**：删掉自绘的呼吸光环（`player-status__pulse` / `__ring` / `__dot`）和隐藏 `.art-loading` / `.art-state` 的覆盖规则——同一块画面里两套转圈叠在一起最难看。`PlayerStage` 只在「解析中 / 重新解析 / 没有可用地址」时出状态卡，换源提示与「源侧慢、已等待 Ns」共用顶部一行。
- **控制栏新增缓存速度读数**：反代新增 `domain/proxy/speed.rs`（原子计数 + 500ms 窗口指数平滑）与 `GET /meter`，播放内核每秒取一次，把 `↓ 2.4 MB/s` 写进 ArtPlayer 控制栏右侧（和线路 / 清晰度同一排）。缓冲进度已经由进度条画出，不再单独显示「已缓冲 Ns」；hls.js 自己量的是回环速度，没有参考价值，速率只认反代的真实下载量。
- **屏蔽 WebView 默认行为，给原生应用手感**：`src/lib/webviewGuards.ts` 全局拦右键菜单、拖文件进窗口、中键自动滚动、Ctrl+滚轮与 ± 缩放、F5 / F3 / F7 以及 Ctrl+F/P/S/U/O 等浏览器快捷键；F12 只在 release 拦，dev 留 DevTools 排障。**Ctrl+R 强制刷新保留**。正文与简介仍可选词，图片禁止拖出。同时全局 `user-select: none`，输入框 / 简介等白名单恢复可选。
- **Ctrl+K 命令面板重新设计**：一条带图标的输入栏 + 分组结果 + 底部键位提示；页面项带图标，站点项带首字徽标与 `PY` / `JS` 运行时分发标签，当前首页站点标「当前」。关闭方式、模糊匹配与 Ctrl+K 全局开关都不变。
- **播放页补齐「失败之后的出路」**：加载过久（≥5s）或直接失败时，舞台中间给出「换下一条线路」按钮，不用再去右侧线路列表里找；错误/等待态把 ArtPlayer 底栏钉住常显，手动切线路不会被自动隐藏挡住。已出画之后不再自动换线（`hasPlayed` 记死后看门狗只出提示不切），避免「正播着被切走」；从播放页切回直播页时直播重新接管声音并起播，直播与点播在 store 层互斥，侧栏只亮一个绿色呼吸点。
- **单码率时彻底不显示清晰度控件**：`artplayer-plugin-hls-control` 在 `hls.levels` 只有一档时仍会挂「自动」控件（插件在 `ready` / `restart` 里还会把删掉的控件重新挂回来）。现在按实例把 `quality` 的 `control` / `setting` 关掉再移除控件，直播与点播都生效；多码率源不受影响。
- **控制栏缓存速度读数 + 集数与实测码率角标**：左上角依次显示「第 N 集 · 分辨率 · 码率」，码率取反代实际分片吞吐（`Hls.Events.FRAG_LOADED` 的字节/时长指数平滑），不再只信清单声明。
- **站点收藏**：首页站点下拉旁、换源弹窗每一行、搜索结果排序共用一份收藏（`localStorage`，键 `luma:favorite-sites`），收藏星与影片收藏同一套视觉；不新建页面、不改后端配置。
- **封面走 HTTP 缓存**：反代 `/image` 的请求改走带 `http-cache-reqwest`（cacache 磁盘后端）的独立客户端，按 `Cache-Control` / `ETag` / `Vary` 自动存取，缓存目录 `<data>/cache/http-images`；同一张海报在首页、搜索、详情之间不再反复回源。缓存键、过期、条件请求都交给中间件，宿主不维护自己的索引。
- **1.1.0 安装器：一键装到当前用户**：`installMode: currentUser`（`%LOCALAPPDATA%\Luma`，不需要管理员、不弹目录选择），`languages: ["SimpChinese"]`，`compression: lzma`，WebView2 用 `downloadBootstrapper`（缺运行时时在线引导）。为了去掉「欢迎」「选择安装目录」两页，把官方 `installer.nsi`（`@tauri-cli` v2.12.4）vendor 到 `src-tauri/nsis/installer.nsi`，只删这两页，完成页仍是官方的「运行 Luma」+「创建桌面快捷方式」（都默认勾选），升级遵循官方 `RestorePreviousInstallLocation`。
- **首页换源 / 切站骨架屏**：沉浸式首页新增 `HomeSkeleton`（头图 + 横排占位，`sk-home*` 类名与探针契约隔离），分类态复用搜索卡片骨架；`AsyncBoundary` 在「空列表 + 加载中」即出骨架，不再只等首次加载。配套修掉两处让骨架永远排不上队的时序：`usePageState` 的换键重置从 effect 挪进**渲染期**（旧版在 key 切换后的一帧里仍返回旧站点的值，首页把旧数据当新数据、直接闪现空态）；首页推荐值改为携带归属站点键（`ScopedHome`）。`probe_home_video` / `probe_playback_ux` 的首页断言同步改成沉浸式口径（头图 / 横排 tile 任一即算出内容）。
- **播放器「下一集」点击后的持续反馈**：原地换集有一条完整的「切换中」链——按钮图标叠加转圈（描弧 `player-next-spin`，与 `.is-disabled` 撞相的压暗方案弃用）、控制栏在切换期间钉住不自动收起、`switchSource` 的 promise 等到新集**真正出画**（15s 封顶）才收口；期间重复点击（按钮与选集面板两个入口）被代次守卫吞掉，不再出现两路 `switchUrl` 竞态「点了没反应 / 画面切回旧集」。自动接下一集补回「已自动播放下一集」toast（原地切换改版时被弄丢）。控制栏钉住规则不再给全幅的 `.art-bottom` 放开 `pointer-events`（常驻层后台播放时它悬在其它页面之上，会吞光整页点击），只放开进度条 / 控制栏两行。
- **系统过渡动效统一**：新增 motion token（`--dur-fast/--dur-slow/--ease-out/--ease-in`）；页面与内容容器级入场（`page-in`，容器一条动画、2900+ 频道项零逐条动画）、常驻播放/直播层 opacity 淡入淡出、头图轮播双层交叉淡入（常驻 4 个 img、连点不涨节点）、Ctrl+K / 确认弹层 / 换源面板 / 下拉菜单入场、ErrorBar 两段式退场、按钮按压与收藏星 pop、toast 时长收口；清掉 3 处引用已删除 `vod-skeleton` 关键帧的「静止骨架」；`prefers-reduced-motion` 全局降级补强（含 JS 平滑滚动）。
- **豆瓣元数据不再拖慢首页轮播**：每 60s 的轮播刷新加「前台可见才刷」；搜索链去掉恒 404 的 suggest 前置、rexxar 路径按 subject_id 记忆（电影不再白跑 tv 路径）、无匹配 / 404 / 限流进负缓存——稳态下轮播期豆瓣请求为 0，单次获取 2.5~4s 降到亚秒。

### 修复

- **详情 / 播放页简介在信息超长时被压成窄条、卡片被无谓拉高**：简介宽度一直是 `--line-measure: 70ch`（约 491px），而 `ch` 量的是西文「0」的宽度 —— 中文字体下每行只剩三十多字，卡片宽 1164 时简介只占左半边，长剧情一路往下堆，右边大片空白；收起态用 `max-height: 84px` 硬裁（行高不是整 84 的约数时最后一行会被切一半），展开态又退回 `max-height: 220px + overflow-y: auto`，在卡片里叠出第二根滚动条。现在简介按信息列宽度排（`min(100%, 72em)`，em 量汉字宽度，超宽屏也不会长到读不下去），收起改成 `-webkit-line-clamp: 4` 自带省略号，展开后不设上限、让卡片自然长高；播放页信息卡底部留白从 2px 加到 10px，「主演」这类长名单允许在任意位置断行。顺带修掉播放页标题行右侧图标的悬浮气泡顶出列宽 5px 造成的横向滚动（气泡改为右对齐向左展开）。`base.css` 删掉已无人使用的 `--line-measure`，`tests/frontend/designScale.test.ts` 把「简介按列宽限读、按行裁切、展开不内嵌滚动」钉成契约。
- **简介的「展开 / 收起」从一枚孤立图标改成正文下方的行内按钮**：原来它是个没有文案的 chevron 图标，还排在「播放」按钮那一行 —— 展开后箭头孤零零挂在按钮左边，用户根本不知道它管的是简介。现在开关带文案（「展开全文」/「收起简介」）、紧贴正文左下角，箭头按 `aria-expanded` 翻转；`VodMetaHero` 不再把开关塞进 footer，`icon-btn--rotate` 这条只为它存在的样式一并删掉。

### 工程

- **架构评审后的收口（2026-11-16）**：对前后端做了一次结构化评审，逐条处理如下。
  - **反代 SSRF**：`check_target` 原先只校验初始 URL，而 reqwest 默认自动跟随 ≤10 次 30x——过审地址可用 `302 → http://127.0.0.1:9222/…` 打到任何只监听 loopback 的服务（dev 的 CDP），响应再以 `access-control-allow-origin: *` 流回网页。现在 `redirect_guard` 对每一跳重跑同一套校验（用 `attempt.error()` 而非 `stop()`，后者会把裸 302 透给 hls.js）；再加 `PinnedResolver`：`check_target` 审查通过的 IP 登记 60s，建连时复用同一份解析结果，关掉「校验时公网、建连时 127.0.0.1」的 DNS 重绑定窗口。回归测试用 Windows 非本机地址绑定伪造合法初跳。
  - **sidecar 生命周期**：`bridge::shutdown()` / `quickjs::shutdown()` 定义齐全但全仓零调用，正常退出只靠 Job Object 杀进程树——qjs-runner.exe 的映像句柄因此会锁住 `src-tauri/binaries` 拷贝，下一次 `cargo build` 直接 `PermissionDenied`（dev 实测）。现在接进 `RunEvent::Exit`（各 3s 超时、幂等、失败仅告警）；顺手删掉同样零调用方的 `ProcessRegistry` 死代码。
  - **bridge reader 任务监护**：stdout 路由任务的 JoinHandle 原先被丢弃，内部还有 `Mutex::unwrap`。任务 panic 后 `alive` 仍为 true、`fail_all` 不跑、也永不 respawn，表现为「py 源集体超时但 sidecar 看起来活着」。现在补监护：JoinHandle 报错即置死并排空 pending，两处锁改中毒容错。
  - **落盘脱敏统一**：「日志 URL 一律脱敏」此前只在 UI 通道兑现，宿主通道是裸 `fmt::layer()`，反代/取数失败会把带签名的完整 URL 写进 app 日志，而「一键诊断」打包的正是这些文件。脱敏点移到 `CappedWriter::write`（唯一闸，配套幂等的 `redact_urls`），新增两条回归覆盖整行与分片写入——第一条正是在开发中抓到「按输出长度返回消费字节数」导致 `write_all` 把原文尾巴继续灌进来的自伤。
  - **infra→domain 反向依赖**：`logging` 的诊断统计改吃中性 `ConfigDigest`，需要读 `ConfigStore` 的两个命令搬到 `domain/diagnostics.rs`（命令名不变，前端无感），infra 不再 import domain 类型。
  - **冷 key 并发去重**：新增 `infra/flights.rs`（single-flight：同 key 的在途重叠调用共享一次结果，完成后摘除条目，不当缓存）。py/js 的脚本下载与豆瓣的 `title/year` 查询接入——一次 fan-out 里并发首次触达同一 URL / 同一部片时不再重复跑整条链（豆瓣的令牌桶只限速、不去重）。
  - **历史缓存增量**：`upsert_history` 每次写完重读全表（O(500)）改为由 SQL 在同一事务里报告「这次删掉了哪些行」，缓存按同一份报告施加；跨上限 503 次写入后，与「重开一份 store（只能读库）」按键集合完全一致。
  - **编解码 / 环境变量**：三份逐字相同的百分号编码 + 一份解码收敛到 `infra/pct.rs`；`RESOURCE_DIR` 改 `OnceLock` 发布，不再在 `setup()`（tokio worker 已在跑）里 `env::set_var`。
  - **前端**：看门狗「慢 ≠ 死」三态判决抽成 `lib/watchdogVerdict.ts` 纯函数并补 6 条行为测试（此前只能靠源码字符串契约 + CDP 探针）；切换路径产生的全部 timer / listener 登记进 `switchDisposers`，新一轮切换与 effect cleanup 各收一次，不再单靠 `videoRef` 身份校验兜底；`storageKeys.ts` 集中登记 14 个 `luma:*` 键（键字符串一字未改）；IPC 对手不可信来源（`localStorage` 旧缓存）加 `narrowSites` / `narrowLives` 运行态守卫，Rust 返回值按同进程版本匹配保持不收窄；首页页内缓存补 `storedAt`，让 5 分钟 TTL 对「返回首页」这条路径真正生效；契约测试每处 `indexOf` 先断言锚点存在（否则 `-1` 时 `slice(-1)` 只剩一个字符，`not.toContain` 会静默通过）。
  - **样式归属**：`.source-picker__* / .source-item* / .source-skel*` 共 416 行从 `command-palette.css` 搬回 `player-panels.css`；级联等价性由脚本按 `index.css` 的加载顺序展开成扁平规则序列逐条对比证明（51 条相关规则顺序内容全同、全量规则多重集合一致）。评审提到的「`.episode` 三处重复定义」经核对只有一处基础规则，其余分别是补充声明与声明过的后置覆盖层，故未改动。
- **测试基线更新**：`cargo test --lib` 197 → 221 passed / 2 ignored；`vitest` 60 文件 480 → 63 文件 502；`tools/check.py` 9/9。
- **取数客户端开启 gzip / brotli 协商**：配置、CMS 采集、豆瓣都走 `infra/http.rs` 的共享 reqwest 客户端，现在会声明 `Accept-Encoding` 并自动解压，中文配置动辄几百 KB、重复拉取时省的是实打实的流量。反代客户端（`domain/proxy`）显式 `no_gzip()/no_brotli()/no_zstd()`：它是原样搬运，自动解压会让 `content-length` / `range` 与上游头对不上，播放器会把分片截断。
- **封面缓存钉了行为测试**：`src-tauri/src/domain/proxy/tests.rs` 起一个本地 axum 服务返回 `Cache-Control: public, max-age=604800`，同一 URL 经缓存客户端打两次后断言上游只被命中 1 次 —— 以后换缓存后端或改缓存配置，这条会先失败。
- **sidecar 与 spec 大清理**：`sidecars/py` 从 8 个模块减到 5 个（`main.py` / `pyspider.py` / `pyrun.py` / `adapterlog.py` / `base/spider.py`）；`main.py` 的「导入车道 + 爬虫车道」（8 + 2 两个线程池）并成单车道 8，`lane_for()` 与 `DecryptError → CONFIG_DECRYPT_FAIL` 的错误码映射一并删除。测试侧：`tests/offline/{config_shapes_check,parse_check,parse_epg_check}.py` 删除（对应断言由 Rust 单测 `normalize.rs` / `m3u.rs` / `epg.rs` 覆盖），`config_compat.py` 只留脚本执行侧兼容，`adapter_isolation.py` 重写成协议健壮性（单车道 / 坏帧回帧 / gbk 源编码 / 慢调用日志），`p1.py` 的 7 方法表改成「只验证 `spider.py` + 断言 8 个已删方法回 `unknown method`」。文档：规格从 `docs/spec-v1.1/`（replacements + 修订 CHANGELOG）收敛成单一 `docs/spec.md`，只写现状、不按版本号切分，`AGENTS.md` / `DEVELOPMENT.md` / `ARCHITECTURE.md` / `TESTING.md` / `MAINTENANCE.md` / `CONTRIBUTING.md` / `RELEASING.md` / `project-layout.md` 同步。回归基线：`check.py` 9/9、`py_compat_check` 19/19、`adapter_isolation` 13/13、`pnpm test` 438（53 文件）、`cargo test --lib` 188 passed / 2 ignored。
- **版本号单一来源落到工具链**：`src-tauri/tauri.conf.json` 的 `version` 改为 `"../package.json"`（Tauri 官方支持的路径引用，安装器元数据不再抄数字）；`src-tauri/build.rs` 在编译期断言 `Cargo.toml` 版本与 `package.json` 一致，漂移直接编译失败；`sidecars/py/main.py` 的 `VERSION` 改读宿主注入的 `LUMA_VERSION`（`infra/bridge.rs`），离线直跑回退 `package.json`；新增 `tools/version_check.py` 并接进 `tools/check.py`（8 → 9 项）。
- 探针 `tools/probes/probe_build_stamp.mjs` 改为断言侧栏与设置页 build 号相同、且为 14 位时间戳；`docs/RELEASING.md` §1 重写并新增 §1.1（build 号口径）。
- 空详情诊断从 Python `empty_detail`（`spider` 通道 JSONL）改为宿主 `tracing::info!`（`app` 通道，`spider detailContent returned no video`，带 `source_api` / `vod_id`）—— 归一化在 Rust 了，诊断跟着走；`spider.log` 继续只放脚本异常与 traceback，不引入第二个写入者。
- 代码位置：`src-tauri/src/domain/spider/cms_parse.rs` 新增 `pub(crate) fn normalize_spider_result(method: &str, result: &Value) -> Value`、`fn detail_items(...)`、`pub(crate) fn empty_page()`，`page_from_json` 由私有改 `pub(crate)`；`python.rs::invoke` 在 bridge 返回后调 `normalize()`；`cms.rs` 的 `sidecar_method` 日志标签从 `site.parse*` 改名 `cms.parse*`（它们从来只用在 `tracing::debug!` 里，不是发给 Python 的）。
- 测试：`cms_parse.rs` 单测 5 → 9（py 源 detail / page / play 各类形状）；`tests/offline/py_compat_check.py` 删掉 `cms` / `pyspider` 引用、第 5 项改成「适配层原样交回」、日志断言只留 crash 与 unsafe；`src/lib/detailRecovery.test.ts` 的空详情/形状断言改读 Rust 源码；`tests/acceptance/p1.py` 方法表 11 → 7。回归：`cargo test --lib` 166 passed / 1 ignored、`pnpm test` 51 文件 / 404、`py_compat_check` 23 / `py_base_spider_check` 29 / `adapter_isolation` 14、`p1.py --adapter` 14 pass / 0 fail / 3 skip（qjs 未编）。
- 文档：`docs/spec.md`（目录树、协议面、车道、解析位置）、`docs/DEVELOPMENT.md` §3.3、`docs/ARCHITECTURE.md` 运行时表、`AGENTS.md` 回归基线同步。

---

## [1.0.4] — 2026-11-15

补丁版。修掉「进度条走形」，并把自动换线改成真正「先同源同集线路 → 同源其它集 → 跨源」。

### 新增

- **侧栏「播放」始终在，落地页是续播页**：以前没有播放会话时这个入口被整条隐藏（`NAV_ITEMS.filter(item => item.key !== "player")`），想接着看上次的片子只能先去「历史」再点。现在入口常驻：有会话时仍指向当前播放页，没有会话时落到新的 `/player` 续播页 —— 主卡展示最近一条历史（封面、线路、集名、已看进度、多久之前），一键「继续播放」把末次 `playUrl` / 线路 / 集名原样带进播放页（进度由播放页按剧名 + 同集从历史里取 `positionMs` 续上）；下面「最近观看」网格列出其余记录。一条历史都没有时空态给「去逛逛 / 搜索影片」两个去处，不再把人送回首页。新增 `tests/frontend/playPage.test.ts`（4 条）锁住入口常驻、路由顺序、最新历史与空态。
- **详情页 / 播放页用豆瓣信息，源只负责播放链路与兜底**：TVBox 源只承诺播放，首页卡片字段天然只有标题/封面/备注/线路，简介、评分、演职员要靠源自己的 `detailContent` —— 而像 `豆瓣[py]` 这种纯发现源连详情都恒空。现在详情页打开时按片名（+ 年份）补一次豆瓣元数据：新增第 37 条 command `douban_meta`（`src-tauri/src/domain/douban.rs`，候选来源依次为 `j/subject_suggest` → `movie.douban.com/subject_search?search_text=` 页面里的明文 `window.__DATA__` → `m.douban.com` 移动搜索（后者极容易 `need_login`，只作兜底），再按 id 走 rexxar `tv`/`movie` 取详情、`subject_abstract` 兜底，标题规范化 + 年份优先的匹配打分，进程内 10 分钟 / 128 条缓存，失败一律 `Ok(null)` 静默），前端 `src/lib/douban.ts` 再做一层 200 条缓存（命中 10 分钟、未命中 1 分钟）与并发合并（同时最多 2 个在途，其余排队）。豆瓣搜索有频率限制，几十张卡同时进视口会一次性把请求打过去，被判定「搜索访问太频繁」后返回空结果、整页都像「豆瓣没数据」——现在 Rust 侧所有豆瓣搜索串行发送且至少间隔 1.2s，读到 `error_info` 里的限流提示就整体冷却 180s，冷却期内直接回退源站数据、不再继续撞墙。**豆瓣命中后，详情页 hero 与播放页信息卡的评分 / 年份 / 类型 / 导演 / 主演 / 简介全部换成豆瓣的**（`vod_remarks`「更新到第几集」属播放状态，仍用源站），源站只保留播放线路与剧集；豆瓣缺席时逐项回退源站字段。海报反过来：**豆瓣命中就用豆瓣海报**（2:3 标准裁切、版式统一），豆瓣没命中 / 图裂 / 还没加载完时用源站封面兜底 —— 这条策略落在 hero、详情页 / 播放页信息头、以及「为你推荐」卡片（卡片本来就在懒加载豆瓣资料，命中即换封面，不额外发请求）；历史 / 收藏卡片仍是缺封面才懒加载豆瓣。**详情页 hero 与播放页信息卡共用 `src/components/VodMetaHero.tsx`**（`variant="detail"` / `"player"`），豆瓣取值、源站兜底、海报兜底、简介溢出测量与展开收起只有一份实现。**`豆瓣[py]` 这类榜单/发现型源点进详情也有内容了**：以前源站没有详情时只有一张空态卡；现在只要豆瓣命中，就用同一套 hero 渲染「豆瓣页」（海报 / 评分 / 年份 / 类型 / 导演 / 主演 / 简介），页头标注「豆瓣信息 · 当前源只提供榜单」，下方给「全站搜索此片 / 换源 / 重试」出口，豆瓣也没有才回到原空态卡；源站把评分写进 `vod_remarks`（「电影评分 8.6」）时与豆瓣评分重复，已在豆瓣命中时过滤。搜索 / 首页列表不预取豆瓣（保持源站数据、避免频繁请求），**历史 / 收藏页的缺封面条目才懒加载豆瓣海报**（卡片进入视口才发一次请求，源站有封面就不问）。设置页新增「豆瓣信息」分区（开关、请求方式 直连 / custom / cors-proxy-zwei / cmliussss-cdn-tencent / cmliussss-cdn-ali、custom 前缀输入），默认直连、可整体关掉，关掉或抓不到时详情页保持原样，不报错不占位。CDP 实测《庆余年》：hero 评分 `★7.9 · 117.7 万人评价`、年份 2019、类型「剧情 · 古装」、导演孙皓、主演 61 位、简介来自豆瓣；关掉开关后回到源站字段。新增 `tests/frontend/douban.test.ts`（27 条）与 Rust 离线单测 16 条（1 条联网 `#[ignore]`）。
- **首页推荐改成沉浸式 hero 墙 + 横向推荐条**：推荐 tab 以前和分类共用 `.vod-grid` + 卡片（封面 + 角标 + 两行文字），一屏只站得下 5–6 部，也谈不上「沉浸」。现在推荐区是两层：最上面是 hero 头图 —— 整幅背景（同一张封面放大 + `blur(36px) saturate(1.35) brightness(0.6)`）+ 左侧 210px 海报 + 大字标题 + 一行元信息 + **两行剧情简介** + 单个「立即观看」按钮（不再有第二个「查看详情」：立即观看就是去详情 / 播放页），取推荐前 5 条每 6.5 秒自动切，悬停、键盘聚焦或系统「减少动效」时暂停；右下角圆点既是页码也是自动切换的进度条（跑满一圈换下一张，hover 时暂停）。切换只保留一个「下一张」：头图右缘一枚带投影的箭头，平时隐形，鼠标移进头图或键盘聚焦时才滑出来 —— 没有圆角矩形、没有实底、没有边框，只剩箭头本身，不抢画面；不做左右两个箭头。光标停在头图区域时，只有横向滑动（触控板双指横滑 / Shift+滚轮）翻页（460ms 节流 + `preventDefault`）；纵向滚轮完整留给页面，头图不再抢走整页滚动。头图的 DOM 是刻意稳定的：背景只有一个 `<img>`、海报只有一个 `<span class="home-hero__poster">`，换片只改 `src`，只有文字层按 `vod_id` 重挂 —— 这样切多少张都只有一张海报、一个背景，不会堆出并排的海报墙。手动翻页三路都通：点「下一张」、触控板双指横滑或 Shift+滚轮、按住横向拖动 ≥48px；不碰时每 6.5 秒自动切一张（手动切换后重新计时），指针移进头图、键盘聚焦或系统「减少动效」时暂停。文字层 320ms 上浮淡入，遵守「减少动效」。**元信息优先用豆瓣**：命中时显示 `★ 8.7 · 4.7 万人评价 · 2026 · 真人秀`，豆瓣缺席才回落源站的集数 / 年份 / 地区；标题上方的站点小字（`豆瓣[py]` 之类）整行删掉，头图只留内容本身。下面是「为你推荐」横向海报条，其余条目 156px 宽封面排成一行，海报进入视口后才懒加载豆瓣资料，命中评分时右上角出现 `★ 8.6` 角标（悬停信息条同样优先豆瓣的年份 / 类型），溢出时才出现左右箭头，点一次滚 0.82 屏（滚轮不劫持，触控板/Shift+滚轮照常）；横排两侧有渐隐提示「这边还有」，滚到那一头就收起，箭头到头自动置灰，横排本身可聚焦、用 ←/→ 直接翻页；hero 换片只让文字层做 320ms 上浮淡入，封面留在原地不重挂（避免换片时图片闪一下）。分类 tab 保持原来的 `.vod-grid` + 卡片网格不动。新增 `src/components/HomeHero.tsx` / `PosterRail.tsx` / `PosterTile.tsx` / `src/hooks/useDoubanMeta.ts`、`cards.css` 的 `.home-hero*` / `.poster-rail*` / `.poster-tile*`、`base.css` 的 `--cover-w-rail: 156px` / `--home-hero-h: clamp(320px, 46vh, 460px)`、`layout.css` 的 `.page--home`（取消页面限宽）。CDP 实测 1440 视口：头图 5 个圆点、海报 210×315（2:3）、背景 `filter: blur(36px) saturate(1.35) brightness(0.6)`、整幅贴满内容区（宽 1236 = `.page` 宽、左偏移 0）、meta 行 `★ 8.7 · 4.7 万人评价 · 2026 · 真人秀`、简介两行 48px 高（`introClamped: true`）、按钮只有「立即观看」、无 `.home-hero__eyebrow`；「为你推荐」15 张、其中 3 张带豆瓣评分角标、内容宽 2452 > 视口 1212、点右箭头 `scrollLeft` 0 → 984；悬停一张后自身 `matrix(1.045…)` + `brightness(1.16)`、信息条 `opacity 0 → 1`、相邻海报压到 `0.66`；切「热门电影」分类后 `home-hero` / `poster-rail` 归零、`.vod-grid` 20 张卡；切换控件实测：箭头贴头图右缘、垂直居中、48×96 命中区、`background-image: none`、`border-radius: 0`、默认 `opacity: 0`、hover 后 `0.92`；点一下从《后会友期》切到《我的有罪之人》，反向横滑回到上一张，双指横滑与 Shift+滚轮各切一张，`window.scrollY` 始终为 0；纵向滚轮不换片、页面照常滚 95px。离开层的图正是刚才那张（不是按序号反推的），淡出结束后 DOM 里只剩 1 层。新增 `tests/frontend/homeImmersive.test.ts`（6 条）。

- **节目单走本地磁盘缓存 + GitHub 加速**：`e.xml` 这类 XMLTV 有 7.6 MB，以前只有进程内内存缓存（3 小时）—— 每次启动、每次超过 3 小时都要从 `raw.githubusercontent.com` 重下，直连经常十几秒甚至超时。现在 `live_epg` / `live_epg_warm` 共用一条取数链：内存（3h）→ 磁盘（6h）→ 网络；磁盘在 `<data>/cache/epg/<sha1(url)>.xml`，先写临时文件再改名，写坏/半截文件不拿去解析；网络请求按设置里的「GitHub 加速」前缀改写（与配置导入同一份 `github_proxy`），切代理立即生效。Rust 单测 2 条（路径稳定不撞名、落在 `data/cache/epg` 下）。

### 修复

- **豆瓣「太慢」：机械串行改成全局令牌桶 + 请求优先级**：原来每次请求都 sleep 到上一个请求之后 1.2s，一次详情页要发搜索 / 详情 / 摘要三四个请求，光排队就 3.6s 起步。现在 Rust 侧换成全局令牌桶（容量 4、每 350ms 补 1，平均约 2.9 次/秒）：一次页面加载的几个请求可以立刻发出，只有持续刷首页那种高频场景才等补充，被限流仍整体冷却 180s；前端队列增加 `priority`，播放页 / 详情页 / 首页头图插队到一屏推荐卡的预取之前（`MAX_PARALLEL` 仍为 2 不变）。详情页也不再等源站详情回来才发豆瓣请求：片名一到位就并行拉，源站字段先上屏、豆瓣到了再升级 —— 源站慢（布布追剧实测 9s）时不会先空白再一次性换脸。新增 Rust 令牌桶单测 1 条。
- **首页推荐卡的豆瓣资料改为指向才取**：以前卡片滚进视口（含提前一屏）就各自发 `douban_meta`，一屏十几张等于一进首页就并发十几路，这是启动即触发限流的主因。现在只有鼠标悬停 / 键盘聚焦 / 手指按下才发请求，取到之后保持不丢；推荐卡默认显示源站封面与集数信息，豆瓣评分与海报在指向后补齐，首屏不再有任何豆瓣请求。
- **「源站拒绝解析」被统一说成「网盘 token」**：`zijianm3u8` 实测是源站自己回「线路暂时停用 / 当前账户无可用套餐」（decode 接口明确拒绝，TVBox 同样播不了），而界面文案与重试都当成「需要源侧插件解析（网盘 token）」，既没说清原因也没给出路。现在 `EpisodeTarget` 增加 `rejected`，resolve 失败区分「源站拒绝」与「超时」：拒绝时提示「源站没有解析这条线路（可能暂时停用或需要源侧账号），可换一条线路，或稍后点刷新重试」，超时仍用原文案。`src/lib/episodeResolve.test.ts` 补 1 条。
- **toast 的进度线偶发走形（一条压在 toast 上方的灰条）**：`sonner` 2.0.8 会在运行时往 `<head>` 追加一段 `<style>`，里面有 `[data-sonner-toast][data-expanded=true]::after`（悬停时连接两条 toast 的透明桥：`height: calc(var(--gap) + 1px); bottom: 100%; width: 100%`）。它和我们自绘的进度线伪元素 `[data-sonner-toast].notice-toast::after` 特异性同为 (0, 2, 1)，谁生效只取决于样式表先后：dev 下 Vite 把我们的样式也插成 `<style>` 且在后，所以看不出来；正式包里我们的样式是打包好的 `<link>`（靠前），sonner 的 `<style>` 启动后追加（靠后）→ 进度线的 `height` / `bottom` / `left` 被顶成 sonner 的几何，而背景色与 `scaleX` 动画仍是我们的，看起来就是 toast 上方一条 11px 灰条（正好是 `gap: 10` + 1）。选择器改成 `[data-sonner-toast].notice-toast.notice-toast::after`（**类名写两遍是故意的**，把特异性抬到 (0, 3, 1)），从此与样式表先后无关。新增 `tests/frontend/noticeToast.test.ts` 锁住「更高特异性 + 进度线贴在 toast 底部 2px」。
- **点播自动换线的顺序不严格**：`tryNextLine` 把「同集其它线路」和「同源其它集」混在一个候选列表里交给 `firstPlayable` 竞速，谁先探活成功就用谁，播放器报错时可能直接跳到下一集；另外重复触发靠一个布尔闸门早退，第二次调用直接返回 false 就掉进跨源分支。现在分两阶段：先探同源同集的其它线路（最多 12 条、并发 4），没有再探同源的其它集（最多 8 条），最后才换源；同一次换线用 in-flight Promise 去重并复用结论；集名比较改用 `sameEpisodeName`（全角转半角、去前导 0、忽略分隔符，`第04集` / `第4集` / `EP1` 视为同一集）。阶段提示依次是「正在尝试同源的其它线路…」→「当前源没有同集可播线路，正在尝试其它集…」→「当前源没有可播线路，正在尝试其它源…」，HLS 失败提示从「正在换源」改成「正在切换线路」。新增 `tests/frontend/failoverOrder.test.ts` 锁住三个阶段与顺序。
- **直播频道级 UA / Referer 被丢掉**：M3U 的 `#EXTINF` 里可以带 `http-user-agent` / `http-referer`（suxuang 这类源有 42 条声明），Rust 侧以前只读 `tvg-*` 与 `group-title`，广播出去没有这两个字段；咪咕系的央视/卫视不带 UA 一律 404。现在解析进 `LiveChannel.ua` / `referer`（同名频道以先声明的为准；没声明时不出现空字段），`resolvePlay` 按「频道级 → 直播源级」兜底。
- **起播与换台时的一声爆音 / 串音**：`<video>` 在 `playing` 之前音量就已经被 ArtPlayer 恢复成它自己缓存的 100%，MSE 源起播首帧还有一次采样跳变；直播换台时旧实例是「拖着一小段缓冲直接 `pause()` + `removeAttribute("src")` + `load()`」，音频设备上会留一声「咔」。现在新实例一律静音（`muted = true`、`volume = 0`）等 `playing` 后 200ms 淡入到记忆音量，硬停前先把 `muted` 置真再停；淡入期间不落盘音量偏好（否则「0」会被写成用户设置），连点换台没走完淡入时卸载也不补写。CDP 页面内记录器实测：点播起播 `volumechange` 逐帧 0.006 → 0.5（约 230ms、12 帧），`playing` 之前没有未静音的大音量；直播换台旧实例 `emptied` 时 `muted: true`；音量偏好保持 0.5。新增 `tests/frontend/playerAudioFade.test.ts`（4 条）锁住静音起播、淡入曲线、硬停顺序与不落盘。
- **直播「打开默认静音」/ 音量图标点了不恢复**：起播淡入的 `fadeInVolume()` 先 `video.muted = false`、再登记 `volumeFadeUntil`，解静音触发的那次 `volumechange` 落在静默窗口建立之前，把当时的 `volume = 0` 写进 `luma:player:prefs`；cleanup 里「淡入没走完」的判断也只比时间戳，连淡入都没开始也把 0 写回。偏好被改成 0 后每个播放实例都按 0 起播 —— 表现为直播一打开就没声音；而播放器的音量控件是 ArtPlayer 的**两个图标**（喇叭 → `art.muted = true`，静音喇叭 → `art.muted = false`），恢复时 `volume` 仍是 0，所以「点图标恢复」看起来没反应。现在 `fadeInVolume()` 先立 `volumeFadeUntil` 再解静音，加 `fadeDone` 闸门；`persistVolume` 在 `!fadeDone || Date.now() < volumeFadeUntil` 时一律不落盘；卸载时只在淡入确实完成后才补写；`PlayerPrefs` 增加 `muted` 字段区分「拖到 0」与「按了静音」，读到没有 `muted` 且音量 ≤0.01 的旧数据按损坏修复回默认 0.8，从静音恢复但音量还是 0 时用 `lastAudible` 补回；图标/键盘/滑块的静音语义保持 ArtPlayer 原生不动。CDP 实测：`#/live` 打开 CCTV1 持续 `muted:false volume:0.8`、偏好 `{"volume":0.8,"rate":1,"muted":false}`；点喇叭后 `muted:true` 且偏好正确写入 `muted:true`。`src/lib/playerPrefs.test.ts` 9 条（含旧数据修复）。
- **直播地址被判成网页、白等 15 秒嗅探**：`http://…/live.php?id=CCTV1` 这种路径里没有 `.m3u8`，`classify` 判成 `page`，直接进第 4 级隐藏 WebView2 嗅探；服务器对默认 UA 返回 404 HTML，于是等满 15 秒后报「该地址无法在内置播放器中播放」。现在 `resolve_play` 在嗅探前先用「配置级 headers + 默认值」发一次 4 秒 GET，只读前 8 KiB，首行是 `#EXTM3U` 就按 HLS 处理，并采用**重定向后的最终地址**（分片多为相对路径）。同一地址实测：带 `aliplayer` UA 时 194 ms 拿到 `#EXTM3U`（302 到咪咕 CDN），不带 UA 仍是 15.4 秒 + 404。
- **封面一直闪（占位 → 骨架 → 图 反复切换）**：取图链路有三处会闪。①代理端口只存在异步 `proxy_status` 里，每张新卡首帧只能先渲染占位符，等 Promise 回来再换成 `<img>`；②已解码过的图重挂载时会重新进 `loading`，骨架再闪一次；③骨架是扫光动画，聚合搜索一屏十几张同时扫光，观感就是「一直在闪」。现在把代理端口缓存进 `cachedProxyBase`（渲染期同步拼地址，新建卡片首帧就带 `<img>`）、`LOADED_SRC` 记下已解码的地址（重挂载直接跳过骨架）、`RESOLVED_SRC` 上限 400 → 1200（一次聚合搜索能出 300+ 张卡，超上限会把已解析项挤掉、回头再看时重新闪），骨架改成静态底色、删掉扫光动画。CDP 实测（搜索 12 秒）：卡片新增 270 张、因重挂载产生的 `cardRemoved` 为 0、占位符闪现（`phAdded`）只在代理端口就绪前出现 8 次，骨架计算样式 `animation-name: none`。新增 `tests/frontend/imageCache.test.ts`（4 条）锁住同步端口、已解码跳过、缓存上限与静态骨架。
- **采集源封面大量 502（TLS 握手失败没有第二次机会）**：`/image` 反代以前只发一次请求、默认头是 `okhttp/3.15`，TLS 阶段被上游断开时 reqwest 的 `Display` 只吐出 `error sending request`，既分不清是 DNS / TLS / 超时，也没有换头重试 —— 表现就是「有的源封面全白」。现在取图独立成一条链路：Chrome UA + `Accept: image/avif,image/webp,…`、8 秒超时（m3u8 的 20 秒不适合封面墙）；按 source 链把失败归成 `timeout / dns / tls / connect / status / not-image / other`；DNS、超时、TLS 不换 UA，其余可重试的换成浏览器头再试一次；https + TLS 失败允许同路径 `http` 回退一次；`image/*` 直接流式转发，`binary/octet-stream` 或其它类型读回按魔数嗅探补类型；失败日志带 `first_kind` / `kind` / status / type / 字节数。实测 `tyyswimg2.com` 的封面从 502 变 200 `image/jpeg`、`xjimg` 200；Clash fake-IP 段三家仍是 `first_kind="tls"`（本机网络问题，不是代理逻辑），`text/html` 响应归 `not-image`。新增 `src-tauri/src/domain/proxy/tests.rs` 6 条离线单测（UA 覆盖与 Referer 保留、http 回退、失败分类、错误链摊平）。
- **部分源封面地址形态不规范导致永远不显示**：`vod_pic` 在真实配置里有三种畸形态 —— 协议相对地址 `//static.example.com/x.jpg`（生产页 origin 是 `tauri://localhost`，浏览器会解析成 `tauri://static.example.com/x.jpg`）、HTML 实体（`x.jpg?w=1&amp;h=2`）、被引号或尖括号包住（`" https://x/p.jpg "`）。现在统一过 `src/lib/imageUrl.ts` 的 `normalizePic()`：trim、剥包裹的引号/尖括号、还原 `&amp;` / `&quot;` / `&#38;` / `&#x26;`、`//cdn/...` 补成 `https://`；`needsProxy` / `buildImageUrl` / `useProxiedImage` 都先归一化再判断，内联的 `@Referer=` 头原样留给 Rust 解析。`src/lib/imageUrl.test.ts` 补 6 条断言。
  - 排查「荐片[js] 封面全白」时确认这类源本身是我们的通用链路处理不了的**网络问题**，不是取图逻辑：脚本 `init()` 从 `api.ztcgi.com` 取到图床域名后拼出绝对地址 `https://static.ztcuc.com/upload/...`，应用日志里 `/image` 代理已经在请求该 URL 并因 TLS 失败；本机 `Resolve-DnsName` 返回 fake IP `198.18.1.15`，`curl` 直连与经 `127.0.0.1:7897` 代理都报 `schannel: failed to receive handshake`，WebView 内 `new Image()` 也 `error`，而普通 https 图（百度）能加载 —— FongMi / TVBox / ZyFun 都是直接把 `vod_pic` 交给系统加载，同样环境下同样白屏。
- **直播失败提示把内部报错当正文**：以前内核/解析钩子把什么字符串塞进 `setVideoError` 就直接铺红条，用户会看到 `HLS 播放失败：manifestParsingError` 这类内部名；「单线路等 4 秒没出画」和「所有线路都试过」也共用一句「该频道暂时无法播放」。现在新增 `src/lib/playErrors.ts` 的 `classifyLiveFailure()` / `liveFailureMessage()`：按**失败阶段**（`resolve` / `sniff` / `play` / `single-line` / `exhausted`）→ 错误码（`SITE_TIMEOUT` / `RUNTIME_UNAVAILABLE`）→ message 特征（所有线路 / 嗅探 / 网盘 token / 解码 / 超时 / 网络）归类成 7 种原因，每种给「一句人话 + 下一步动作」，原始报错降级进 `ErrorBar` 的「技术详情」；`fatalError` 改成 `LiveFailureInfo`，单线路判死不再说「换线路」而是「换频道」。`src/pages/LivePage.tsx` 保留 `.tip` / `.error-bar` / 8 秒自动收起 / 自动换线逻辑。新增 `tests/frontend/liveErrors.test.ts`（15 条）。
- **直播「声音已经出来、界面还挂着不可用」**：单线路判死原先只看 `readyState >= 2`（是否已有画面），但 WebView2 + mpegts 直播常见「音轨先出、视频轨还在解码」—— 此时 `videoWidth` 还是 0、`readyState` 可能只到 `HAVE_METADATA`，元素其实已经在放声音、`currentTime` 在走，旧逻辑照样把线路判死，用户听到声音、界面却提示「当前线路不可用」。现在把「这条线路活没活」抽成一条通用判据 `src/lib/mediaAlive.ts`（`mediaLooksAlive` / `mediaIsAdvancing` / `mediaAdvanced`）：`readyState >= 2`、`videoWidth > 0`、`currentTime > 0` 且未暂停未结束无 `error`，任一成立都算活；有 `error` 时一律不算活，换线机会不被吞掉。直播页的 4 秒延迟判死改成「窗口内媒体时钟前进 ≥0.3s 也撤回」，播放内核的 stall 看门狗与「源侧响应较慢」提示走同一判据 —— 有声音就不再探活、不再挂「加载中」。新增 `tests/frontend/mediaAlive.test.ts`（10 条）锁住音频先出 / 只有画面 / 暂停 / 报错几种情形。
- **侧栏品牌去掉「TVBox 兼容」副标题**：`src/AppShell.tsx` 的品牌区只留 `Luma`，`layout.css` 里 `.brand__text small` 的副标题样式一并删掉 —— 产品定位不需要在界面上自我说明兼容谁。

### 工程

- 直播频道 header 透传补齐 `src-tauri/src/domain/live/m3u.rs` 的 3 条单测（频道级 ua/referer 保留、无声明不写空字段、同名台先声明者优先）；`src-tauri/src/domain/play.rs` 补 `looks_like_playlist` 的单测（BOM / 前导空白 / 小写 `#extm3u` 认，HTML 与空串不认）。
- `src/lib/format.ts` 新增 `normalizeEpisodeName` / `sameEpisodeName` 与 `src/lib/format.test.ts` 的对应断言（全角、前导 0、`EP01` 等写法归一）。
- **样式拆成 13 个模块，入口只留级联顺序**：`src/styles.css` 一个文件 5,124 行 / 588 个类选择器 / 27 段分节横幅，改任何一处都要在五千行里上下找覆盖关系。现在按分节横幅切成 `src/styles/` 下的 `base`（`:root` token、字体、滚动条）/ `layout` / `live` / `chrome` / `controls` / `cards` / `feedback` / `detail` / `player` / `player-panels` / `command-palette` / `pages` / `polish`，入口 `index.css` 只保留按顺序的 `@import`；`polish.css` 是「简约设计语言 v2」的后置覆盖层，**必须最后**。拆分是纯搬运：脚本按行切片并断言「按顺序拼接 == 原文件」，打包产物 67,268 → 67,284 字节，CDP 取 `document.styleSheets` 的规则序列化（599 条 / 80,205 字符）与关键元素计算样式前后完全一致。6 个读源码的样式契约测试改为 `tests/frontend/readCss.ts` 的 `readCss()`（按 `@import` 顺序拼接），新增 `tests/frontend/styleModules.test.ts` 锁住「入口不含规则」「`polish.css` 在最后」；`docs/project-layout.md`、`docs/DEVELOPMENT.md`、`AGENTS.md` 与 `tools/verify/verify_cover_spec.mjs` 的路径说明同步。

- **设计语言 v2.1：把「看着不齐」的地方收敛成一套尺度**：`base.css` 新增 `--h-chip: 28px` / `--h-control: 34px` / `--h-cta: 40px` 三档控件高度、`--line-measure: 70ch` 阅读宽度、`--scrim` 封面压暗色，并把 `--fs-h1` 从 23px 回填成页头实际的 21px。此前 8 个页面的按钮/输入/下拉实测高度有 26/29/32/33/34/36/38/40 八种，同一行的按钮与输入框底边对不齐；现在 `.btn` / `.input` / `.app-select__trigger` / 直播源搜索框 / 刷新条下拉 / GitHub 加速自定义输入统一走 `--h-control`，主行动按钮走 `--h-cta`。首页分类 chip 从三行换行（吃掉约 100px 首屏）改成单行横向滚动（`.chip-row--tabs`，右缘渐隐）；搜索页结果摘要从三段灰字收成一行（失败源按钮与「只看片名匹配」并排，探针依赖的 `.failure-panel button` 文案不变）；设置页章节标题升到 `--fs-h2`、左侧二级导航改成与侧栏同款的「淡蓝底 + 左侧 2px 竖标」；详情页简介限宽 70ch、单集格子不再塞第二行「上次看到」文字（改为右上角绿点）；封面角标/清晰度/信息条的写死近白（`#f1f1f6`、`rgba(241,241,246,0.92)`、`#f2f4f9`、`rgba(238,241,247,0.82)`）全部改用 token。图标档位同步收敛：直播列表台标 22→20、分组 caret 12→14。用一次性 CDP 巡检脚本逐页量（`tools/.out/audit_pages.mjs`，不入库）：8 个页面的写死近白清零、控件高度收敛到 28/34/40 三档、`.page-head` 高度不再在 32/34/38 间跳。新增 `tests/frontend/designScale.test.ts`（7 条）锁住 token、控件高度引用、首页分类滚动行、页头/章节标题字号、单集绿点与封面信息条 token。

- 新增 `tests/frontend/playerAudioFade.test.ts`（4 条）与 `tests/frontend/playPage.test.ts`（4 条）源码契约；前端用例 367 → 375（46 → 48 个文件）。
- **交互态收尾（占位色 / 按压 / 滚动吸附）**：封面无图占位、详情与播放页海报底、加载 spinner 环、骨架高光里还残留 `#1a202c` / `#12161e` / `#1c232e` / `#2a3344` 四个写死蓝灰，统一换成 `--panel-raised` / `--panel-sunken` / `--border-strong`；补上点击反馈（`.chip`、`.live-rail__item`、`.episode`、`.settings-nav__item`、`.source-item` 的 `:active` 只换底色明度、不位移，符合「交互靠明度」的设计语言 v2）；首页分类单行滚动加 `scroll-snap-type: x proximity`，键盘/触控板横滚不会把半个分类词切在边缘。CDP 用 `Input.dispatchKeyEvent` 连按 Tab 巡检首页 14 个停靠点，焦点环统一为 `2px var(--accent)` + `offset 2px`。
- **综艺 / 短剧的长集名在选集格子里被左右同时裁掉**：`.episode` 是固定列宽 + 居中单行，`20260515特别企划` 这类 10+ 字显示成 `0260515特别企划`（省略号也在被裁的一侧，看不到）。折两行会把整行网格撑得高低不齐，所以改成单行**左对齐**裁切，指针悬停或键盘聚焦时把内容横向滚到末尾露出整个集名、移开 / 失焦回位；抽成 `src/components/EpisodeButton.tsx`，详情页与播放页选集区共用，完整集名仍在 `title` 里。CDP 实测「歌手2026」详情页（电影天堂 / 81937，86 集）：格子高度统一 34px、30 条集名超宽、悬停后 `scrollLeft == scrollWidth - clientWidth`、移开回 0。新增 `tests/frontend/episodeScroll.test.ts`（3 条）锁住滚动行为、两处调用点与「单行 + 可横向滚动」的 CSS。

- 封面取图缓存补齐：`src/hooks/useProxiedImage.ts` 增加 `cachedProxyBase` / `LOADED_SRC`（`RESOLVED_SRC` 与`LOADED_SRC` 各 1200 条），骨架去掉动画；新增 `tests/frontend/imageCache.test.ts`（4 条）；前端用例 375 → 379（48 → 49 个文件）。

---

## [1.0.3] — 2026-11-15

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
- **构建产物**：官方 `tauri build` 产出 `src-tauri/target/release/bundle/nsis/Luma_1.0.3_x64-setup.exe`（**25.44 MiB** / 26,670,865 字节，SHA256 `73201B96CCE7CCBF07167CA18715924EAC47A1CEEB6FA80607CDCB6333824954`）。静默安装实测解包 **87.64 MB**：`Luma.exe` 8.44 MB、`qjs-runner.exe` 3.59 MB、`python-embed` 74.27 MB、`qjs-assets` 0.95 MB、`py` 0.27 MB。比 1.0.2 同口径（≈113.3 MB）少约 25.7 MB，安装器比 1.0.2 的 38.75 MiB 小 13.31 MiB，主因是移除 JRE。体积口径见 `docs/size-report.md`。

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
- T-31（`luma://` 协议关联、JumpList、全屏勿扰）未实现，规格要求逐项手工验收。
- mpv 不随安装包分发（单文件约 117MB），需要时自行放入安装目录的 `sidecars/mpv/`。
- 公开源失效频繁，属正常现象；自动换源与源级原因提示是必需能力。

---

## [1.0.0-alpha] — 2026-11-11 ~ 2026-11-14

试运行版本。完成 P0 ~ P3（T-31 除外）：Tauri v2 + React 骨架、四类源适配层、SQLite、ArtPlayer、便携打包、CDP 探针回归体系。真实配置「导入 → 全站搜索 → 详情 → 播放」出画（101 站点 / 17 直播源）。逐轮过程记录不随仓库分发。
