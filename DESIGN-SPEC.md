# Luma UI/UX 走查报告与改版规格

> 走查方式：CDP 9222 驱动真实 debug 窗口（WebView2 157.0.4341.46），视口锁定 1280×800 @1x。
> 全部结论基于真实渲染像素 + DOM 量测，不靠读代码推断。
> 截图产物：`.workbuddy/ui-audit/*.png`（22 张）；量测数据：`report.json` / `report3.json` / `report4.json` / `report5.json`。
> 走查脚本：`tools/audit_ui.mjs`（首页/搜索/直播/设置）、`tools/audit_ui3.mjs`（首页→详情→播放）、`tools/audit_ui4.mjs`（直播播放 + 键盘可达性）、`tools/audit_ui5.mjs`（量化测量）。

---

## 0. 结论速览

当前 UI 的**结构与信息架构是成立的**（侧栏 + 单页栈 + 三段式异步态收敛 + 图标优先语言），问题集中在**「长列表与长时间等待」这一类场景**：真实配置 101 站点 / 265 条搜索结果 / 20 秒聚合搜索，把一套为 12 条卡片设计的界面撑破了。

按「改造成本 ÷ 用户可感收益」排序的 6 个问题：

| # | 问题 | 实测证据 | 严重度 |
|---|---|---|---|
| P0-1 | **搜索结果视口内约 20% 的封面加载不出来**，且加载中/失败都是纯色块无提示 | 冷加载实测：1.8s 视口加载率 61~81%，等 10s 仍只有 77~81%（约 20% 不出图）；`/image` 代理 p50 **129ms** 但 max **5183ms**——少数图床极慢，同域 6 连接被慢图占满 | P0 |
| P0-2 | **原始 fetch 报错直接暴露给用户** | 截图 `31`：完整 URL + `mismatched tag: line 25, column 2` | P0 |
| P0-3 | **失败数自相矛盾**：摘要说 41 个失败，明细只列 5 个 | `report4.json.search`：`41 个站点失败` vs `failRows 0`、按钮写「查看 5 个失败源」 | P0 |
| P1-1 | **原生 `<select>` 与自研下拉并存**，首页站点选择器是 OS 原生控件 | `report5.json.homeControls`：nativeSelect `appearance: auto`、**101 个 option**、186px 宽 | P1 |
| P1-2 | **直播分组横向溢出 970px**，30 个分组挤在一条窄条里 | `report.json.live.overflow`：chip 右边界 2542px vs 视口 1280px | P1 |
| P1-3 | **详情页空态占满左半屏，右半屏空 60%** | 截图 `21`：`.detail-empty` 604×184，其余全黑 | P1 |

> **P0-1 的准确根因（经三轮对照实验修正，此前判断有误）**
>
 * 初判「`loading="lazy"` + `content-visibility` 叠加导致卡片永不加载」**不成立**。
> 三轮实测把它拆开了：
>
> | 假设 | 实测结果 | 判定 |
> |---|---|---|
> | 懒加载与 content-visibility 叠加 → 图不加载 | 关掉 `content-visibility` 视口加载率无变化（61~81% vs 68%） | ❌ 否 |
> | `contain-intrinsic-size: 400px` 与真实卡高不符 → 布局错位致图不加载 | 三种取值（400px / auto 418px / 457px）视口加载率一致，scrollH 波动均 0~3px | ❌ 否 |
> | **图床响应慢 + 同域 6 连接被慢图占满** | `/image` 代理 p50 **129ms**、max **5183ms**；视口加载率 1.8s 时 61~81%，等 **10s** 仍只有 77~81% | ✅ **是** |
>
> 结论：**约 20% 的封面是上游图床本身慢或不可达**，客户端侧无解（换图源能绕开）。
> 但客户端有两件事必须做对，否则用户完全无从判断：
> ① **加载中**给骨架提示（当前是纯 `--panel` 色块，与「无图」无法区分）；
> ② **加载失败**给可辨识的占位（当前只有「无封面」三个灰字，无法区分是慢、是挂、还是没有）。
>
> 附带修正：`contain-intrinsic-size` 改 `auto 418px`——虽非主因，但真实卡高随列宽变化
> （首页 4 列 457px / 搜索 5 列 418px），固定值必错，`auto` 让浏览器记住上次实测尺寸。



