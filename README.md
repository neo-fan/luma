# Luma

Windows 11 x64 桌面端的 **TVBox 配置兼容客户端**（空壳播放框架）。产品名 **Luma**，程序标识、可执行文件、数据目录、数据库、环境变量与图标已全部统一为 Luma，不再保留 `tvbox-desktop` 作为产品名；从旧版升级会自动迁移已有的配置 / 收藏 / 历史（见「从旧版升级」）。软件本身不内置、不硬编码任何配置地址、影视源、直播源或 API Key；所有内容由用户自行导入的 TVBox 配置（`api.json` / `box.json` 及常见变体）提供。

## 免责声明

- 本项目只是播放框架，不提供、不托管、不分发任何音视频内容或源站地址。
- 用户导入的配置、脚本、jar 均为第三方内容，其合法性、安全性与可用性由用户自行判断并承担全部责任。
- 请遵守所在地法律法规与源站服务条款；因使用第三方源产生的任何纠纷与本项目无关。
- 项目不收集遥测、不上传配置、不内置账号体系。

## 功能

- 配置导入：URL / 本地文件 / 内联文本，支持 JSONC、图片种（base64 内嵌）、gzip/base64 包装等常见方言。
- 四类源：CMS（`api.php/provide/vod`）、Python（`.py`）、JavaScript（`.js`，独立 qjs-runner sidecar）、Java（`csp_*` + jar，JVM sidecar）。
- 聚合搜索：一次关键词覆盖当前配置的全部站点，按站点分组返回，失败源给出可读原因。
- 播放：ArtPlayer + hls.js；清晰度 / 倍速 / 画中画 / 快捷键等完整控件；同一剧集多线路自动切换；HLS 卡死 12 秒看门狗；跨站自动换源。
- 详情与选源：手动换源（一次聚合列出其它站点的同名影片，可选 20/35 秒检索）、任意线路/剧集直达、剧集筛选与正倒序、继续播放（读 SQLite 历史）、收藏与简介展开。
- 页面缓存：详情 / 播放 / 首页 / 分类 / 搜索 / 直播读结果按配置作用域做内存缓存（TTL + LRU + 并发请求去重）；播放页返回详情不再重拉播放列表，线路、筛选、页码、搜索结果与滚动位置一并保留；详情页「↻ 刷新」可强制更新。
- 界面与性能：现代简约暗色主题（蓝紫强调色、渐变主按钮、离屏卡片跳过渲染、遵循系统「减弱动效」）；**播放页按需加载**，首屏 JS 从 289.6 kB gzip 降到 60.1 kB（-79%），ArtPlayer / hls.js 只在打开播放页时下载并拆为独立可缓存块。
- 第 4 级嗅探：前三级都拿不到直链时，用隔离的隐藏 WebView2 加载播放页并拦截网络请求取真实地址（该窗口不在 capabilities 授权列表内，零 command 权限）。
- mpv 兜底：WebView2 无法解码（如 HEVC）时自动交给随包 mpv；找不到 `mpv.exe` 时退回外部播放器提示。
- 直播：m3u/m3u8 解析，代理内重写相对分片。

## 环境要求

| 用途 | 要求 |
|---|---|
| 运行 | Windows 11 x64；WebView2 常青版（系统自带，不随包分发） |
| 开发 | Node 20+ / pnpm；Rust stable ≥ 1.77.2（`x86_64-pc-windows-msvc`）；VS2022 Build Tools + Win11 SDK |
| JVM 源 | JDK 17（编译、运行、`jlink` 统一 17；不探测、不兼容 JDK 8） |
| 可选 | mpv（`sidecars/mpv/mpv.exe`），用于解码兜底 |

## 构建

```powershell
corepack pnpm install
corepack pnpm tauri dev                     # 开发
python tools/make_portable.py               # 绿色版：release/portable + zip
python tools/make_portable.py --with-mpv    # 连 mpv 一起打（体积 +40MB）
python tools/build_icons.py                 # 重生成全套应用图标（需 Pillow）
node tools/bundle_report.mjs               # 构建产物体积 / gzip 报告
```

## 品牌资源

产品名 **Luma**，图标是深墨圆角底 + 细圆环 + 蓝紫渐变播放三角。`tools/build_icons.py` 从同一套几何常量生成 `src-tauri/icons/` 下的 ICO（16~256）与各尺寸 PNG、以及前端用的 `public/icon.svg`；修改品牌色时同步 `src/styles.css` 的 `--accent` / `--accent-2`。`tauri.conf.json` 的 `identifier` 为 `dev.luma.desktop`；改名前 `dev.tvbox.desktop` 的数据由一次性自动迁移接管（见「从旧版升级」），不需要手工复制文件。

