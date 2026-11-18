# TVBox / FongMi JS 源支持机制与随包资源交付说明

> 适用对象：Luma 的 QuickJS ESM 模块加载链路（兼容 TVBox / FongMi JS 源）。
> 资源基线：上游仓库 `cluntop/tvbox` 固定提交 `a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8`。
> 编码约定：本文件 UTF-8 无 BOM、LF 换行。

---

## 1. TVBox / FongMi 的 JS 源支持机制

### 1.1 运行时与求值方式

FongMi/TV 的 JS 爬虫引擎使用 **QuickJS**，源码不是当普通 classic script `eval`，而是通过
`QuickJSContext.evaluateModule()` 走 **ES module** 求值，并配一个**自定义 ModuleLoader** 负责把
`import` 说明符解析成实际源码。

本仓库的 `sidecars/qjs-runner/src/main.rs` 用 `rquickjs` 做等价实现：`Module::declare(...)`
声明模块 → `eval()` 求值 → **必须排空 pending job 队列**（`while ctx.execute_pending_job() {}`）
并 `finish()` 求值 promise，否则带 `import` 的模块链接不完整，`default` 导出尚未初始化就会
在后续报出难以定位的 TDZ 错误。求值完成后把模块 namespace 挂到 `globalThis.__luma_exports`
供导出发现使用。脚本形态由 `looks_like_esm()` 自动判定（`export default` / `export function` /
`export{` / 文件头 `import`），也可用 `script_kind` 显式指定 `auto | classic | module`。

### 1.2 `assets://js/lib/*` 是宿主内置资源，不是服务器路径

`assets://` 是宿主给 ModuleLoader 约定的**虚拟 scheme**，不是 `http(s)://`，也不指向任何站点的
服务器目录。它映射到客户端随包携带的本地目录：

```
sidecars/qjs-assets/js/lib/     （经 `bundle.resources` 打包后为 <APP_DIR>/sidecars/qjs-assets/js/lib/）
```

也就是说 `import $ from "assets://js/lib/cheerio.min.js"` 取的是**客户端内置的 JS 依赖文件**，
不是对 `api` 站点 `/js/lib/cheerio.min.js` 发起网络请求。Resolver 会把 `assets://` / `asset:`
统一归一化为 `asset:<basename>`，Loader 再到 `assets_dir/js/lib/<basename>` 读文件。

### 1.3 相对 import 按 importer URL 归一化

drpy2 等引擎包大量使用 `./cheerio.min.js`、`./lib/crypto-js.js` 这类相对说明符。解析规则按
**importer 的 URL**（模块名 / `api` 字段）为基准归一化：

1. `assets://` / `asset:` → 取 basename，映射为 `asset:<basename>`（命中内置资源）；
2. `http://` / `https://` / `net:` → 映射为 `net:<url>`，由 Loader 走 HTTP 拉取；
3. 相对路径（`./`、`../` 开头或裸文件名）→ **先取 basename 查内置 `BUNDLED` 清单**，命中即
   `asset:<basename>`（避免上游 404，见第 3 节）；未命中时以 importer URL 去掉最后一段作为目录，
   拼成 `net:<dir>/<relative>`；importer 不是 http 时退化为 `asset:<basename>`。

`BUNDLED` 清单与 `BUNDLED` 常量一致，共 8 个文件，见第 2 节表格。

### 1.4 四种导出约定

TVBox 生态里 JS 源导出「爬虫对象」的写法并不统一，客户端把下列四种都收集为候选，派发时取
第一个暴露目标方法的对象：

| # | 约定 | 典型写法 | 说明 |
|---|------|----------|------|
| 1 | **全局 `spider` / `Spider` 类** | `var spider = {...}`；`class Spider {...}` | classic 脚本最常见；`Spider` 类会 `new Spider(ext)` 实例化 |
| 2 | **`export default` 对象** | `export default { home, category, ... }` | drpy2 / ESM 源主流 |
| 3 | **`export function __jsEvalReturn`** | `export function __jsEvalReturn(){ return {...} }` | 调用该函数取返回对象 |
| 4 | **`__JS_SPIDER__` 全局** | `__JS_SPIDER__ = {...}` | jsjiami 混淆源（如 `live2vod.js`）读写该宿主全局 |

