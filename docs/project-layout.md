# 项目目录结构与编码约定

> 适用路径：`<repo>`
> 本文只约定「文件放哪、怎么写」，不替代规格书；工程树以规格书第 5 节为准，本文在其基础上补齐新增的 `docs/`、`contracts/`、`tests/fixtures/` 等目录。
> 当前状态：**仅落地了目录、`.gitkeep` 与少量文档**，尚无任何源码。下表中标注「规划」的文件是后续阶段的放置位置说明，不代表已存在。

## 1. 完整目录树

```text
tvbox/
├── AGENTS.md                          # [已有] 项目协作说明与索引（不修改）
├── SPEC_REVIEW.md                     # [已有] 规格书 v1.0 修订建议（根目录，见第 2 节）
├── .gitignore                         # [已有] 忽略规则（含 tests/fixtures/manual/）
├── .workbuddy/                        # 工具侧本地上下文，不属于工程树，不修改
│
├── docs/                              # [已有] 全部文档
│   ├── .gitkeep
│   ├── project-layout.md              # [已有] 本文档
│   ├── verification-config.md         # [已有] 真实配置抓取验证记录与合规边界
│   ├── size-report.md                 # [规划] T-32 体积实测报告（见 SPEC_REVIEW R11）
│   ├── spec-v1.0/                     # [已建目录] v1.0 需求文档与修订稿（内容由另一 Agent 写）
│   │   └── .gitkeep
│   └── spec-v1.1/                     # [已建目录] v1.1 需求文档与修订稿（内容由另一 Agent 写）
│       └── .gitkeep
│
├── contracts/                         # [已有] 归一化契约唯一真源
│   ├── .gitkeep
│   └── tvbox.schema.json              # [规划] JSON Schema，三端字段名对齐基准（见 R8）
│
├── src/                               # [已有空目录] React + TypeScript + Vite 前端
│   ├── .gitkeep
│   ├── lib/
│   │   └── invoke.ts                  # [规划] 唯一 IPC 入口，禁止 import Node 内置模块
│   ├── types/
│   │   └── tvbox.ts                   # [规划] 归一化契约 TS 侧（与 contracts/ 对齐）
│   └── ...                            # [规划] 页面、组件、store、播放器等
│
├── src-tauri/                         # Tauri v2 + Rust 宿主
│   └── src/                           # [已有空目录]
│       ├── .gitkeep
│       ├── lib.rs                     # [规划] command 注册
│       ├── commands.rs                # [规划] 7 个 Tauri command（清单以规格书 7.1 为准）
│       ├── error.rs                   # [规划] AppError / serde struct
│       ├── bridge.rs                  # [规划] 适配层 stdio JSON-RPC 分发
│       ├── process.rs                 # [规划] 子进程拉起、Job Object、超时强杀
│       ├── cms.rs                     # [规划] CMS 运行时
│       ├── spider/                    # [规划] py / js / jar 协议适配
│       ├── capabilities/
│       │   └── default.json           # [规划] WebView 权限白名单
│       └── tauri.conf.json            # [规划] externalBin、窗口、打包配置
│
├── sidecars/                          # [已有空目录] 随包分发的 sidecar
│   ├── .gitkeep
│   ├── python-embed/                  # [规划] Python 3.11 Windows embeddable + 适配层
│   ├── jvm/                           # [规划] JDK 17 jlink 裁剪 JRE + SpiderRunner
│   ├── qjs-runner/                    # [规划] JS sidecar（若采用 R4 方案 A）
│   └── mpv/                           # [规划] 可选播放器（P3）
│
└── tests/                             # 测试与样本
    ├── .gitkeep
    ├── fixtures/
    │   ├── .gitkeep
    │   ├── manual/                    # [已有] 真实配置手工样本（不入库，见第 5 节）
    │   │   ├── .gitkeep
    │   │   └── fantaiying-tv.txt     # [已有] 开发期验证样本，禁止被产品代码引用
    │   ├── configs/                   # [已有空目录] 自造 fixture，只指向 127.0.0.1
    │   │   └── .gitkeep
    │   └── jars/                      # [规划] 自编模板 jar（class / dex 两种形态）
    └── e2e/
        ├── p0.py ~ p3.py              # [规划] 分阶段验收脚本（累积式断言，见 R1）
        ├── contract_check.py          # [规划] 三端契约字段名比对
        └── stub_server.py             # [规划] 12.1 的 127.0.0.1 本地 stub
```

说明：

- `AGENTS.md` 的「目录结构」段只指向规格书第 5 节、不另抄一份；本文把该工程树与本次新增目录合并展示，避免两处漂移。
- `docs/spec-v1.0/`、`docs/spec-v1.1/` 只建目录，内容由另一个 Agent 写入，本轮不碰。
- `.workbuddy/` 是工具侧上下文，不属于上述工程树；本轮不修改其下任何文件。

## 2. 各类文件放哪