外加两项系统性债务：

- **对比度不达标**：`.chip__badge` 白字压 `--accent` = **3.09:1**（AA 需 4.5:1）；`--faint` 在 `--panel` 上 = **3.14:1**。
- **设计 token 体系未闭合**：`--panel-2` 被引用但从未定义（`styles.css:585`，浏览器静默丢弃该 background）；字号有 14 种非阶梯值（10/11/11.5/12/12.5/13/13.5/14/15/17/18/20/23/26/28px）；字重出现 620/650 这类非标准值。

---

## 1. 任务摘要

**目标**：让 Luma 在真实配置的规模（101 站点 / 265+ 结果 / 20 秒聚合）下仍保持「看得清、点得到、等得住」。

**受众**：桌面端单手操作用户，鼠标 + 键盘；窗口 960×640 ~ 2560×1440。

**交付形态**：React + TypeScript 前端改版规格（保留 Tauri v2 + React 技术栈，不换栈、不引入 AGPL 代码）。

**成功标准**：
1. 搜索结果页所有卡片最终出图，无永久灰块；
2. 用户界面上不出现原始异常栈 / URL / 协议错误码；
3. 聚合搜索期间有可感知的进度与可取消入口；
4. 正文与小字对比度 ≥ 4.5:1；
5. 不破坏现有 21 个 CDP 探针依赖的 className 与文案契约。

---

## 2. 信息架构（改版后）

保持「侧栏 + 单页栈」不变，改动集中在**列表页与等待态**。

```
侧栏（68/204px，收起为图标轨）
├─ 首页        → 页头（站点选择 + 刷新）→ 分类 chip 行 → 卡片网格
├─ 直播        → 页头（源选择 + 频道数）→ 分组导航（侧栏式）→ 频道 chip 行
├─ 搜索        → 搜索栏 → 最近搜索 → 结果摘要条 → 失败抽屉 → 卡片网格
├─ 收藏 / 历史 → 页头（计数）→ 卡片网格
└─ 设置        → 左侧区块目录（吸顶）→ 8 个 section 右侧内容
```

**关键 IA 调整**

| 区块 | 目的 | 优先级 | 高度占比 |
|---|---|---|---|
| 搜索结果摘要条 | 一行讲清「搜了什么 / 命中多少 / 失败多少 / 能不能取消」 | P0 | 固定 44px |
| 失败源抽屉 | 从「一行灰字」升级为可展开列表，**只展示归类后的中文原因** | P0 | 折叠 32px / 展开 ≤240px |
| 卡片网格 | 每卡必出图；无图时给可辨识占位（片名首字 + 站点色） | P0 | 主区 100% |
| 直播分组导航 | 34 个分组改「吸顶横向 chip + 搜索过滤」，不再一行挤 970px | P1 | 吸顶 44px |
| 设置目录 | 8 个区块给左侧可跳转目录，当前项高亮 | P2 | 左侧 180px 常驻 |
| 详情页空态 | 左半屏 → 居中定宽 520px，不再贴左留半屏空 | P1 | 自适应 |

---

## 3. 内容清单（真实文案，替换现有直出文案）

### 3.1 搜索结果摘要条（替换 `.result-meta` 纯文本）

```
庆余年 · 全部站点                        29/70 站点响应 · 20.0 秒
265 条结果（123 条片名匹配）              [只看片名匹配] [取消搜索]
41 个站点未响应  ›                       （可展开抽屉）
```