候选池顺序为：模块 `default`（非函数）→ `__jsEvalReturn()` 结果 → 模块 namespace 本身 →
`__JS_SPIDER__` → `spider` → `new Spider(ext)` → `globalThis`。对每个候选若存在 `init` 且未
标记 `__luma_inited`，会先以 `ext` 调用一次 `init(ext)`。

### 1.5 短名 / 长名方法映射

TVBox 标准方法名（长名）与 JS0 / drpy2 源里常用的短名并存。派发时**先按长名找，再按短名找**：

| 标准（长）名 | 短名 | 标准（长）名 | 短名 |
|--------------|------|--------------|------|
| `homeContent` | `home` | `detailContent` | `detail` |
| `homeVideoContent` | `homeVod` | `searchContent` | `search` |
| `categoryContent` | `category` | `playerContent` | `play` |
| `liveContent` | `live` | | |

`detailContent` / `playerContent` 的首参若为数组会先拆成单元素（TVBox 传 `[id]`）。方法返回值
统一 `await Promise.resolve(...)` 后 `JSON.stringify` 回传给 Rust 侧。

### 1.6 `req(url, options)`

宿主注入的 `req(url, options)` 返回 `{ code, content, headers }`：

- `code`：HTTP 状态码；失败时为 `0` 并带 `error` 字段；
- `content`：响应体字符串；
- `headers`：响应头对象。

`options` 支持 `method`（`GET` / `POST` / `PUT` / `HEAD` / `DELETE`，默认 `GET`）、`headers`
（对象，会与站点级 `headers` 合并，调用方优先）、`body`（字符串或对象，对象自动
`JSON.stringify`）、`timeout`（毫秒，钳制在 1–30000，默认 10000）。仅允许 `http://` /
`https://`；其它 scheme 直接返回 `code: 0` + `scheme not allowed`。`req` 返回 Promise，便于
源里 `await req(...)`。此外还注入 `local`（`get/set/delete`，按 `site_key` 前缀隔离）、
`md5X`（依赖预置的 `CryptoJS`）、`console`；**不注入 `require` / `process` / `fetch`**，保持沙箱
契约。

---

## 2. 随包 JS 依赖资源清单

数据源：`sidecars/qjs-assets/manifest.json`（入库源码资源，`tools/prepare_runtime.py`
的 `step_qjs_assets()` 只做只读校验，不联网下载、不可由脚本重建）。8 个文件合计
**929,905 B（约 0.89 MB）**。

| 本地文件名（js/lib/） | 上游路径 | 字节数 | SHA256（前 16 位） | 用途 |
|------------------------|----------|-------:|--------------------|------|
| `cheerio.min.js` | `lib/cheerio.min.js` | 356588 | `b4a69e4925383dd1` | drpy2 `assets://` 默认导入；`$.html` / jinja2 |
| `crypto-js.js` | `lib/crypto-js.js` | 204310 | `731c9606953ddedd` | drpy2 与聚合短剧的 CryptoJS 副作用导入 |
| `node-rsa.js` | `lib/node-rsa.js` | 167481 | `b2e1d9c402ce06c1` | drpy2 `./node-rsa.js`，RSA / JSEncrypt 全局 |
| `pako.min.js` | `lib/pako.min.js` | 46859 | `7b7a3b8db4d7b658` | drpy2 `./pako.min.js`，inflate / deflate |
| `gbk.js` | `lib/gbk.js` | 56313 | `28097cea4538c346` | drpy2 `./gbk.js`，`export gbkTool` |
| `json5.js` | `lib/json5.js` | 60431 | `1b3d54f76b910664` | drpy2 `./json5.js` 副作用导入 |
| `jinja.js` | `lib/jinja.js` | 22706 | `6cf1781f0c322062` | drpy2 `./jinja.js` 副作用导入 |
| `template.js` | `js/template.js` | 15217 | `60bc13ee04302db0` | drpy2 `./template.js`（仓库 `lib/` 下无此文件，需重写） |

> 表中的「上游路径」是**实际抓到该文件的仓库路径**，与 drpy2 源码里写的 `import` 说明符
> 并不一致（见第 3 节），所以不能照抄说明符去拼下载 URL。

### 2.1 可下载 URL 前缀

```
https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8/
```

上游清单里 8 个英文文件路径可直接拼接，例如
`.../a08e4fe8.../lib/cheerio.min.js`。**中文文件名必须 percent-encode**（UTF-8 字节逐字节
`%XX`），例如：

