# P0 脱敏配置样本（`tests/fixtures/configs/`）

用于 P0/P1/P2 验收的**自造、脱敏** TVBox 配置样本。全部网络目标仅为
`http://127.0.0.1:8787`（`tests/stub_server.py` 默认端口），**不含任何真实外部域名、IP、片源地址或 API Key**，
与开发期人工抓取的真实样本（已被 `.gitignore` 排除）无引用关系，**可安全入库**。

- 编码：文本文件均为 UTF-8 无 BOM、LF；`image-seed.txt` 为「二进制 JPEG 外壳 + ASCII base64」，见下文说明。
- 命名：ASCII 小写蛇形；站点 `key`/`name` 均为虚构值（`stub_*`、`示例站 *`）。
- 生成：由本地 Python 脚本离线生成，1x1 JPEG 常量为内嵌 base64，**未联网下载任何图片**。

## 样本清单

| 文件 | 字节数 | 覆盖点 | 规格书章节 | 任务 | 预计消费的 stub 端点 |
|---|---:|---|---|---|---|
| `cms-classic.json` | 961 | 3 站点分别 `type=0/1/4`；顶层 `sites`/`lives`/`parses`/`flags`；m3u 直播与解析条目 | 6.1、8.3 规则 4/5/6、8.5、8.7、12.1 | T-05、T-07 | `/cms/xml`、`/cms/json`、`/cms/remote`、`/live/list.m3u`、`/parse` |
| `image-seed.txt` | 599 | 图种外壳：1x1 JPEG + 标记 `BFkMrNQT**` + base64(JSONC)；JSONC 含 `//` 注释与 `spider` 的 `;md5;` 校验 | 6.1、8.1（解密链）、12.1 | T-05 | `/spider.jpg`（图种本体）、内含站点指向 `/cms/xml` |
| `py-site.json` | 497 | 站点 A `jar="py"` + `api=…/site.py`；站点 B 仅 `api` 以 `.py` 结尾（无 jar）；均带 `ext` | 8.3 规则 1、6.1、6.2（`runtime=python`）、8.5 | T-15 | `/site.py`、`/spider/template.py` |
| `js-site.json` | 497 | 站点 A `jar="js"` + `api=…/site.js`；站点 B 仅 `api` 以 `.js` 结尾（无 jar）；均带 `ext` | 8.3 规则 2、6.1、6.2（`runtime=quickjs`）、8.5 | T-16 | `/site.js`、`/spider/template.js` |
| `jar-csp.json` | 508 | 规则 3 的两种触发：`key` 以 `csp_` 开头；普通 `key` 但 `jar` 为 `.jar` URL；两站均带 `ext` | 8.3 规则 3、6.2（`runtime=jvm`）、8.5 | P2（T-20、T-23、T-24） | `/spider.jar` |
| `extras-unknown.json` | 1396 | 全 `type=3` + 无扩展名 `api=/probe`；`ext`≥30 字符、`style`/`indexs`/`timeout`/`playerType`/`changeable`/`quickSearch`；顶层 `hosts`/`rules`/`logo`/`wallpaper`、`lives[].timeZone`；2 个规格书未定义键 | 6.1、8.3 规则 7（探测）、8.5、12.1 | T-05、T-07、T-23（ext 透传） | `/probe`（×2）、`/live/list.m3u` |

## 覆盖点细目

### `cms-classic.json`
- `stub_xml`（`type=0`）→ `/cms/xml`：命中 8.3 规则 5，CMS XML 分支。
- `stub_json`（`type=1`）→ `/cms/json`：命中 8.3 规则 4，CMS JSON 分支。
- `stub_remote`（`type=4`）→ `/cms/remote`：命中 8.3 规则 6，远程 API 透传分支。
- `lives[0].url` → `/live/list.m3u`；`parses[0].url` → `/parse`；`flags` 为字符串数组，验证 8.5 透传。

### `image-seed.txt`
- 结构：`<JPEG 字节><BFkMrNQT**><base64(UTF-8 JSONC)><LF>`；JPEG 为 160 字节最小 1x1 图（`FFD8…FFD9`）。
- 还原流程：查找 `BFkMrNQT**` → 取其后全部内容并去除首尾空白 → base64 decode → UTF-8 文本（JSONC）。
- JSONC 内含 1 个 `type=0` 站点指向 `http://127.0.0.1:8787/cms/xml`，`spider` 为
  `http://127.0.0.1:8787/spider.jpg;md5;00000000000000000000000000000000`。
