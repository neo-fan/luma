# 站点兼容性实测报告（真实配置 box）

> **归档快照（2026-11-14 补）**：本报告是 2026-11-12 09:01 的**冻结快照**，表内逐站结论与「暂不支持」原因均为当时状态，**不代表 1.0.0 现状**。JS（quickjs）源当时仍被屏蔽，已于同日 12 时接入（见 `docs/js-support.md`），故 JS 部分口径已失效；jar 部分「不支持」结论仍成立且已写入 README。请勿据此表判断当前支持范围。

- 时间：2026/11/12 09:01:12
- 关键词：`走马上任`；并发：5；单步超时：详情/播放 12s、解析池 17s、resolve 17s、探活 7s（与前端 15s 解析/嗅探预算对齐）
- 首页聚合种子：50/67 站响应；总耗时 160.0s

## 口径说明

- **播放可用 = 地址可解析 + 本地反代返回真 m3u8/媒体字节**，不等于真实解码出画；真实出画由 UI 探针抽样（`videoWidth/Height > 0`）。
- `kind=page` 记「? 需网页嗅探」不计硬失败：真实前端会自动嗅探/换源，但嗅探有 15s 预算，扫描不等它。
- 单片只有 1 集、无 `vod_pic` 记 n/a 不计失败；被导入侧屏蔽的 jar/JS 源单列，不参与通过率。
- `detailContent` 返回空列表的发现/推荐型源（如豆瓣）记为 `capability_gap`，是源的能力缺口而非客户端 bug；前端已有按片名回查兜底。
- 站点名含「直播」的源有独立 `live_parse` 链路，按 VOD 口径失败记为 `live_n/a`，不算兼容缺陷。
- 外网源有时效/防盗链，单次探活失败可能是瞬时状态；结论按「问题类型」看，不按单次成败给站点判死刑。

## 总览

| 指标 | 数值 |
|---|---|
| 配置站点总数 | 101 |
| 可运行站点（实测） | 67 |
| 导入侧屏蔽 | 34（手动禁用 8、quickjs/drpy2 6、jar/jvm(dex) 20） |
| 实测站点 | 67 |
| 全部四项通过（ok） | 24 |
| 部分可用（partial：page/单片/n-a） | 0 |
| 有硬失败（fail/detail_failed/no_episodes） | 16 |
| 无可用条目 no_seed（含源不可达/超时） | 24 |
| 能力缺口（空详情） | 2 |
| 直播型源（VOD 口径不适用） | 1 |
| 详情可用 | 40 / 67 |
| 封面可用（含 n/a） | 63 / 67 |
| 首集地址可达 | 28 / 67 |
| 下一集可达或 n/a | 60 / 67 |

## 按运行时分组

| runtime | 站点数 | ok | partial | 失败 |
|---|---|---|---|---|
| cms | 20 | 11 | 0 | 9 |
| python | 47 | 13 | 4 | 30 |

## 失败原因归类

| 类型 | 次数 |
|---|---|
| 播放｜反代/探活 | 5 |
| 封面｜反代/探活 | 4 |
| 播放｜地址解析 | 4 |
| 下一集｜反代/探活 | 3 |
| 详情｜空结果 | 2 |
| 下一集｜地址解析 | 2 |
| 下一集｜超时 | 2 |
| 详情｜其它 | 1 |

## 无可用条目（no_seed）原因归类

| 类型 | 站点数 |
|---|---|
| 脚本/扫描超时 | 10 |
| 首页/分类/搜索均返回空列表 | 8 |
| 源返回畸形 XML / 脚本自身异常 | 4 |
| 源站不可达 / SSL 失败 / 依赖本地服务 | 2 |

## 逐站明细