| 中文文件名 | percent-encode 后 |
|------------|-------------------|
| `荐片.js` | `%E8%8D%90%E7%89%87.js` |
| `金牌影视.js` | `%E9%87%91%E7%89%8C%E5%BD%B1%E8%A7%86.js` |
| `聚合短剧.js` | `%E8%81%9A%E5%90%88%E7%9F%AD%E5%89%A7.js` |

拼好的示例：
`https://raw.githubusercontent.com/cluntop/tvbox/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8/%E8%8D%90%E7%89%87.js`

### 2.2 整仓 zip

```
https://codeload.github.com/cluntop/tvbox/zip/a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8
```

资源缺失时请**重新运行资源下载脚本**，按上面固定 commit 把 8 个文件抓回
`sidecars/qjs-assets/js/lib/`，并核对 `sidecars/qjs-assets/manifest.json` 的字节数与 SHA256；
`python tools/prepare_runtime.py --check` 会做同样的只读体检。

---

## 3. 两个实测坑

### 3.1 `lib/template.js` 与 `js/lib/crypto-js.js` 均 404，需别名表

该 commit 下，drpy2 源码里的 `import` 说明符指向 `lib/template.js` 与 `js/lib/crypto-js.js`
时**都返回 404**：上游仓库既没有 `js/lib/` 这一层目录，也没有 `lib/template.js`（`template.js`
实际在 `js/template.js`）。因此不能按说明符原样去服务器取文件。

解决办法是**别名表按 basename 映射**：把说明符的 basename（`template.js`、`crypto-js.js`）
映射到随包内置的 `js/lib/<basename>`。客户端 `normalize_module()` 正是这么做的——相对说明符
先取 basename 查 `BUNDLED` 清单，命中即 `asset:<basename>`，从内置资源加载，绕开 404。
`manifest.json` 的 `upstream` 列记录的是真实抓到的仓库路径，与说明符不同，不要混淆。

### 3.2 `./js/drpy2.js`（KTV 站点的 ext）在仓库里不存在

KTV 站点把 `ext` 指向 `./js/drpy2.js`，但该规则文件在上游仓库里**并不存在**。结果是该源
能加载 `drpy2.min.js` 引擎本体，却拿不到规则文件，首页只返回空 `class`（见第 5 节）。这是
上游配置缺陷，不是客户端模块加载失败；需要站点侧修正 `ext`，或由宿主提供等价规则文件。

---

## 4. 客户端实现口径

### 4.1 `sidecars/qjs-runner/src/main.rs`

| 环节 | 实现 |
|------|------|
| **Resolver / Loader** | `TvResolver::resolve` 调 `normalize_module()` 把说明符归一化为 `asset:<file>` / `net:<url>`；`TvLoader::load` 用 `load_source()` 从 `assets_dir/js/lib/` 读本地文件或 `ureq` 走 HTTP（10s 超时） |
| **UMD 包装** | 非 ESM 的 UMD 包（无 `export`）被包成 `(function(){...}).call(globalThis); export default (globalThis.<全局名> || {});`，使 `import cheerio from ...` 之类可用；全局名由 `umd_global()` 给出：`crypto-js.js→CryptoJS`、`node-rsa.js→JSEncrypt`、`pako.min.js→pako`、`json5.js→JSON5`、`jinja.js→jinja`。**不做全量预加载**：只有脚本真的 import 时才由 Loader 加载（每帧 eval 500 KB UMD 纯属浪费） |
| **宿主注入 API** | `install_host()` 注入 `req`、`local`、`md5X`、`console`、`__luma_ext / __luma_site / __luma_api`，并 `eval` `HOST_JS` 垫片；`md5X` 走 `md-5` crate（不为了一个 md5 去 eval 204 KB crypto-js）；垫片还预置 `__JS_SPIDER__ = undefined` 和一组惰性 STUBS（`pdfh/pdfa/pd/jsp/print/log/VERSION/RKEY/OCR_API/OcrApi/getProxyUrl/rule/os/initEnv/_ENV/joinUrl`），让 drpy2 顶层代码在严格 ESM 作用域里能求值完；**不定义 `require/process/fetch`** |
| **ds 协议注入符号** | 新版 ds 规则会引用一批 drpy-NODE 服务端注入的全局（捆绑的 drpy2 引擎不定义，缺失即 ReferenceError 整站中断）。`HOST_JS` 对**语义确定、可由 `req` 派生**的给真实现：`batchFetch(list)`（数组逐项串行走 `req`，返回同形 `{code,content,headers}` 数组）、`reqs`（委托 `req`）、`toBeijingTime`、`jsonToCookie`、`cookieToJson`；对**依赖 Node/Java 桥、无法忠实复刻**的（`executeParse/rsaX/aesX/desX/js2Proxy/cachedRequest/JSProxyStream/JSFile/AIS/XMLHttpRequest/jsoup/pq/pj/pjfa/pjfh/pdfl`）给**一次性 `console.warn` 的空兜底**，使规则降级出空结果而非中断。**限制**：这些真·ds 服务端规则若要完整功能（并发代理、原生加解密桥），仍受 QuickJS 宿主能力所限，垫片只保证「不整站崩 + 可诊断」 |
| **导出发现** | `BOOTSTRAP_JS` 收集第 1.4 节的四类候选到 `globalThis.__luma_candidates`，并对有 `init` 的候选调用 `init(ext)` 一次 |
| **短名映射 / 派发** | `CALL_JS` 的 `MAP` 实现第 1.5 节长名→短名回退；`detailContent` / `playerContent` 拆数组首参；结果 `await` + `JSON.stringify` |
| **墙钟超时** | `DEFAULT_TIMEOUT_MS = 15000`；`runtime.set_interrupt_handler` 以 `Instant::now() + timeout` 为硬截止中断解释器，宿主另会 kill 整个进程树。超时返回 `SITE_TIMEOUT`，其它异常返回 `SPIDER_CRASH` |