产物：

- `release/portable/Luma/` —— 解压即用的文件夹；
- `release/Luma-0.1.0-portable.zip` —— 分发包（约 41MB，SQLite bundled 后需重测体积）。

不需要安装程序；整个文件夹可以放在任意目录、U 盘或移动硬盘。

首次构建前如需重建运行时（JRE / Python embeddable / sidecar 暂存）：

```powershell
python sidecars/java/build.py      # 桩类 + SpiderRunner + 模板 jar（需 JDK 17）
python tools/prepare_runtime.py    # jlink JRE + Python embeddable + externalBin staging
```

开发期必须显式指定 JDK 17，否则会落到系统默认版本：

```powershell
$env:LUMA_JAVA = "D:\software\java\oracle-jdk-17\bin\java.exe"
```

### 运行期环境变量

运行期变量统一为 `LUMA_*` 前缀；旧的 `TVBOX_*` 同名变量仍会被读取，方便旧快捷方式与脚本过渡。

| 变量 | 用途 |
|---|---|
| `LUMA_PYTHON` | 覆盖 Python 解释器（缺省用随包 `python-embed`，再缺省 `python`） |
| `LUMA_JAVA` | 覆盖 java 可执行文件（缺省 `JAVA_HOME` 或 `java`） |
| `LUMA_JVM_RUNNER` | 覆盖 `runner.jar` 路径 |
| `LUMA_MPV` | 覆盖 `mpv.exe` 路径 |
| `LUMA_PROXY_PORT` | 本地反代端口，默认 9978 |
| `LUMA_DATA_DIR` | 覆盖数据目录（默认便携 `data/`，否则 `%APPDATA%\Luma`） |
| `LUMA_RESOURCE_DIR` | 宿主发布给 sidecar 的资源目录，通常无需手工设置 |
| `LUMA_PROXY_ALLOW_LOCAL` | `1` 时允许反代访问 `127.0.0.1`（仅本地联调） |
| `LUMA_SELFCHECK` | `1` 时启动自检并写 `data/selfcheck.log` |

## 使用

1. 启动后进入「设置」，粘贴配置地址或选择本地配置文件，点击导入。
2. 首页 / 分类 / 搜索浏览，点击影片进入详情，选择线路与剧集播放。
3. 播放失败时的顺序：同片其它线路 → 其它站点 → 第 4 级嗅探 → mpv / 外部播放器。搜索页会列出未响应源的原因。
4. 直播页可导入 m3u 源观看。

## 运行（便携版）

1. 解压 `Luma-0.1.0-portable.zip` 到任意目录；
2. 双击 `Luma.exe`。

配置、收藏、历史都写在 **exe 同级 `data/luma.db`**（单个 SQLite 文件，运行时另有 `-wal` / `-shm` 辅助文件）；`data/` 存在即自动进入便携模式，不会写 `%APPDATA%`。删除整个文件夹即完成卸载。

未签名的 exe 首次运行可能触发 SmartScreen：点击「更多信息」→「仍要运行」。正式分发需要 OV/EV 代码签名证书。

便携版布局：

```text
Luma/
  Luma.exe
  sidecars/
    py/               适配层源码
    python-embed/     嵌入式 Python 3.11 + 第三方包
    jre/              jlink 裁剪的 JDK 17
    java/runner.jar   JVM spider 桥
    mpv/              可选，自行放入
  data/
    luma.db           配置 / 收藏 / 历史（SQLite）
```

数据层说明：配置快照（导入原件 + 运行派生）、active 配置、收藏与历史都在同一个事务型数据库里；写操作先提交事务再刷新界面缓存。首次启动会把旧版 JSON 数据自动导入 `luma.db`，旧文件保留在 `data/` 作为备份、不再读取。开发模式下数据库位于 `%APPDATA%\Luma\luma.db`。

## 从旧版升级（TVBox Desktop → Luma）

改名后程序标识 `dev.tvbox.desktop` → `dev.luma.desktop`，数据目录 `%APPDATA%\tvbox-desktop` → `%APPDATA%\Luma`，数据库 `tvbox.db` → `luma.db`。**首次启动 Luma 会自动迁移，不需要手工复制**：