- 「只看片名匹配」从裸 checkbox 改为 chip（与其它 chip 同语言）。
- 「取消搜索」为**一等按钮**，仅搜索进行中出现。

### 3.2 失败原因归类（替换原始报错直出）

现状直出：`fetch https://caj.dbzy5.com/api.php/provide/vod/?wd=... failed (1 个站点)；站点要求验证码验证，当前无法获取数据 (1 个站点)；mismatched tag: line 25, column 2 (1 个站点)`

改后（按类型聚合，原始详情进二级 tooltip / 可复制诊断）：

```
未响应的 41 个站点
  · 源站超时（22 个）          —— 单站超时 15 秒
  · 需要验证码（9 个）          —— 源站限制匿名访问
  · 返回内容无法解析（6 个）    —— 源站格式异常
  · 已禁用（4 个）
  展开查看具体站点 ›   [复制诊断报告]
```

**规则**：任何用户可见文案不得包含 `http://`、`https://`、`line N, column N`、堆栈、协议名。原始信息只进「复制诊断报告」与 `logger`。

### 3.3 聚合搜索进行中

```
正在检索 70 个站点…            已响应 29 / 70        [取消]
[卡片骨架 × 12]
```

骨架屏（shimmer）替代居中 spinner：用户看到的是「结果即将出现的形状」，而不是一片黑。

### 3.4 空态

| 场景 | 标题 | 说明 | 动作 |
|---|---|---|---|
| 收藏为空 | 还没有收藏任何影片 | 在影片详情页点右上角的星标即可加入收藏 | [去逛首页] |
| 历史为空 | 还没有观看记录 | 播放任意影片后，这里会记录进度，方便下次接着看 | [去逛首页] |
| 搜索无结果 | 没有找到相关内容 | 换个关键词，或选择其它站点再试 | [清空搜索] |
| 详情空（榜单源） | 《后会友期》 | 「豆瓣[py]」是榜单/推荐型源：能给片名、海报和评分，但没有剧集地址 | [全站搜索此片] [换源] |

现有文案基本可用，只需把「去逛」按钮文案统一（原为「去逛逛」）。

---

## 4. 视觉方向

**三个形容词**：克制 · 信息密 · 可预期。

**参考锚点**：Plex 桌面端的媒体库密度；Linear 的列表行；Netflix（非 TV 版）的深色影院面板。

**明确不做**：
- 不做渐变紫 / 玻璃拟态 / 大圆角卡片；
- 不引入彩色品牌块（除播放成功态的绿色状态点）；
- 不做超过 8px 的圆角（当前 `--r-lg: 16px` 降到 12px，`<video>` 卡片保持 12px）；
- 不加顶部大标题横幅、不做 hero 区。

---

## 5. 设计 token

### 5.1 颜色（补全语义层，闭合未定义变量）

| token 名 | 值 | 用途 | 备注 |
|---|---|---|---|
| `--bg` | `#0b0d12` | 窗口底色 | 不变 |
| `--bg-soft` | `#0e1118` | 浮层 / 输入底 | 不变 |
| `--panel` | `#141922` | 卡片面 | 不变 |
| `--panel-hover` | `#1a202c` | 卡片悬浮 | 不变 |
| `--panel-raised` | `#1b2230` | 弹层面 | 不变 |
| `--panel-sunken` | `#12161e` | **新增**：海报占位底 | 替代未定义的 `--panel-2` |
| `--border` | `#222a37` | 描边 | 不变 |
| `--border-strong` | `#303b4d` | 强描边 | 不变 |
| `--text` | `#e9edf5` | 正文 | 16.56:1 ✅ |
| `--text-soft` | `#c3cad8` | 次要正文 | 11.81:1 ✅ |
| `--muted` | `#8a94a8` | 辅助文字 | 6.37:1 ✅ |
| `--faint` | `#7b8699` | **改**：极弱辅助文字 | 5.05:1（原 `#5e687b` 仅 3.46:1，不达标） |
| `--accent` | `#6e8bff` | 强调（焦点环、进度） | 6.29:1 ✅ |
| `--accent-ink` | `#a9bcff` | 强调底上的文字 | 9.50:1 ✅ |
| `--ok` | `#4ade9b` | 成功 | 10.25:1 ✅ |
| `--warn` | `#f0b429` | **新增**：警告（超时 / 需验证码） | 8.1:1 ✅ |
| `--danger` | `#ff7b83` | 错误 | 7.06:1 ✅ |
| `--star` | `#f2c14e` | 收藏 | 10.50:1 ✅ |
| `--badge-on-accent` | `#0b0d12` | **改**：徽标底上的文字 | 压 `--accent` = 6.29:1（原白字 3.09:1 ❌） |