### 4.2 Rust 侧传参字段

`src-tauri/src/domain/spider/quickjs.rs` 向 qjs-runner 写一行 JSON 帧，字段口径固定为：

| 字段 | 含义 |
|------|------|
| `assets_dir` | `sidecars/qjs-assets` 的绝对路径（`resolve_assets_dir`） |
| `api` | 脚本原始 URL，作为相对模块 import 的基准 |
| `headers` | 站点级请求头，合并进每次 `req` 调用 |
| `site_key` | 站点标识，`local` 存储按它加前缀隔离 |

同帧还带 `id / source / method / args / ext / timeout_ms / script_kind`。qjs-runner 侧
`Request` 结构体已按上述字段名定义（`#[serde(default)]`，缺字段不报错）。

### 4.3 依赖选择（能用库就不手搓）

| 需求 | 依赖 | 为什么不自写 |
|------|------|--------------|
| HTTP | `ureq`，**`default-features = true`**（含 `tls` / `gzip` / `charset`） | 只列 `features` 会关掉 default；少了 `gzip` 压缩响应会解成乱码，少了 `charset` GBK 页面按 UTF-8 解坏 |
| 编码转换 | `encoding_rs` | `req(..., {encoding:"gbk"})` 显式覆盖；GBK / GB18030 / Big5 映射表不自己维护 |
| 二进制 | `base64` | `req(..., {buffer:2})` 按 TVBox 约定返回 base64 |
| URL / 模块说明符 | `url` + `percent-encoding` | `Url::join` 正确处理 `../`、query、中文 percent-encoding；手写拼接这三处都会错 |
| md5 | `md-5` | 一个 helper 不值得 eval 204 KB crypto-js |
| JS 引擎 / ES module | `rquickjs`（`loader` feature） | 引擎与 `Resolver` / `Loader` trait 由库提供，我们只实现两个 trait |
| JS 侧 HTML / 加密 / 压缩 | 随包 `cheerio.min.js` / `crypto-js.js` / `node-rsa.js` / `pako.min.js` | drpy2 的上游依赖，原样携带，不重写 |
| 进程守护 | `tokio` + `windows` Job Object（主 crate） | 不在 sidecar 里另造进程管理 |

刻意保留为“薄适配”的部分：`HOST_JS` 垫片、导出发现、长短名映射 —— 它们只做 TVBox 语义翻译，
没有通用库可替代；但一旦涉及协议/编码/解析，就交给上面的库。

### 4.4 随包落点（与 `tauri build` 的 `bundle.resources` / `bundle.externalBin` 对应）