- 开发 / 安装版：检测 `%APPDATA%\tvbox-desktop\tvbox.db`；便携版：先检测新包 `data/` 里的旧 `tvbox.db`，也兼容上述 `%APPDATA%` 旧目录。
- 用 SQLite `VACUUM INTO` 取一致性快照，包含 WAL 中已提交、尚未 checkpoint 的写入；不会裸复制 db + wal。
- 旧 JSON 备份（`configs/`、`active.json`、`favorites.json`、`history.json`）一并复制到新目录，仅作留存。
- 旧目录与旧文件**不删除、不改写**，回滚只需重新打开旧版；迁移只在新 `luma.db` 不存在时执行一次，误删后重启会自动再次恢复；迁移失败只写日志、不阻断启动。

升级前请先退出旧版进程：快照是启动瞬间的状态，旧版之后写入的数据不会同步到 Luma。便携版用户也可以把旧文件夹的 `data/` 直接覆盖到新包 `data/`，效果相同。

WebView2 的站点缓存 key 由 `tvbox:sites:v1` 换成 `luma:sites:v1`，旧 key 仍会回读，且启动时会用 Rust 侧的 active 配置重新对齐，缓存换位置不影响使用。

## 测试

```powershell
python tests/e2e/p0.py     # P0 基线
python tests/e2e/p1.py     # P1 子进程运行时
python tests/e2e/p2.py     # P2 jar / JVM 运行时
python tests/e2e/p3.py     # P3 嗅探 / mpv / 打包
python tests/e2e/parse_check.py  # 解析池与配置字段（离线，无需窗口）
corepack pnpm test         # 前端单测
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

阶段脚本采用累积断言：未交付能力标 `N/A`（不计 PASS、不计 FAIL），`FAIL = 0` 即通过。

## 支持范围

| 源类型 | 状态 | 说明 |
|---|---|---|
| CMS 采集（`api.php/provide/vod`） | ✅ 支持 | 主流配置的主体，直链 m3u8 |
| Python（TVBox `base.spider` 框架） | ✅ 支持 | 含直链型与 `proxy?do=py` 型 |
| `parses[]` 通用解析池 | ✅ 支持 | type 0 嗅探 / type 1 JSON 接口 / type 4 并行竞速 |
| 配置级 `headers[]` | ✅ 支持 | 按 host 注入 UA/Referer，防盗链 CDN 必需 |
| 直播（`lives`） | ✅ 支持 | m3u8 经本地代理重写后播放 |
| jar（`csp_*` / `spider` 全局 jar） | ⚠️ 仅纯 class jar | 见下方说明 |
| js（drpy2） | ⚠️ 不支持 | 需要 ES 模块加载器与 cheerio |

本项目**以 CMS + Python 两类源为交付目标**。实测用户配置 101 个站点中，这两类占 67 个，且覆盖了实际可播的绝大部分内容。

### 为什么 jar 源基本不可用

社区配置里的 jar 绝大多数是 **Android dex jar**，把它跑起来在 Windows x64 上不是「实现代价大」，而是走不通：

- jar 内只有 `classes.dex`，而它继承的 `com.github.catvod.crawler.Spider` **不在 jar 里**（属于 Android 客户端本体）；
- 还依赖 ART、OkHttp、gson、NanoHTTPD、QuickJS binding 与整套 `android.util.*`，桩类无法补全；
- 这些站点的差异全在 jar 内部的 XPath 规则引擎里，无法绕开。

所以 jar 源会**快速失败并给出原因**，不会拖慢搜索。纯 class jar 仍可正常加载，行为由 `SpiderRunner` 反射分发。

## 已知限制

- py 源若返回 TVBox 本地代理地址（`127.0.0.1:9978/proxy?do=py&…`），宿主已实现该路由并转发给 `Spider.proxy()`；但返回自有本地服务地址（如 `127.0.0.1:10010`）的源仍不可用。
- `parses[]` 只实现 type 0（网页嗅探）、type 1（JSON 接口）与 type 4（并行竞速）。type 2/3 依赖 jar 反射（`com.github.catvod.parser.Json*`），配置里只有这两类解析器时会直接返回「不支持」而不是卡住。
- 公开的 jx 解析接口存活期普遍很短，解析池失败是常态；失败会保留原地址，由内置嗅探兜底。
- T-31（`tvbox://` 协议关联、JumpList、全屏勿扰）未实现。
- `mpv` 默认不随 zip 分发（单文件约 117MB），需要时放入 `sidecars/mpv/`，或用 `--with-mpv` 重新打包。
- 公开源失效频繁，属正常现象；自动换源与源级原因提示是必需能力。