### 5.2 字体

| token 名 | 值 | 用途 | 备注 |
|---|---|---|---|
| `--font-sans` | `"Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif` | 全局 | **改**：移除未加载的 `"Inter"`（项目无 @font-face / 无外链，实际一直回退，声明是误导） |
| `--font-mono` | `ui-monospace, "Cascadia Mono", Consolas, monospace` | 诊断路径 | 不变 |
| `--fs-display` | `26px` | 详情标题 | 原 26px |
| `--fs-h1` | `23px` | 页标题 | 原 23px |
| `--fs-h2` | `17px` | 区块标题 | 原 17px |
| `--fs-h3` | `15px` | 次级标题 | 原 15px |
| `--fs-body` | `14px` | 正文 | 原 14px |
| `--fs-sm` | `13px` | 辅助正文 | 原 13px |
| `--fs-xs` | `12px` | 小字 | 原 12px |
| `--fs-2xs` | `11px` | 徽标 / 时间戳 | 原 11px |
| `--fw-regular` | `400` | 常规 | 统一 |
| `--fw-medium` | `500` | 中等 | 统一 |
| `--fw-semibold` | `600` | 标题 | **改**：620 / 650 / 700 收敛为 600 |

> 字号阶梯从 14 种收敛到 8 种；11.5 / 12.5 / 13.5 / 16 / 18 / 20 / 28px 一律映射到阶梯。

### 5.3 间距（4 的倍数阶梯，新增 token 层）

| token 名 | 值 | 用途 |
|---|---|---|
| `--sp-1` | `4px` | 图标与文字间隙 |
| `--sp-2` | `8px` | chip 内间隙、卡片元信息 |
| `--sp-3` | `12px` | 控件内边距（紧凑） |
| `--sp-4` | `16px` | 控件内边距（标准） |
| `--sp-5` | `20px` | 卡片内边距 |
| `--sp-6` | `24px` | 区块内间隙 |
| `--sp-8` | `32px` | 区块间距 |
| `--sp-10` | `40px` | 大区块间距 |

### 5.4 圆角 / 阴影 / 描边 / 动效

| token 名 | 值 | 用途 | 备注 |
|---|---|---|---|
| `--r-sm` | `8px` | chip、输入、按钮 | 不变 |
| `--r-md` | `12px` | 卡片、面板 | **改**：`--r-lg: 16px` → 12px |
| `--r-lg` | `16px` | 仅弹层 | 保留 |
| `--r-pill` | `999px` | chip / 徽标 | 不变 |
| `--shadow-sm` | `0 2px 10px rgba(0,0,0,.18)` | 卡片 | 不变 |
| `--shadow-md` | `0 12px 32px rgba(0,0,0,.32)` | 浮层 | 不变 |
| `--shadow-lg` | `0 28px 80px rgba(0,0,0,.55)` | 弹窗 | 不变 |
| `--bw` | `1px` | 描边宽度 | 新增 token |
| `--dur-fast` | `120ms` | 悬浮 / 按压 | 原 0.12s |
| `--dur` | `180ms` | 常规过渡 | 原 0.18s |
| `--dur-slow` | `280ms` | 侧栏收放 | 原 0.28s |
| `--ease` | `cubic-bezier(0.2, 0.7, 0.2, 1)` | 通用 | 不变 |