`src-tauri` 侧 `resolve_runner()` 的查找顺序为：`QJS_RUNNER` 环境变量 → **exe 同目录** →
编译期 `source_root` 下 `sidecars/qjs-runner/target/{release,debug}`。安装版分发到别的机器后
编译期绝对路径失效，故 `tauri build` 经 `bundle.externalBin` 把可执行文件落到 exe 同目录（首选命中点）：

```
<APP_DIR>/qjs-runner.exe                         # exe 同目录，运行时首选命中点（bundle.externalBin 落地）
```

候选源优先级：`src-tauri/binaries/qjs-runner-x86_64-pc-windows-msvc.exe`（由
`prepare_runtime.py` 的 `stage()` 产出）→ `sidecars/qjs-runner/target/release/qjs-runner.exe`
→ `target/debug/qjs-runner.exe`；三者都不存在只 warn、不中断打包。资源目录整体复制到
`<APP_DIR>/sidecars/qjs-assets/`。`report()` 会把 `sidecars/qjs-assets`、
`sidecars/qjs-runner`、`qjs-runner.exe` 列入体积汇总。

`sidecars/qjs-assets/js/lib/` 里除 8 个依赖（cheerio / crypto-js / node-rsa / pako / gbk /
json5 / jinja / template）外，还有 **`drpy2.min.js`（67,385 B）引擎本体**，作为
`source_for()` 的离线回落（§5.6）。目录是整体复制的，所以新增文件自动随包，不需要改脚本。

> 注意：`src-tauri/binaries/` 里那份是上一次 `prepare_runtime.py` stage 的快照；打包前应先跑
> `python tools/prepare_runtime.py` 重新 stage，避免把旧二进制带进交付包。

---

## 5. 验证结果（如实记录）

### 5.1 离线直驱 qjs-runner

| 用例 | 结果 |
|------|------|
| classic stub（`var spider`） | 7 个方法全通过（`tests/acceptance/p1.py --adapter` 18/18） |
| 合成 ESM 模块 | 模块声明、求值、导出发现、短名派发链路连通 |
| 真实 `apple.js` | 返回 5 个真实分类 |
| 真实 `荐片.js` | 返回 4 个真实分类 |
| 真实 `金牌影视.js` | 返回 5 个真实分类（含 `md5X` 路径） |
| 真实 `聚合短剧.js` | 返回 9 个真实分类（`import "./lib/crypto-js.js"` 别名命中本地资源） |
| `live2vod.js` | 预置 `__JS_SPIDER__` 全局后可执行（jsjiami 混淆源依赖该全局） |
| `drpy2.min.js` | **8 个 `import` 全部加载成功、模块求值通过**；`ext` 指向 404 规则文件（见 3.2），`homeContent` 只返回空 `class` |
| 8 个依赖逐个 import | `cheerio.min.js` / `crypto-js.js` / `node-rsa.js` / `pako.min.js` / `template.js` / `gbk.js` / `json5.js` / `jinja.js` 全部 OK |

### 5.2 真实窗口（debug，真实 box 配置 101 站）

| 检查 | 结果 |
|------|------|
| 策略 | 101 站 → 屏蔽 20（jvm）/ 可运行 73；6 个 JS 站全部 `enabled=true` |
| `spider_invoke` 首页 | apple 5 分类、金牌 5、聚合短剧 9、荐片 4；KTV(drpy2) 0（规则文件 404）、直播转点播 0（ext 数据未加载） |
| `playerContent` | apple 返回真实 `url` + `header`（含 token），说明脚本执行与非网络方法正常 |
| `probe_p1.mjs` | 12 项全 PASS，含「quickjs homeContent 解禁后返回列表」「fan-out 里 stub_js2/stub_net 均 ok」 |
| `probe_settings_health.mjs` | PASS：JS 源显示可达、jar 屏蔽源仍锁「启用」 |
| `cargo test --lib` / `pnpm test` / `p1.py --adapter` | 81 / 145 / 18 全通过 |

### 5.3 已修复的两个真实缺陷

1. **双重 JSON 编码**：FongMi JS0 脚本 `return JSON.stringify({...})`，sidecar 又
   `JSON.stringify` 一次 → Rust 收到的是 JSON **字符串**而不是页面对象，表现为「调用成功但
   `list`/`class` 全空」。修复：派发层对字符串返回值只 `JSON.parse` 一层（非 JSON 字符串原样保留）。
