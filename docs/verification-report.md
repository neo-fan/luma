# 真实配置本地验证报告

> 日期：2026-11-08 · 性质：**开发期本地人工验证样本**，不是自动化测试 fixture，不是产品内置配置。
> 本文不含任何外部站点地址、片源地址或 API Key；抓取过程与原始响应头见 `docs/verification-config.md`（该文档不入库）。
> 规格书依据：本地 `docs/spec-v1.1/CHANGELOG.md` 与 `docs/spec-v1.1/replacements.md`（v1.1 全部在本地）。

## 1. 产物与校验

| 文件 | 说明 | 字节数 | SHA256 |
|---|---|---|---|
| `tests/fixtures/manual/fantaiying-tv.txt` | 站点原始响应体（TVBox 图种，逐字节保存） | 19,951 | `b7ce2c710a34d0e971fa3198a13f692de5f728b0d6ece15b317fe8e22e35dd4f` |
| `tests/fixtures/manual/fantaiying-tv.jsonc` | 从图种解码出的配置正文（JSONC，含 `//` 注释、CRLF 换行） | 13,155 | `3c2859f7d3b3b2407d190d5ddeb8e980831e3bc6a27299e237aeccaa7ec45f22` |
| `tools/inspect_config.py` | 可复用的解码 + 形态统计脚本（纯离线，不发网络请求） | — | — |

两个样本文件都在 `tests/fixtures/manual/`，已被 `.gitignore` 排除，**不入库**。

复现命令：

```bash
python3 tools/inspect_config.py
```

脚本会重新解码并输出 JSON 形态摘要；`strip_line_comments()` 只剥离字符串外的 `//` 注释，不会破坏 URL 内的 `//`。

## 2. 形态摘要（脚本实测）

**顶层键（7 个）**：`hosts`(3 项)、`lives`(6 项)、`logo`(字符串)、`rules`(1 项)、`sites`(48 项)、`spider`、`wallpaper`。
**未出现**：`parses` / `parse`、`flags`、顶层 `ua`、`urls`（多仓）、`home`。

**站点（48 个）**

| 项 | 实测 |
|---|---|
| `type` 分布 | 全部 `3`（48/48），无 0 / 1 / 4 |
| `api` 形态 | 45 个无扩展名，3 个以 `.js` 结尾；无一含 `provide/vod` 或 `api.php` |
| `jar` | 0 个站点带 `jar` 字段；`key` 无一以 `csp_` 开头 |
| `ext` | 30 个非空，平均长度 63.8 字符 |
| 字段频次 | `key`/`name`/`type`/`api`/`searchable` 48；`changeable` 47；`quickSearch` 46；`ext` 30；`style` 20；`timeout` 19；`playerType` 7；`indexs` 6 |
| 未出现 | `header`、`ua`、`categories`、`filterable`、`filter`、`jar` |

**直播（6 个）** 字段：`name`、`playerType`、`timeZone`、`timeout`、`type`、`ua`、`url`。

**`spider`** 是「图片 URL + `;md5;` + 校验值」形态，即图种 jar 声明。

## 3. 与规格书 v1.1 的对照（验证结论）