---

## 6. 组件清单

| 组件 | 变体 | 状态 | 关键尺寸 | 依赖 token |
|---|---|---|---|---|
| `VodCard` | default / no-cover / meta | default · hover(translateY -3px) · focus-visible · loading | 封面 2:3；标题 14px/1 行 ellipsis；副标 12px | `--panel` `--r-md` `--shadow-sm` `--text` `--muted` |
| `VodCard`（新）skeleton | — | shimmer | 同上，海报位灰块 + 标题位灰条 | `--panel-sunken` `--icon-hover` |
| `ResultSummary` | new | default · running · done | 高 44px，左片名右统计 | `--text-soft` `--muted` `--accent` |
| `FailureDrawer` | new | collapsed · expanded | 折叠 32px；展开 ≤240px，内部滚动 | `--panel` `--border` `--warn` `--danger` |
| `SiteSelect` | trigger / menu / item | default · hover · active · focus | trigger 38px；menu 宽 320px，**内含搜索框** | `--bg-soft` `--border-strong` `--r-sm` |
| `SearchBar` | new | default · submitting · disabled | 输入 flex:1 max 420px；按钮 88px | `--panel` `--accent` |
| `Chip` | default / active / static / muted | default · hover · active · focus | 高 28px，padding 0 12px | `--panel` `--icon-on` `--border` |
| `Skeleton` | new | shimmer | 16px 高，1.4s 循环 | `--panel-sunken` |
| `ProgressInline` | new | running · done · cancelled | 4px 高线性进度条 | `--accent` `--ok` |
| `Empty` | new | default | 居中定宽 520px，icon 改用 Lucide `Inbox` | `--panel` `--muted` |
| `SettingNav` | new | default · active | 左侧 180px 吸顶，item 高 32px | `--text-soft` `--icon-on` |
| `Toast` | new | info · success · warn · error | 右上 380px，自动 4s，可关闭 | `--panel-raised` `--shadow-md` |
| `IconButton` | md / sm / danger | default · hover · pressed · busy · disabled | md 32×32 / sm 26×26 | `--muted` `--icon-hover` `--icon-on` |

**每个组件都必须有 focus-visible 态**，outline 2px `--accent` + offset 2px（现状已全局具备，保留）。

---

## 7. 布局与响应式

| 断点 | 侧栏 | 卡片网格 | 详情页 | 搜索栏 |
|---|---|---|---|---|
| ≥ 1400px | 展开 204px | 5 列（minmax 240px） | 海报 210px + 信息并排 | 输入 max 420px |
| 1100–1399px | 展开 204px | 4 列（实测 269px/列） | 海报 210px + 信息并排 | 输入 max 420px |
| 960–1099px | 自动收起 68px | 3 列（minmax 200px） | 海报 160px + 信息并排 | 输入 flex:1 |
| < 960px | 不支持（Tauri `minWidth: 960`） | — | — | — |

**gutter**：`--sp-3`（12px）横向 / `--sp-6`（24px）纵向。当前 `.vod-grid` 是 `gap: 24px 18px`，横向收到 12px 后同屏可多出半列。

**触控/点击热区下限 32×32**（桌面指针）。现状 `recent-chip__remove` 实测 **25×21px**，需扩到 32×32 并把 × 图标改到 12px。

---

## 8. 交互与动效