2. **宿主环境代理干扰**：同一 exe 离线直连 `http` 返回 200，app 内报
   `Network Error: Unexpected EOF`。修复：`req` 改用独立 `ureq::Agent`
   并 `try_proxy_from_env(false)`（TVBox 源按直连处理），GET 传输错误立即重试一次。

结论：模块加载 / ESM 求值 / 导出发现 / 短名派发 / 返回归一化这条链路在离线与真实窗口下都
已打通；drpy2 的「空 class」来自上游规则文件缺失与 `initEnv` polyfill 不完整，不是加载器
缺陷。**没有**声称全量 JS 站点可用，也**没有**做交付包实机验证。

### 5.4 `/proxy?do=js` 接通（2026-11-12，D1）

**为什么必须先做这条**：drpy2 规则常用 `getProxyUrl()` 拼播放地址，而宿主原来把这个全局
实现成 `return ''`，等于把「能搜到」的源全部变成「点进去 404/空」。这是 JS 家族里**唯一
同时影响播放成功率**的缺口，比补 `initEnv` 更直接。

| 环节 | 改动 |
|---|---|
| `qjs-runner` | 新增 `PROXY_JS`：按 `[contentType, headers, body]` / 数字状态码前缀 / `{contentType, headers, body}` / 裸字符串四种形态归一化为 `{contentType, headers, text\|b64}`；字节体经 `__luma_bytes_b64` 转 base64 过 JSON 帧 |
| `qjs-runner` | `HOST_JS` 的 `getProxyUrl(from)` 改为返回 `http://127.0.0.1:<宿主真实端口>/proxy?do=js[&from=…]`；端口由帧字段 `proxy_port` 注入 |
| Rust 宿主 | `SpiderMethod::Proxy`（wire 名 `proxy`）；`QuickJsRuntime::proxy()` 走同一把 runner 串行锁，响应经 `proxy_payload_from_js()` 还原成 `ProxyPayload` |
| Rust 宿主 | `proxy::active_port()`：9978 被占用而回退到临时端口时，sidecar 拿到的是**实际**端口，不是配置值 |
| 前端 | 无需改动——`usePlayResolution` 早就把 `127.0.0.1:<port>/proxy…` 原样透传，`resolve_play` 也对该路径不做二次包裹 |

验收（`p1.py --adapter`，21 项全通过）：

- `template.js` 的 `proxy` 返回 `[ct, headers, m3u8]` → 帧里 `contentType`、`text`、自定义 header 三项都对；
- `Uint8Array` 体 → `b64 = AP8QIA==`，解码回 `00 ff 10 20`；
- `getProxyUrl('vod')` → `http://127.0.0.1:9978/proxy?do=js&from=vod`。

**未做**：真窗口下用一个返回 `do=js` 的真实 drpy2 规则跑通「搜索→详情→播放」出画。D2
（§5.5）已经证明引擎侧不再挡路，剩下的是真实规则文件与出画验证。


### 5.5 D2：drpy2 引擎端到端跑通（2026-11-12）

**原计划「补 `initEnv` 垫片，1.5 天」被实测推翻。** 拿真实引擎（`cluntop/tvbox` 的
`lib/drpy2.min.js`，67 KB）跑探针，得到的事实与原判断几乎相反：

| 原判断 | 实测 |
|---|---|
| `pdfh`/`pdfa`/`pd` 是惰性 STUB，要我们实现 | **引擎自己定义** `function pdfh` / `function pdfa` / `const jsp`，不依赖宿主；`jsp`/`jpg` 中 `jpg` 是 `.jpg` 后缀的误匹配，不是函数 |
| `MY_URL`/`HOST` 要宿主注入 | 引擎自己 `if(typeof MY_URL==="undefined"){var MY_URL}` |
| 要补一堆 DOM 工具 | 真正缺的只有 3 个 **Web 全局**：`TextEncoder`/`TextDecoder`/`URLSearchParams`（`Uint8Array`/`DataView`/`Promise`/`Proxy` 都在） |

顺着探针又挖出 **3 个宿主真 bug**，每一个都能单独让整站变空：