| 规格书位置 | 样本表现 | 对实现的含义 |
|---|---|---|
| **8.3 `route()` 判定** | 48 个站点全是 `type=3`；8.3 已注明「社区各分支 type 语义不一致，禁止仅凭 type 判定」 | 45 个无扩展名 `api` 会落到规则 7「探测」（GET `api` 判 JSON/XML），3 个 `.js` 落 `qjs-runner`。顶层 `spider` 存在但站点有显式 `api`，不触发 jvm 规则。**这份配置在 P0 阶段没有任何站点能直接跑通**（P0 只有 CMS type 0/1/4），正好印证 v1.1 的 12.2 累积断言矩阵：P0 不测 spider 方法 |
| **8.1 配置解密链** | 站点下发的是 JPEG 图种 + 标记 + base64 内嵌 JSONC；`spider` 带 `;md5;` 校验 | `config.decrypt` 需支持图种解码与 md5 校验；规格书 8.1 只写「解密链」未点名图种，建议列入后续补充口径（本文第 6 节） |
| **6.1 / 6.2 归一化** | 出现规格书未列字段：站点 `style`、`indexs`；顶层 `hosts`、`rules`、`logo`；直播 `timeZone` | 归一化层必须**容错未知字段**（保留或安全忽略），不得因未知键失败；这正好检验 6.1「各分支别名不一致，一律在 Python 层收敛」 |
| **8.5 扩展字段透传** | 30/48 站点带 `ext`，平均 63.8 字符 | `ext` 丢失影响面很大，印证 8.5「ext 丢失会导致大批源失效」与 v1.1 把它列为 P2 验收重点 |
| **6.2 `Site` 契约** | 样本无 `jar`/`header`/`ua`/`categories`/`filterable`/`filter` | 这些分支在本样本**零覆盖**，必须另造自造 fixture 才能验收，不能误以为「真实配置跑通 = 契约全覆盖」 |
| **12.1 测试边界** | 规则 7「探测」需要 GET 外部 `api` | 该样本**不可进自动化测试**（0 节要求测试网络目标只能是 `127.0.0.1`）；要自动化必须先脱敏改写成指向 127.0.0.1 stub_server 的构造样本 |

## 4. 本地验证怎么用

1. 运行 `python3 tools/inspect_config.py`，确认解码长度、SHA256、形态摘要与本文一致。
2. 人工核对四类形态：图种外壳、JSONC 注释、`type=3` 全量、30 个 `ext`。
3. 对照第 3 节表格，检查 `config.decrypt` / `config.normalize` / `route()` / `ext` 透传的实现是否覆盖这些形态。
4. **不做**：不连外网复抓、不把样本路径写进 `src/`、`src-tauri/`、`sidecars/`、不写进产品默认配置、不进 CI、不提交 Git。

## 5. 建议补的自造 fixture（脱敏后放 `tests/fixtures/configs/`）

全部指向 `127.0.0.1` 的 stub_server，不含任何真实外部地址：

| # | 构造形态 | 覆盖点 |
|---|---|---|
| 1 | `type=0` XML CMS / `type=1` JSON CMS / `type=4` 远程 API | P0 的 `cms.rs` 与 T-07 |
| 2 | 图种外壳 + base64 内嵌 JSONC、`spider` 带 `;md5;` | `config.decrypt` |
| 3 | `jar=="py"`、`api` 以 `.py` 结尾 | python runtime 路由 |
| 4 | `jar=="js"`、`api` 以 `.js` 结尾 | qjs-runner sidecar 路由 |
| 5 | `csp_` 前缀 + 自编模板 jar | jvm 路由、P2 验收基准 |
| 6 | 带 `ext`/`style`/`indexs`/`hosts`/`rules`/未知顶层键 | 扩展字段透传与未知字段容错 |

## 6. 本次验证新发现（记录在本地，不改云端）

- **图种配置未在规格书 8.1 点名**：JPEG + 标记 + base64 与 `;md5;` spider 校验是常见 TVBox 分发形态，建议后续版本把「图种解码」写进 8.1 解密链与 T-05 验收。
- **规则 7「探测」缺量化口径**：45/48 站点依赖探测分支，但 8.3 未定义探测超时、重试、灰显阈值与 `DIALECT_UNKNOWN` 触发条件；建议补充。
- **`type=3` 的现实权重**：真实样本 100% 是 `type=3`，而 P0 的 `cms.rs` 只写 0/1/4，说明「P0 可用闭环」对真实配置的覆盖有限，排期沟通时要说清楚。

> 用户已明确「不用改云端规格书，全部在本地」：以上三条只作为本地记录，不写入任何云端文档。