| 交互 | 触发 | 反馈 | 时长 | 缓动 | 可打断 |
|---|---|---|---|---|---|
| 卡片 hover | 指针进入 | 海报上浮 3px + 阴影加深 | 180ms | `--ease` | 是 |
| 骨架 shimmer | 列表加载中 | 灰块左右扫光 | 1400ms 循环 | linear | 是 |
| 聚合搜索进度 | 每站响应 | 进度条按 `ok/total` 推进 | 持续 | linear | 是 |
| 取消搜索 | 点「取消搜索」 | 停止扇出，保留已得结果，摘要条显示「已取消」 | 立即 | — | — |
| 失败抽屉展开 | 点「41 个站点未响应 ›」 | 高度 32→240px | 180ms | `--ease` | 是 |
| 站点菜单开合 | 点选择器 | 菜单淡入 + 上移 4px | 120ms | `--ease` | 是 |
| 侧栏收放 | 点底部按钮 | 宽度 204↔68 + 文字淡出 | 280ms | `--sidebar-ease` | 是 |
| 焦点环 | 键盘聚焦 | outline 2px `--accent` offset 2px | 即时 | — | — |
| 减弱动效 | 系统偏好 | 全部动画降到 0.01ms | — | — | — |

---

## 9. 验收清单

### 视觉
- [ ] 搜索结果滚动全程，视口内卡片封面已载数 = 视口内卡片数（现状 4 屏 pending 合计 29）
- [ ] 搜索结果页滚动全程 `scrollHeight` 波动 ≤ 4px（现状 129px）
- [ ] 首页 20 张卡片封面全部加载（现状已达标，需保持）
- [ ] 页面内不存在引用但未定义的 CSS 变量（`--panel-2` 已修）
- [ ] 字号只取自 8 阶阶梯；字重只有 400/500/600
- [ ] 圆角只取自 8/12/16/999 四档
- [ ] 直播分组不再产生横向溢出（chip 右边界 ≤ 视口宽）
- [ ] 详情页空态居中，左侧不留半屏空白

### 交互
- [ ] 聚合搜索期间出现「取消搜索」按钮，点击后停止扇出并保留已有结果
- [ ] 加载中显示骨架屏而非居中 spinner
- [ ] 站点选择器可搜索（101 个站点不再靠滚动）
- [ ] 所有可点元素 ≥ 32×32（`recent-chip__remove` 由 25×21 修正）
- [ ] 失败抽屉可展开，列出分组后的中文原因

### 内容
- [ ] 用户可见文案不含 `http(s)://` / `line N, column N` / 堆栈
- [ ] 失败计数在摘要条与抽屉标题中一致（当前 41 vs 5）
- [ ] 无占位文案（lorem / TODO）

### 可访问性
- [ ] 正文与辅助文字对比度 ≥ 4.5:1（`--faint` 提到 `#7b8699` 后达标）
- [ ] 徽标底上文字 ≥ 4.5:1（`--badge-on-accent` 替换白字）
- [ ] 键盘可完成：切换站点 → 搜索 → 打开详情 → 播放 → 返回
- [ ] 焦点环在 chip / 卡片 / 图标按钮上均可见
- [ ] `aria-live` 区域存在，搜索进度变化可被读屏播报

### 回归（不可破坏）
- [ ] `node tools/run_probes.mjs` 21 个探针全绿
- [ ] 探针依赖的 className 与文案不变：`.nav__item` `.vod-card` `.chip` `.episode` `.search-bar input.input` `select.select` `.source-picker` `.source-item` `.error-bar` `.spinner` `.page-head` `.detail-title` `.fav-item` `.player-about`
- [ ] `pnpm test` 298 项通过，`cargo test --lib` 78 项通过

---

## 10. 三方库引入评估

用户已授权引入三方库。逐项评估（体积按 gzip，参照项目首屏 69.53 kB 的现状）：