| bug | 现象 | 后果 |
|---|---|---|
| **`req` 返回 Promise** | FongMi 约定 `req(url)` 是同步的，引擎写 `let res=req(url,obj); let html=res.content` | 拿到的是 Promise 对象，`.content` 为 `undefined`，`JSON.parse('undefined')` 抛错被引擎吞掉 → **所有 drpy2 规则恒空列表**。这就是之前 `live2vod` 报 `unexpected token: 'undefined'` 的同一个根因 |
| **`console.log(undefined)` 抛异常** | Rust 侧参数类型是 `String` | `console.log(RKEY)`（RKEY 未定义）直接 `Error converting from js 'undefined' into type 'string'`，**整个脚本中断**；源码里到处都是可选值日志 |
| **`atob` padding 泄漏** | 剥掉 `=` 后 `charAt` 越界，`B64C.indexOf('')` 返回 0 | `atob('aGVsbG8=')` 解出 `hello\u0000`，二进制签名类工具全错 |

改动：

| 位置 | 改动 |
|---|---|
| `HOST_JS.req` | 改为**同步返回结果对象**，并挂一个不递归的 `then`/`catch`，让 `req(x).content` 与 `await req(x)` 两种写法同时成立 |
| `HOST_JS` | 新增 `console`（JS 侧扁平化任意参数/undefined/Error）、`atob`/`btoa`（保留 `=` 判边界）、`TextEncoder`/`TextDecoder`（UTF-8 + 代理对；`gbk` 走引擎自带的 `gbkTool().decode`，输入是 percent 串不是字节）、`URLSearchParams`、`setTimeout`（微任务降级，无事件循环） |
| `HOST_JS` | 新增 `getProxy(true)`：引擎自己的 `getProxyUrl()` 优先调它、**fallback 硬编码 9978**；不提供时端口回退就会指向错端口 |
| Rust | 去掉 `console` Object，改为单一 `__luma_log` 字符串 sink |

端到端证据（真实引擎 + 配置里的真实 CMS `cj.ffzyapi.com`，非 fixture）：

| 方法 | 结果 |
|---|---|
| `homeContent` | 4 个分类（`class_name`/`class_url` 生效） |
| `homeVideoContent` | **20 条**，`vod_name=黄金渔场`、`vod_remarks=更新至第20261111期` |
| `categoryContent` | **20 条**，URL 正确替换 `fyclass=27` / `fypage=1` |
| `searchContent` | **20 条**，`**` 正确替换为关键词 |

4 个自包含真实源（荐片/金牌/apple/聚合短剧）在改动后仍正常出数据，无回归。

**踩坑记录（写给下一个改规则的人）**：drpy2 的 `一级`/`二级`/`搜索` 必须用 `;` 分成
**至少 5 段**，顺序是 `解析器;名称;图片;备注;id`。只写 `json:list` 会在
`categoryParse` 里被 `if(p.length<5){return "{}"}` 直接短路，表现为「URL 打得开、页面全空」，
极易误判成引擎或网络问题。

验收：`p1.py --adapter` **22/22**（新增 `web globals + sync req`，内含 9 条断言：
同步/await 两条 req 路径、`console.log(undefined)`、`atob` padding、`btoa`、UTF-8 编码与
含 emoji 的往返、`URLSearchParams`、`getProxy` 端口）；`cargo test --lib` 84/84；
`pnpm test` 145/145。

### 5.6 D3：引擎随包 + 离线回落（2026-11-12）

**为什么做**：引擎源码一直是**从站点 `api` 现场下载**的（`source_for`）。CDN 挂掉、被墙、
或运营商返回一个 200 的 HTML 错误页时，整个 drpy2 家族站点全灭——而「网络不好」恰恰是用户
最需要兜底的时刻。

**做了什么**：

| 层 | 改动 |
|---|---|
| 资源 | `sidecars/qjs-assets/js/lib/drpy2.min.js`（67,385 B，上游 `cluntop/tvbox/lib/drpy2.min.js`），`manifest.json` 登记 bytes + sha256 |
| `quickjs.rs` | `BUNDLED_ENGINES = ["drpy2.min.js", "drpy2.js"]`，按 URL basename 命中（忽略 query/hash） |
| `quickjs.rs` | `looks_like_script()`：`fetch` 只报传输失败，200 + HTML/空体要到 QuickJS 才炸成 `unexpected token '<'`，所以提前判定 |
| `quickjs.rs` | `source_for()` 三条路径：正常远程 → 非脚本时回落 → 传输失败时回落；**不是已知引擎则原样报错**，不会拿引擎覆盖用户自己的 spider |

