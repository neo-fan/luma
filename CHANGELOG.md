# 变更日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，版本号遵循语义化版本。**唯一版本来源**是 `package.json`，同步清单与发布流程见 `docs/RELEASING.md`。

---

## [1.1.0] — 2026-11-15

1.1.0 的主线：**适配层只剩「执行第三方源脚本」一条职责**（py 源的结果映射不再随 sidecar 走）、**播放页体验重做**（原地换集/换源、失败可一键换线、后台播放指示）、**封面 HTTP 缓存**与**一键安装器**；版本号与 build 号同时收敛到单一来源。

### 变更

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

### 修复

- **详情 / 播放页简介在信息超长时被压成窄条、卡片被无谓拉高**：简介宽度一直是 `--line-measure: 70ch`（约 491px），而 `ch` 量的是西文「0」的宽度 —— 中文字体下每行只剩三十多字，卡片宽 1164 时简介只占左半边，长剧情一路往下堆，右边大片空白；收起态用 `max-height: 84px` 硬裁（行高不是整 84 的约数时最后一行会被切一半），展开态又退回 `max-height: 220px + overflow-y: auto`，在卡片里叠出第二根滚动条。现在简介按信息列宽度排（`min(100%, 72em)`，em 量汉字宽度，超宽屏也不会长到读不下去），收起改成 `-webkit-line-clamp: 4` 自带省略号，展开后不设上限、让卡片自然长高；播放页信息卡底部留白从 2px 加到 10px，「主演」这类长名单允许在任意位置断行。顺带修掉播放页标题行右侧图标的悬浮气泡顶出列宽 5px 造成的横向滚动（气泡改为右对齐向左展开）。`base.css` 删掉已无人使用的 `--line-measure`，`tests/frontend/designScale.test.ts` 把「简介按列宽限读、按行裁切、展开不内嵌滚动」钉成契约。
- **简介的「展开 / 收起」从一枚孤立图标改成正文下方的行内按钮**：原来它是个没有文案的 chevron 图标，还排在「播放」按钮那一行 —— 展开后箭头孤零零挂在按钮左边，用户根本不知道它管的是简介。现在开关带文案（「展开全文」/「收起简介」）、紧贴正文左下角，箭头按 `aria-expanded` 翻转；`VodMetaHero` 不再把开关塞进 footer，`icon-btn--rotate` 这条只为它存在的样式一并删掉。

### 工程

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
- T-31（`tvbox://` 协议关联、JumpList、全屏勿扰）未实现，规格要求逐项手工验收。
- mpv 不随安装包分发（单文件约 117MB），需要时自行放入安装目录的 `sidecars/mpv/`。
- 公开源失效频繁，属正常现象；自动换源与源级原因提示是必需能力。

---

## [1.0.0-alpha] — 2026-11-11 ~ 2026-11-14

试运行版本。完成 P0 ~ P3（T-31 除外）：Tauri v2 + React 骨架、四类源适配层、SQLite、ArtPlayer、便携打包、CDP 探针回归体系。真实配置「导入 → 全站搜索 → 详情 → 播放」出画（101 站点 / 17 直播源）。逐轮过程记录不随仓库分发。