| 库 | 体积 | 解决什么 | 引入建议 |
|---|---|---|---|
| `cmdk` | ~8 kB | 命令面板：`Ctrl+K` 直达「搜索某片 / 切换站点 / 打开设置」，替代 101 站点下拉 | **推荐**。纯键盘入口，成本极低 |
| `sonner` | ~7 kB | Toast 队列：现 `.app-toast` 只能一条、4 秒、无关闭、无法堆叠 | **推荐**。同时补上 `aria-live` 播报 |
| `@radix-ui/react-*` | 单包 10–30 kB | Dialog / Popover / Tooltip / Tabs 的焦点陷阱、Esc 层级、方向键导航 | **部分推荐**。焦点陷阱（当前 SourcePicker 无焦点管理）是真缺，但需注意 4 个探针依赖 `.source-picker` 类名 |
| `@tanstack/react-virtual` | ~12 kB | 265 张卡片的虚拟滚动 | **不推荐**。当前 `content-visibility: auto` 已够，且虚拟滚动会破坏探针依赖的「DOM 里能看到全部 `.vod-card`」前提 |
| `tailwindcss` | ~0（运行时） | utility-first | **不推荐**。2955 行既有 CSS + 探针 className 契约，重写成本与回归风险远大于收益 |
| `class-variance-authority` | ~1.5 kB | 按钮/chip 变体收敛 | **可选**。当前变体靠手写 class 串，容易漏（`.btn--primary` / `.btn--ghost` / `.btn--danger` / `.btn--sm` 已有 4 个变体零散在多文件） |
| `lucide-react` | 已有 | 图标 | 已在用，继续用；`Empty` 的 `▤` 字符换成 `Inbox` |

**结论**：引入 `cmdk` + `sonner` 两个小库；Radix 按需只取 `Dialog`（给 SourcePicker / ConfirmDialog 补焦点陷阱）。不引 Tailwind、不引虚拟滚动、不引完整组件库（shadcn / MUI / AntD）—— 现有设计语言已经成型，替换成本大于收益。

---

## 11. 实施顺序（按「先止血、再治病」）

| 阶段 | 内容 | 触及文件 | 风险 |
|---|---|---|---|
| **S1 止血** | ① 卡片占位高度修正（`contain-intrinsic-size: auto 418px`）② 失败原因归类，原始报错只进日志 ③ 失败计数一致性 ④ `--faint` / `--badge-on-accent` 对比度 ⑤ `--panel-2` 补定义 | `styles.css`、`SearchPage.tsx`、`VodCard.tsx` | 低 |
| **S2 等待态** | 骨架屏、进度条、取消搜索、失败抽屉 | `SearchPage.tsx`、`AsyncBoundary.tsx`、新 `Skeleton.tsx` | 中（取消需后端支持中断） |
| **S3 控件统一** | 首页站点选择器换成可搜索的 `SiteSelect`；直播分组改侧栏式导航；热区扩到 32px | `HomePage.tsx`、`LivePage.tsx`、`SiteSelect.tsx` | 中（`select.select` 是 3 个探针的定位锚点，需保留隐藏原生 select 或同步改探针） |
| **S4 体系收口** | token 三层（颜色/字号/间距）、字号 8 阶、字重 3 档、圆角 4 档、`Inter` 声明移除 | `styles.css` | 中（全局重排，需截图回归） |
| **S5 增强** | `cmdk` 命令面板、`sonner` Toast、`Radix Dialog` 焦点陷阱、设置页目录 | 新增文件 | 低（增量） |

---

## 12. 待确认

| # | 缺什么 | 影响哪节 | 需要什么 |
|---|---|---|---|
| 1 | 是否接受把首页站点选择器从原生 `<select>` 换成自研可搜索下拉 | S3、组件清单 | 探针 `probe_home_site` / `probe_home_video` / `probe_py_framework` 依赖 `select.select` 定位，替换需同步改这 3 个探针或保留一个隐藏原生 select 兼容 |
| 2 | 「取消搜索」是否需要后端中断扇出 | S2、S5 | 现在 Rust 侧是 `timeoutMs` 一次性等待，无中途取消通道；纯前端取消只能丢弃后续结果，源站请求仍会跑完 |
| 3 | 卡片虚拟化是否最终接受 | 组件清单 | 265 张卡片 DOM 全量保留（探针前提）vs 真虚拟化，只能二选一 |