| # | 站点 | runtime | 结论 | 详情 | 封面 | 首集 | 下一集 | 备注 |
|---|---|---|---|---|---|---|---|---|
| 1 | 豆瓣[py] | python | capability_gap | ✗ empty(发现/推荐型源无播放列表) | 未测 | 未测 | 未测 | 种子:homeVideoContent；种子:homeVideoContent:list=20,cls=0 |
| 2 | 直播[py] | python | live_n/a | ✓  | ✗ 代理返回非 2xx | ✗ resolve_play: play url is invalid | ? 单片/仅 1 集，不适用 | 种子:homeContent(聚合)；1集；地址形态:cctv1 |
| 3 | 短剧[py] | python | ok | ✓  | ✓ 199510B | ✓ file 206 | ✓ file 206 | 种子:homeContent(聚合)；87集；地址形态:http |
| 4 | 苹果[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/categoryContent:list=0,cls=0/searchContent:list=；首页/分类/推荐/搜索均无可用条目 |
| 5 | 枫叶[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/categoryContent:list=0,cls=0/searchContent:list=；首页/分类/推荐/搜索均无可用条目 |
| 6 | 剧踪[py] | python | fail | ✓  | ✓ 243741B | ? 需网页嗅探/解析（page） | ✗ resolve_play: resolve_play timeout | 种子:homeContent(聚合)；16集；地址形态:http；解析池:all 4 parsers failed |
| 7 | 红果[py] | python | fail | ✓  | ✓ 160472B | ✗ 媒体流探活失败 | ✗ 媒体流探活失败 | 种子:homeContent(聚合)；202集；地址形态:http |
| 8 | 瓜子[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/categoryContent:list=0,cls=0/searchContent:list=；首页/分类/推荐/搜索均无可用条目 |
| 9 | 片库[py] | python | ok | ✓  | ✓ 253541B | ✓ hls 200 | ✓ hls 200 | 种子:homeVideoContent；30集；地址形态:http |
| 10 | 华视[py] | python | fail | ✓  | ✓ 20590B | ✗ resolve_play: play url is invalid | ✗ resolve_play: play url is invalid | 种子:homeContent(聚合)；30集；地址形态:/vodplay/204；playerContent:python adapter spider.py |
| 11 | 如意[py] | python | ok | ✓  | ✓ 32367B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；1278集；地址形态:http |
| 12 | 酷客[py] | python | fail | ✓  | ✗ 代理返回非 2xx | ✓ hls 200 | ? 单片/仅 1 集，不适用 | 种子:homeContent(聚合)；1集；地址形态:http |
| 13 | 人人[py] | python | fail | ✓  | ✓ 282833B | ✗ resolve_play: play url is invalid | ✗ resolve_play: play url is invalid | 种子:homeVideoContent；8集；地址形态:220379 |
| 14 | PPnix[py] | python | fail | ✓  | ✓ 9780B | ✗ resolve_play: play url is invalid | ? 单片/仅 1 集，不适用 | 种子:homeContent(聚合)；1集；地址形态:9095@1080P |
| 15 | LIBVIO[py] | python | ok | ✓  | ✓ 37216B | ✓ file 206 | ✓ file 206 | 种子:homeContent(聚合)；6集；地址形态:http |
| 16 | 歪比巴卜[py] | python | detail_failed | ✗ HTTP 403 | 未测 | 未测 | 未测 | 种子:homeVideoContent |
| 17 | 可可追剧[py] | python | ok | ✓  | ✓ 13736B | ✓ hls 200 | ? 单片/仅 1 集，不适用 | 种子:homeContent(聚合)；1集；地址形态:http |
| 18 | 布布追剧[py] | python | ok | ✓  | ✓ 1103198B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；2集；地址形态:http |
| 19 | 袋鼠影视[py] | python | ok | ✓  | ✓ 11788B | ✓ hls 200 | ? 单片/仅 1 集，不适用 | 种子:homeContent(聚合)；1集；地址形态:http |
| 20 | 影视天堂[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/categoryContent:list=0,cls=0/searchContent:list=；首页/分类/推荐/搜索均无可用条目 |
| 21 | 雪落影视[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeContent:err=python adapter spider.py exceeded 12000m/homeVideoContent:err=；homeContent: python adapter spider；homeVideoContent: python adapter s；searchContent: python adapter spid；首页/分类/推荐/搜索均无可用条目 |
| 22 | 山楂影视[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeContent:err=HTTPConnectionPool(host='127.0.0.1', por/homeVideoContent:err=；homeContent: HTTPConnectionPool(ho；homeVideoContent: HTTPConnectionPo；首页/分类/推荐/搜索均无可用条目 |
| 23 | 奇优影视[py] | python | ok | ✓  | ✓ 52085B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；40集；地址形态:http |
| 24 | 蛋挞影视[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/categoryContent:list=0,cls=0/searchContent:list=；首页/分类/推荐/搜索均无可用条目 |
| 25 | 阳光影视[py] | python | no_episodes | ✓  | 未测 | 未测 | 未测 | 种子:homeContent(聚合)；0集 |
| 26 | 骚火影视[py] | python | fail | ✓  | ✓ 23400B | ? 需网页嗅探/解析（page） | ✗ resolve_play: resolve_play timeout | 种子:homeContent(聚合)；16集；地址形态:http |
| 27 | 多多影视[py] | python | ok | ✓  | ✓ 1103198B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；2集；地址形态:http |
| 28 | 欧乐影院[py] | python | fail | ✓  | ✓ 9337B | ✗ m3u8 探活未返回播放列表 | ✓ hls 200 | 种子:homeContent(单站)；39集；地址形态:http |
| 29 | 剧OK[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeContent:err=python adapter spider.py exceeded 12000m/homeVideoContent:err=；homeContent: python adapter spider；homeVideoContent: python adapter s；首页/分类/推荐/搜索均无可用条目 |
| 30 | --- 1 --- | none | 屏蔽/未测 | — | — | — | — | 未纳入本轮 |
| 31 | 荐片[js] | quickjs | 屏蔽/未测 | — | — | — | — | JS 源（drpy2 / ES 模块）暂不支持 |
| 32 | 金牌[js] | quickjs | 屏蔽/未测 | — | — | — | — | JS 源（drpy2 / ES 模块）暂不支持 |
| 33 | apple[js] | quickjs | 屏蔽/未测 | — | — | — | — | JS 源（drpy2 / ES 模块）暂不支持 |
| 34 | 聚合短剧[js] | quickjs | 屏蔽/未测 | — | — | — | — | JS 源（drpy2 / ES 模块）暂不支持 |
| 35 | --- 2 --- | none | 屏蔽/未测 | — | — | — | — | 未纳入本轮 |
| 36 | 番茄动漫[py] | python | ok | ✓  | ✓ 78349B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(单站)；1194集；地址形态:http |
| 37 | --- 3 --- | none | 屏蔽/未测 | — | — | — | — | 未纳入本轮 |
| 38 | 高清电影[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeContent:list=0,cls=2/homeVideoContent:list=0,cls=0/categoryContent:list=0,；searchContent: HTTPSConnectionPool；首页/分类/推荐/搜索均无可用条目 |
| 39 | 金牌影院[py] | python | fail | ✓  | ✗ 代理返回非 2xx | ✓ hls 200 | ✓ hls 200 | 种子:homeVideoContent；30集；地址形态:http |
| 40 | 奇优动漫[py] | python | capability_gap | ✗ empty(发现/推荐型源无播放列表) | 未测 | 未测 | 未测 | 种子:searchContent；种子:homeVideoContent:list=0,cls=0/categoryContent:list=0,cls=0/searchContent:list= |
| 41 | 粤漫动漫[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/categoryContent:list=0,cls=0/searchContent:list=；首页/分类/推荐/搜索均无可用条目 |
| 42 | 界影视[py] | python | ok | ✓  | n/a | ✓ hls 200 | ✓ hls 200 | 种子:homeVideoContent；40集；地址形态:http；解析池:all 3 parsers failed |
| 43 | 爱瓜TV[py] | python | ok | ✓  | n/a | ✓ hls 200 | ✓ hls 200 | 种子:homeVideoContent；30集；地址形态:http |
| 44 | 国外剧情[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/searchContent:err=HTTPSConnectionPool(host='guow；searchContent: HTTPSConnectionPool；首页/分类/推荐/搜索均无可用条目 |
| 45 | 偷乐短剧[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/categoryContent:list=0,cls=0/searchContent:list=；首页/分类/推荐/搜索均无可用条目 |
| 46 | 嗨皮影视[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:err=HTTPSConnectionPool(host='wys.upfuhn.com/categoryContent:；homeVideoContent: HTTPSConnectionP；searchContent: HTTPSConnectionPool；首页/分类/推荐/搜索均无可用条目 |
| 47 | 云端影视[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:err=HTTPSConnectionPool(host='ydysdynamicdom/searchContent:er；homeVideoContent: HTTPSConnectionP；searchContent: HTTPSConnectionPool；首页/分类/推荐/搜索均无可用条目 |
| 48 | 云速影视[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/searchContent:err=HTTPConnectionPool(host='127.0；searchContent: HTTPConnectionPool(；首页/分类/推荐/搜索均无可用条目 |
| 49 | 农牧影视[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:err=HTTPSConnectionPool(host='www.nmdvd.com'/searchContent:er；homeVideoContent: HTTPSConnectionP；searchContent: HTTPSConnectionPool；首页/分类/推荐/搜索均无可用条目 |
| 50 | 文才影视[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:err=cannot access local variable 'hosts' whe/searchContent:er；homeVideoContent: cannot access lo；searchContent: cannot access local；首页/分类/推荐/搜索均无可用条目 |
| 51 | 4KAV[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/searchContent:list=0,cls=0；首页/分类/推荐/搜索均无可用条目 |
| 52 | --- 4 --- | none | 屏蔽/未测 | — | — | — | — | 未纳入本轮 |
| 53 | 飞快影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 54 | 人人影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 55 | 农民影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 56 | 熊猫影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 57 | 秀儿影院 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 58 | 毒舌影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 59 | 星辰影院 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 60 | 全网看 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 61 | 喝茶影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 62 | 策弛影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 63 | 茶杯狐影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 64 | 瓜籽影院 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 65 | 来看点播 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 66 | 布卡影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 67 | 一帆影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 68 | 欧乐影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 69 | 奇迹影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 70 | --- 5 --- | none | 屏蔽/未测 | — | — | — | — | 未纳入本轮 |
| 71 | 360 \| 采集 | cms | ok | ✓  | ✓ 816475B | ✓ hls 200 | ? 单片/仅 1 集，不适用 | 种子:homeContent(聚合)；1集；地址形态:http；playerContent:method PlayerContent is  |
| 72 | 豆瓣 \| 采集 | cms | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:err=fetch https://caiji.dbzy5.com/api.php/pr/searchContent:er；homeVideoContent: fetch https://ca；searchContent: fetch https://caiji；首页/分类/推荐/搜索均无可用条目 |
| 73 | 创享 \| 采集 | cms | ok | ✓  | ✓ 201576B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；30集；地址形态:http；playerContent:method PlayerContent is  |
| 74 | 索尼 \| 采集  | cms | ok | ✓  | ✓ 21819B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；707集；地址形态:http；playerContent:method PlayerContent is  |
| 75 | 量子 \| 采集 | cms | ok | ✓  | ✓ 12270B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；77集；地址形态:http；playerContent:method PlayerContent is  |
| 76 | 非凡 \| 采集 | cms | fail | ✓  | ✓ 29855B | ✗ fetch: signal timed out | ✓ hls 200 | 种子:homeContent(聚合)；790集；地址形态:http；playerContent:method PlayerContent is  |
| 77 | 无尽 \| 采集 | cms | fail | ✓  | ✗ 代理返回非 2xx | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；709集；地址形态:http；playerContent:method PlayerContent is  |
| 78 | 金鹰 \| 采集 | cms | ok | ✓  | ✓ 21087B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；5集；地址形态:http；playerContent:method PlayerContent is  |
| 79 | 新浪 \| 采集 | cms | ok | ✓  | ✓ 21087B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；5集；地址形态:http；playerContent:method PlayerContent is  |
| 80 | 速播 \| 采集 | cms | ok | ✓  | ✓ 21087B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；5集；地址形态:http；playerContent:method PlayerContent is  |
| 81 | 优质 \| 采集 | cms | ok | ✓  | ✓ 19444B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；11集；地址形态:http；playerContent:method PlayerContent is  |
| 82 | 樱花 \| 采集 | cms | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:err=mismatched tag: line 6, column 2/searchContent:err=mismat；homeVideoContent: mismatched tag: ；searchContent: mismatched tag: lin；首页/分类/推荐/搜索均无可用条目 |
| 83 | 黑木耳 \| 采集 | cms | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:err=mismatched tag: line 25, column 2/searchContent:err=misma；homeVideoContent: mismatched tag: ；searchContent: mismatched tag: lin；首页/分类/推荐/搜索均无可用条目 |
| 84 | 天堂 \| 采集 | cms | ok | ✓  | ✓ 12270B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；77集；地址形态:http；playerContent:method PlayerContent is  |
| 85 | ikun \| 采集 | cms | ok | ✓  | ✓ 71130B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；7集；地址形态:http；playerContent:method PlayerContent is  |
| 86 | 暴風 \| 采集 | cms | ok | ✓  | ✓ 21780B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；4集；地址形态:http；playerContent:method PlayerContent is  |
| 87 | 旺旺 \| 采集 | cms | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:err=not well-formed (invalid token): line 8,/searchContent:er；homeVideoContent: not well-formed ；searchContent: not well-formed (in；首页/分类/推荐/搜索均无可用条目 |
| 88 | 艾旦 \| 采集 | cms | fail | ✓  | ✓ 15210B | ✗ m3u8 探活未返回播放列表 | ✓ hls 200 | 种子:homeContent(聚合)；4集；地址形态:http；playerContent:method PlayerContent is  |
| 89 | 四圈 \| 采集 | cms | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:err=fetch https://pg.fenwe078.cf/api.php/pro/searchContent:er；homeVideoContent: fetch https://pg；searchContent: fetch https://pg.fe；首页/分类/推荐/搜索均无可用条目 |
| 90 | 茅台 \| 采集 | cms | fail | ✓  | ✓ 173694B | ✗ m3u8 探活未返回播放列表 | ✗ m3u8 探活未返回播放列表 | 种子:homeContent(聚合)；16集；地址形态:http；playerContent:method PlayerContent is  |
| 91 | --- 6 --- | none | 屏蔽/未测 | — | — | — | — | 未纳入本轮 |
| 92 | YYMP3[py] | python | no_seed | 未测 | 未测 | 未测 | 未测 | 种子:homeVideoContent:list=0,cls=0/searchContent:err=python adapter spider.py excee；searchContent: python adapter spid；首页/分类/推荐/搜索均无可用条目 |
| 93 | KTV歌厅 | quickjs | 屏蔽/未测 | — | — | — | — | JS 源（drpy2 / ES 模块）暂不支持 |
| 94 | 电视┃直播 | quickjs | 屏蔽/未测 | — | — | — | — | JS 源（drpy2 / ES 模块）暂不支持 |
| 95 | --- 7 --- | none | 屏蔽/未测 | — | — | — | — | 未纳入本轮 |
| 96 | MiFun｜动漫 | python | fail | ✓  | ✓ 41087B | ✓ hls 200 | ✗ m3u8 探活未返回播放列表 | 种子:homeContent(聚合)；6集；地址形态:http |
| 97 | 樱花｜动漫 | python | ok | ✓  | ✓ 469580B | ✓ hls 200 | ✓ hls 200 | 种子:homeContent(聚合)；34集；地址形态:http |
| 98 | --- 8 --- | none | 屏蔽/未测 | — | — | — | — | 未纳入本轮 |
| 99 | 小镇影视 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 100 | 狐狸君 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |
| 101 | 大白鲨 | jvm | 屏蔽/未测 | — | — | — | — | jar 源为 Android dex，Windows 端暂不支持 |

## 结论与处置（人工分析，基于两轮扫描 + 代码核查）

### 客户端侧：本轮已修

1. **`split_scheme_link` 误判自定义 scheme**（第一轮实测确凿）：`人人[py]` 返回 `magnet:?xt=...&tr=udp://tracker`，`resolve_play` 只找第一个 `://`，把 `magnet:?xt=...&tr=udp` 当成解析器名，报 `play url scheme ... could not be resolved; available parsers: [...]`。现按 RFC 3986 校验 scheme 语法（`ALPHA *(ALPHA / DIGIT / + - .)`），query 里内嵌的 `://` 不再误判；并新增 `non_web_media_scheme()`，对 `magnet/ed2k/thunder/ftp/file` 直接返回「源返回 X 链接，桌面播放器不支持，请换源」，不让它们白跑 15s 解析池/嗅探。`play.rs` 新增 2 条单测，`cargo test --lib` **78/78**。
2. **扫描工具与前端口径对齐**：`playerContent` 只采用 http(s) 返回值（与 `usePlayResolution.ts` 一致）。此前扫描把 `/vodplay/...`、`?type=m3u8&url=...` 这类相对返回值直接当播放地址，制造了一批假失败。
3. **扫描预算对齐**：单步 7s → 12s（前端 spider 默认 15s），解析池/嗅探 17s（前端 15s + 余量），减少「脚本超时」误判。
4. **自动下一集提示条丢失**（`PlayerPage.tsx`）：dev 下 `React.StrictMode` 会把挂载 effect 连跑两次，第一次读走 `sessionStorage` 的一次性提示，第二次读到 `null` 又把 `switchTip` 清空，用户永远看不到「已自动播放下一集」。改用 `tipRestored` ref 记住本次挂载已恢复，第二次不再覆盖。切换本身、音量/倍速继承一直正常；修复后 `probe_playback_ux` 全项 PASS。

### 客户端侧：已定位，建议后续处理（本轮未改，避免范围膨胀与回归）

| 问题 | 证据 | 建议的通用修法（宿主边界层，不逐源补丁） |
|---|---|---|
| 相对/私有播放地址播不了 | `华视[py]` `/vodplay/204173-1-1.html`、`PPnix[py]` `?type=m3u8&url=...`、`人人[py]` 裸 ID，前端一律丢弃 `playerContent` 返回值后 `resolve_play` 报 `play url is invalid` | 在 `resolve_play`/归一化层：相对路径按 `site.api` origin 补齐；`?type=...` 这类 TVBox 本地代理简写映射到 `/proxy?do=py`；私有 scheme 转 `parses[]` 或明确提示换源 |
| `/image` 封面 502（4 站） | 直播 / 酷客 / 金牌影院 / 无尽，均 502 `text/plain` | 归一化层补相对 `vod_pic`；把 502 明细写进 `spider.log` 以区分「相对路径 / 图床拒绝 / 私有 IP」 |
| py `localProxy` 约定未兑现 | `红果[py]` 返回 `http://127.0.0.1:10010/hg.mp4?...`，本机反代只认 `/proxy?do=py`，取流 502 | 统一把脚本本地代理地址rewrite 到当前动态反代端口，或兑现 `localProxy` 转发 |
| CMS 畸形 XML | 樱花/黑木耳/旺旺 `mismatched tag` / `not well-formed`，文才影视 `cannot access local variable 'hosts'` | CMS 解析层加 recover 容错；但站点返回错误页/脚本自身异常，属源侧，改善有限 |

### 源侧（非客户端缺陷）

- **24 个 `no_seed`**：脚本/扫描超时 10、首页/分类/搜索全空 8、畸形 XML/脚本异常 4、源站 SSL/连接失败/依赖本地服务 2。注意关键词固定为「走马上任」，部分站是「该关键词无结果」而非源不可用；单步预算仍略低于前端 15s。
- **网页播放页需嗅探**（剧踪 / 骚火）：`parse_resolve` 返回 `all 4 parsers failed`、`resolve_play` 走 page 嗅探，属源形态，前端会自动嗅探/换源。
- **m3u8 时效/防盗链**（茅台 / 艾旦 / 非凡 / 欧乐）：两轮扫描结果翻转，说明外网瞬时性占主导，不能据此判定站点不可用。
- **详情 403**（歪比巴卜）、**空详情**（豆瓣 / 奇优动漫，发现推荐型源，前端已有按片名回查）、**直播型源**（有独立 `live_parse` 链路）各单列。
- **34 个导入侧屏蔽**（20 jar/jvm + 6 quickjs + 8 手动禁用）是既定范围决策，不参与兼容率。

### 结论口径

「四项全通过 24/67」是**单次、单关键词、固定预算**的保守下界，不等于站点永久可用率。真实解码出画以 UI 探针为准；本轮未发现「所有站通吃的客户端崩溃/协议性缺陷」，已修的 1 个是解析链接误判，其余集中在「脚本返回值形态多样」与「外网源稳定性」两类。

## 真实窗口验证（UI 探针，补充地址探活之外的出画证据）

| 探针 | 结果 | 关键证据 |
|---|---|---|
| `probe_search_ui.mjs` | **PASS** | 真实配置 36/67 站响应 / 197 条结果 → 详情 23 集 → 播放器 `videoWidth=1920, videoHeight=1080, paused=false`（真实出画） |
| `probe_playback_ux.mjs` | **PASS**（修复提示条后） | 自动下一集切到第 2 集、音量 0.35 / 倍速 1.5 跨集继承、提示条「已自动播放下一集：第 2 集」、Esc 层级返回、复制错误 |
| `cargo test --lib` | **78/78** | 含新增 `split_scheme_link` / `non_web_media_scheme` 4 条断言 |
| `pnpm build` / `pnpm test` | OK / **145/145** | 前端类型检查与单测全绿 |

> 报告由 `tools/scan_site_compat.mjs` 生成（统计 + 逐站明细），「结论与处置」及本节为人工补充；原始数据 `.workbuddy/site-compat-raw.json` 不入库。