| 类别 | 放置位置 | 说明 |
|---|---|---|
| 需求文档与修订稿 | `docs/spec-v1.0/`、`docs/spec-v1.1/` | 按版本号分目录；一个版本一个目录，文件名用 ASCII |
| 修订建议 | 根目录 `SPEC_REVIEW.md` | 唯一一份，逐条修订建议与待拍板决策的汇总；**不**放进 `docs/spec-v*` |
| 项目协作说明 | 根目录 `AGENTS.md` | 索引与协作约定，不修改 |
| 真实配置样本（手工抓取） | `tests/fixtures/manual/` | 开发期人工验证用；含外部配置地址，**不入库、不被代码引用**，详见 `docs/verification-config.md` 第 9 节 |
| 构造 fixture（自造） | `tests/fixtures/configs/` | 自动化 fixture 只能放这里；必须自行构造、脱敏，网络目标只指向 `127.0.0.1`（规格书 12.1） |
| 契约 | `contracts/` | 归一化契约唯一真源（如 `tvbox.schema.json`）；TS / Rust / Python 三端字段名与之一致 |
| 验证记录、体积报告等工程文档 | `docs/` | 例如 `verification-config.md`、`project-layout.md`、`size-report.md` |
| 前端源码 | `src/` | React + TypeScript + Vite |
| Rust 宿主源码 | `src-tauri/src/` | Tauri v2 command、进程管理、proxy、运行时 |
| sidecar | `sidecars/` | 随包分发的可执行运行时，统一在 `tauri.conf.json` 的 `externalBin` 注册 |
| 验收脚本与 stub | `tests/e2e/`、`tests/fixtures/jars/` | 分阶段脚本与自编模板 jar |

## 3. 编码约定

1. **所有文本文件一律 UTF-8 无 BOM**（含 `.md`、`.ts`、`.tsx`、`.rs`、`.py`、`.json`、`.toml`、`.gitignore`、`.gitkeep`）。
   新增文件不要带 BOM；BOM 会破坏 shebang、`#!`、JSON 解析与部分 Rust/TS 工具链。
2. **换行统一 LF**：`.md` / `.ts` / `.tsx` / `.rs` / `.py` / `.json` / `.toml` / `.gitignore` 全部使用 `\n`，不使用 CRLF。
   Windows 上建议给编辑器 / Git 配置 `core.autocrlf=false`，或直接按 LF 保存。
3. **禁止用 Windows 记事本「另存为」选 ANSI / GBK**：那会写成带 BOM 或非 UTF-8 编码，中文直接变乱码。
   需要编辑请用 VS Code、Git Bash 下的编辑器或 `python3` 按 UTF-8 读写。
4. **JSON 保存中文用 `ensure_ascii=False`**：中文以原字符写入，不要写成 `\uXXXX` 转义；同时保持 UTF-8 无 BOM + LF。
   ```python
   json.dump(obj, f, ensure_ascii=False, indent=2)
   ```
   契约文件、构造 fixture、配置文件均按此口径。
5. **Python 源码不写 coding 声明**：Python 3 默认 UTF-8，不写 `# -*- coding: utf-8 -*-`，也不写 `# coding=...`。
6. **Rust / TS 源码注释可用中文，但字符串字面量与标识符一律 ASCII**：
   变量名、函数名、文件名、类型名、错误码、协议字段名用 ASCII；中文只出现在注释与文档里，
   避免跨平台编译、反射、序列化与日志解析出现编码问题。

## 4. 命名约定

- 源码与配置文件：ASCII 字符，小写蛇形 `snake_case`（`.rs` / `.py`）或小写 kebab `kebab-case`（目录、`.json` / `.toml`、前端文件名），
  例如 `tvbox.schema.json`、`project-layout.md`、`invoke.ts`、`contract_check.py`、`spider-invoke`。
- 禁止中文文件名、空格、大写开头与盘符 / 绝对路径写进源码（见 `AGENTS.md` 开发约定）。
- 文档文件名建议 ASCII（`project-layout.md`、`verification-config.md`、`size-report.md`），
  **标题与正文用简体中文**；版本目录用 `spec-v1.0` / `spec-v1.1` 这类 ASCII 名。
- 目录名用小写 kebab / 蛇形；占位文件统一叫 `.gitkeep`。

## 5. 不入库（.gitignore）范围

| 目录 / 文件 | 原因 |
|---|---|
| `tests/fixtures/manual/` | 真实配置手工样本，含外部 TVBox 配置地址、片源 / 直播源 / spider URL；规格书 0 节禁止内置外部地址、12.1 要求 fixture 自造且只指向 `127.0.0.1`。**整目录忽略，不提交 Git** |
| `node_modules/` | 前端依赖，由 pnpm 锁文件重建 |
| `dist/` | 前端构建产物 |
| `target/`、`src-tauri/target/` | Cargo 构建产物 |
| `*.log` | 运行日志，可能含密钥 / 外部地址 |
| `.DS_Store`、`Thumbs.db` | 系统生成的元数据文件 |

配套规则：

- 已在根目录 `.gitignore` 写入 `tests/fixtures/manual/` 及上述构建产物规则；该文件本身 UTF-8 无 BOM、LF。
- `tests/fixtures/manual/` 下的 `.gitkeep` 也被整目录规则忽略，属预期：该目录本就不应进入仓库。
- **不要**为了「让样本进仓库」而给它加 `!` 反忽略规则；自动化 fixture 只能放 `tests/fixtures/configs/`，且必须脱敏改写为指向 `127.0.0.1` 的自造样本。
- 密钥、token、用户本机提供的 jar、抓取缓存等一律不入库、不回显（见 `AGENTS.md`「密钥不入库、不回显」）。

## 6. 与既有文档的关系

- 本文不修改 `AGENTS.md`、`SPEC_REVIEW.md`，也不改动 `docs/spec-v1.0/`、`docs/spec-v1.1/` 内容。
- 工程实现仍以规格书为唯一依据；若本文与规格书冲突，按 `AGENTS.md`「规格书优先」处理，先说明理由再改规格书。