- 注释剥离必须**字符串感知**：URL 中的 `//` 不得被当注释（与 `tools/inspect_config.py` 的 `strip_line_comments()` 口径一致）。

### `py-site.json` / `js-site.json`
- 每个文件两个站点，分别覆盖「`jar` 显式声明」与「仅 `api` 后缀」两条触发路径（8.3 规则 1/2）。
- `ext` 非空，供 8.5 / T-15 / T-16 校验原样透传。

### `jar-csp.json`
- `csp_stub`：`key` 前缀触发；`api` 为 `csp_stub`（jar 内 scheme 名，**不是网络地址**）。
- `stub_jar_url`：`key` 普通，但 `jar` 为 `.jar` URL 触发；其 `api` 是 CMS JSON 地址，**按 8.3 规则 3 应先于规则 4 判为 `jvm`**，是刻意的优先级测试点。

### `extras-unknown.json`
- 两个站点均为 `type=3` 且 `api=/probe`（无扩展名）→ 8.3 规则 7 探测分支。
- `ext` 长度分别 36 / 33 字符（>30）；`style`、`indexs`、`timeout`、`playerType`、`changeable`、`quickSearch` 均出现。
- 顶层含 `hosts`、`rules`、`logo`、`wallpaper`，`lives[]` 含 `timeZone`。
- `customFlag`、`vendorNote` 为规格书未定义键：归一化层必须容错（保留到 `_raw` 或安全忽略），不得报错。

## 与规格书的差异 / 冲突（须在实现侧留意）

1. **stub 端点缺口（12.1）**：v1.0 §12.1 只登记 `/config*.json|txt`、`/cms/vod`、`/cms/xml`、
   `/spider/template.py`、`/spider/template.js`、`/live/list.m3u`、`/play.m3u8`、`/page/play.html`。
   本清单按任务书要求使用了 `/cms/json`、`/cms/remote`、`/parse`、`/probe`、`/site.py`、`/site.js`、
   `/spider.jar`、`/spider.jpg`，**需要 stub_server 扩展这些路径**（建议 `/cms/json` 复用 `/cms/vod` 响应体，
   `/site.py`/`/site.js` 复用 `/spider/template.*`），否则样本无法端到端消费。本文不改规格书，仅记录差异。
2. **图种不在 8.1 明文范围**：8.1 只写「配置解密链」，未点名 JPEG 图种 + `;md5;` 形态（内部验证报告第 6 节已记，不随仓库分发）。本样本用于推动 T-05 覆盖该形态，不代表规格书已定义。
3. **`image-seed.txt` 整体非 UTF-8**：JPEG 二进制外壳使其无法整体按 UTF-8 解码；标记之后的 base64 段为
   ASCII + LF。这是图种形态的固有属性，不是编码违例；其余 5 个文本文件均为 UTF-8 无 BOM、LF。
4. **`type=4` 远程 API 未定义请求契约**：8.3 只说「远程 API，透传参数」，未定义参数名与请求方法。
   样本只能验收路由判定与参数透传，业务响应需 stub 自定义最小结构。
5. **6.2 `Site` 契约字段少于原始配置**：`style`、`indexs`、`playerType`、`changeable`、
   `customFlag`、`vendorNote` 不在 6.2 接口中；按 6.1「未知字段保留到 `_raw`」处理。
   另，原始样本惯例用 `1/0` 表示布尔（如 `searchable`），归一化需转 `boolean`。
6. **规则 3 的「顶层 `spider` + 站点无显式 `api`」未单独构造**：`image-seed.txt` 的 JSONC 有顶层 `spider`，
   但站点有显式 `api`，因此按 8.3 不触发 jvm；本清单用 `jar-csp.json` 覆盖规则 3 的另外两种触发方式。
   如需该组合，建议 P2 再补一份无 `api` 的站点样本。

## 安全声明

本目录所有文件（含图种内嵌 JSONC）中的 `http(s)://` 目标均经正则扫描确认为 `127.0.0.1`（端口 `8787`），
无任何真实外部域名、外部 IP、片源地址或 API Key；未从任何开发期真实样本复制字段值。
**全部指向 127.0.0.1、可安全入库、可进 CI。**
