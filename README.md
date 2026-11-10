# TVBox Desktop

Windows 11 x64 桌面端的 **TVBox 配置兼容客户端**（空壳播放框架）。软件本身不内置、不硬编码任何配置地址、影视源、直播源或 API Key；所有内容由用户自行导入的 TVBox 配置（`api.json` / `box.json` 及常见变体）提供。

## 免责声明

- 本项目只是播放框架，不提供、不托管、不分发任何音视频内容或源站地址。
- 用户导入的配置、脚本、jar 均为第三方内容，其合法性、安全性与可用性由用户自行判断并承担全部责任。
- 请遵守所在地法律法规与源站服务条款；因使用第三方源产生的任何纠纷与本项目无关。
- 项目不收集遥测、不上传配置、不内置账号体系。

## 功能

- 配置导入：URL / 本地文件 / 内联文本，支持 JSONC、图片种（base64 内嵌）、gzip/base64 包装等常见方言。
- 四类源：CMS（`api.php/provide/vod`）、Python（`.py`）、JavaScript（`.js`，独立 qjs-runner sidecar）、Java（`csp_*` + jar，JVM sidecar）。
- 聚合搜索：一次关键词覆盖当前配置的全部站点，按站点分组返回，失败源给出可读原因。
- 播放：hls.js / mpegts.js 优先；同一剧集多线路自动切换；HLS 卡死 12 秒看门狗；跨站自动换源。
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
```

产物：

- `release/portable/TVBox Desktop/` —— 解压即用的文件夹；
- `release/TVBox-Desktop-0.1.0-portable.zip` —— 分发包（约 41MB）。

不需要安装程序；整个文件夹可以放在任意目录、U 盘或移动硬盘。

首次构建前如需重建运行时（JRE / Python embeddable / sidecar 暂存）：

```powershell
python sidecars/java/build.py      # 桩类 + SpiderRunner + 模板 jar（需 JDK 17）
python tools/prepare_runtime.py    # jlink JRE + Python embeddable + externalBin staging
```

开发期必须显式指定 JDK 17，否则会落到系统默认版本：

```powershell
$env:TVBOX_JAVA = "D:\software\java\oracle-jdk-17\bin\java.exe"
```

### 运行期环境变量

| 变量 | 用途 |
|---|---|
| `TVBOX_PYTHON` | 覆盖 Python 解释器（缺省用随包 `python-embed`，再缺省 `python`） |
| `TVBOX_JAVA` | 覆盖 java 可执行文件（缺省 `JAVA_HOME` 或 `java`） |
| `TVBOX_JVM_RUNNER` | 覆盖 `runner.jar` 路径 |
| `TVBOX_MPV` | 覆盖 `mpv.exe` 路径 |
| `TVBOX_PROXY_PORT` | 本地反代端口，默认 9978 |

## 使用

1. 启动后进入「设置」，粘贴配置地址或选择本地配置文件，点击导入。
2. 首页 / 分类 / 搜索浏览，点击影片进入详情，选择线路与剧集播放。
3. 播放失败时的顺序：同片其它线路 → 其它站点 → 第 4 级嗅探 → mpv / 外部播放器。搜索页会列出未响应源的原因。
4. 直播页可导入 m3u 源观看。

## 运行（便携版）

1. 解压 `TVBox-Desktop-0.1.0-portable.zip` 到任意目录；
2. 双击 `TVBox Desktop.exe`。

配置、收藏、历史都写在 **exe 同级的 `data/`** 目录；`data/` 存在即自动进入便携模式，不会写 `%APPDATA%`。删除整个文件夹即完成卸载。

未签名的 exe 首次运行可能触发 SmartScreen：点击「更多信息」→「仍要运行」。正式分发需要 OV/EV 代码签名证书。

便携版布局：

```text
TVBox Desktop/
  TVBox Desktop.exe
  sidecars/
    py/               适配层源码
    python-embed/     嵌入式 Python 3.11 + 第三方包
    jre/              jlink 裁剪的 JDK 17
    java/runner.jar   JVM spider 桥
    mpv/              可选，自行放入
  data/               配置 / 收藏 / 历史
```

## 测试

```powershell
python tests/e2e/p0.py     # P0 基线
python tests/e2e/p1.py     # P1 子进程运行时
python tests/e2e/p2.py     # P2 jar / JVM 运行时
python tests/e2e/p3.py     # P3 嗅探 / mpv / 打包
corepack pnpm test         # 前端单测
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

阶段脚本采用累积断言：未交付能力标 `N/A`（不计 PASS、不计 FAIL），`FAIL = 0` 即通过。

## 支持范围

| 源类型 | 状态 | 说明 |
|---|---|---|
| CMS 采集（`api.php/provide/vod`） | ✅ 支持 | 主流配置的主体，直链 m3u8 |
| Python（TVBox `base.spider` 框架） | ✅ 支持 | 含直链型与 `proxy?do=py` 型 |
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
- T-31（`tvbox://` 协议关联、JumpList、全屏勿扰）未实现。
- `mpv` 默认不随 zip 分发（单文件约 117MB），需要时放入 `sidecars/mpv/`，或用 `--with-mpv` 重新打包。
- 公开源失效频繁，属正常现象；自动换源与源级原因提示是必需能力。