**一个容易忽略但要紧的点**：引擎内部 `import "./pako.min.js"` 这类相对依赖是按**源码 URL**
解析的。如果回落时还把死掉的 `api` 当 base，8 个依赖会全部拼到死链上——兜底等于没做。
`normalize_module()` 的 `BUNDLED` 命中在 URL 拼接**之前**，所以 basename 命中的依赖仍然走
本地。这一点用「本地引擎 + 死域名 api + 真实规则」实测确认过，不是推理。

**验证**：

| 场景 | 结果 |
|---|---|
| 引擎 URL 404（GitHub 返回 14 B `404: Not Found`） | 判定为非脚本 → 用随包副本，长度与本地一致 |
| 引擎域名不可达（`.invalid`） | 传输失败 → 用随包副本 |
| 本地引擎 + 死 api + 真实 CMS 规则 | `homeContent` 2 分类、`homeVideoContent`/`categoryContent`/`searchContent` **各 20 条真实数据** |
| 缓存 | 回落结果与远程结果同样进 600s 缓存，避免每次请求都白等 10s 超时 |

验收：`p1.py --adapter` **23/23**（新增 `bundled engine + dead api`）；`cargo test --lib`
**87 passed / 1 ignored**（新增 3 条单测 + 1 条 `#[ignore]` 联网手工验证）；`pnpm test` 145/145。

**没做**：交付包实机验证（按约定停在 debug）。`tauri build` 经 `bundle.resources` 整目录打包
`sidecars/qjs-assets`，新文件自动随包，但未实际安装验证。


---

## 6. 仍需补齐

1. **`action` 方法路由**：drpy2 用 `action` 做换线路/清缓存/登录，目前只接了 `proxy`（§5.4），
   `action` 未接。`initEnv` 已不再是缺口——见 §5.5 的实测结论。
2. **真实规则文件的上游缺失**：`js_KTV歌厅` 的 `ext` 指向 `./js/drpy2.js`，该文件在
   `cluntop/tvbox` 上游 404。引擎侧已能跑真实规则（§5.5），这条属于站点资源缺失；按既有
   边界**不硬编码规则**，报告里如实标注即可。
3. **当前 FongMi class-based `Spider` 规范**：现只做 `new Spider(ext)` 的粗粒度兼容，新版
   class-based 规范（构造参数、`init` 时机、方法签名）尚未逐条对齐。
4. **交付包实机验证**：随包资源（`qjs-assets` 整目录 + `qjs-runner.exe` 经 `bundle.resources` / `bundle.externalBin` 落地）目前只有脚本级检查（`prepare_runtime.py --check`），仍需在干净机器上实际 `tauri build` 安装并跑一遍 JS 源。

---

## 7. 参考来源

| 来源 | 链接 | 说明 |
|------|------|------|
| FongMi/TV 仓库 | <https://github.com/FongMi/TV> | `quickjs/` 模块、`catvod/` 协议层；`Module.java` / `Spider.java` / `Global.java` / `net.js` 所在仓库 |
| DeepWiki · 6.1 JavaScript Extensions | <https://deepwiki.com/FongMi/TV/6.1-javascript-extensions> | QuickJS 引擎、`evaluateModule`、`QuickJSContext.BytecodeModuleLoader`；文件级索引：`quickjs/src/main/java/com/fongmi/quickjs/utils/Module.java`（模块解析）、`crawler/Spider.java`（URI 归一化与调用）、`method/Global.java`（宿主注入）、`bean/Req.java` / `Res.java`；内置库在 `quickjs/src/main/assets/js/lib/`（网络垫片在 FongMi/TV 中为 `http.js`，部分分支/派生仓库称 `net.js`） |
| hjdhnx/drpy-node | <https://github.com/hjdhnx/drpy-node> | catvod ESM 引擎、`drpyS` 沙箱、`initEnv` 注入参考 |
| DeepWiki · Execution Engines | <https://deepwiki.com/hjdhnx/drpy-node/3-source-management> | 五种引擎的统一接口（home / homeVod / category / detail / search / play / proxy / action / init）与 `catvod` 动态 `import()` 口径 |
| jieray/TVBOX · drpy2 源格式说明 | <https://github.com/jieray/TVBOX/blob/main/drpy2%E6%BA%90%E6%A0%BC%E5%BC%8F%E8%AF%B4%E6%98%8E.md> | drpy2 规则格式、`getProxyUrl` 本地代理约定、`export` 写法 |

