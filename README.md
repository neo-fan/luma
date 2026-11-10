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
corepack pnpm tauri dev                    # 开发
corepack pnpm tauri build --bundles nsis   # 安装包
```

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

## 安装与 SmartScreen

安装包未做代码签名，首次运行 Windows 可能弹出 SmartScreen：

1. 点击「更多信息」；
2. 点击「仍要运行」。

正式分发需要 OV/EV 代码签名证书。

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

## 已知限制

- 第三方 **Android dex jar** 在 Win x64 无法加载（jar 内是 `classes.dex`，依赖 ART / okhttp / QuickJS 等）。这类源会快速失败并给出原因；jar 运行时只对纯 class jar 与仓库内自编模板 jar 作保证。
- T-31（`tvbox://` 协议关联、JumpList、全屏勿扰）未实现。
- `mpv` 不随安装包分发（体积考虑），需手动放入 `sidecars/mpv/` 或按需下载。
- 公开源失效频繁，属正常现象；自动换源与源级原因提示是必需能力。
