# 项目目录结构与编码约定

> 适用路径：`<repo>`
> 本文只约定「文件放哪、怎么写」，不替代规格书；工程树以规格书第 5 节为准，本文在其基础上补齐新增的 `docs/`、`contracts/`、`tools/`、`tests/fixtures/` 等目录。
> 当前状态（2026-11-08）：T-01 骨架已落地（前端 + Tauri + 依赖锁 + 契约），`pnpm build` 通过；Rust `cargo check` 待补 MSVC 环境。标注「规划」的条目是后续任务的放置位置，不代表已存在。

## 1. 完整目录树

```text
tvbox/
├── AGENTS.md                              # [已有] 项目协作说明与索引
├── SPEC_REVIEW.md                         # [已有] 规格书 v1.0 修订建议（历史）
├── .gitignore                             # [已有] 忽略规则
├── package.json / pnpm-lock.yaml          # [已有] 前端依赖与锁文件（pnpm 9.15.4）
├── tsconfig.json / vite.config.ts         # [已有] 构建配置（dev 端口 1420）
├── index.html                             # [已有] 前端入口
├── .workbuddy/                            # 工具侧本地上下文，不属于工程树
│
├── docs/
│   ├── project-layout.md                  # [已有] 本文档
│   ├── verification-config.md             # [已有] 抓取记录（含真实地址，不入库）
│   ├── verification-report.md             # [已有] 真实配置形态验证报告
│   ├── size-report.md                     # [规划] T-32 体积实测报告（R11）
│   ├── spec-v1.0/                         # [已有] v1.0 需求文档归档
│   │   ├── README.md
│   │   └── spec-v1.0-raw.md               # 逐字节归档（3235 行）
│   ├── spec-v1.1/                         # [已有] v1.1 本地基线
│   │   ├── CHANGELOG.md
│   │   ├── replacements.md                # 40 条可粘贴替换文本
│   │   └── cloud-actions.json             # 历史云端写入审计（只作留档）
│   └── tasks/                             # [已有] T-xx 交付记录
│       └── T-01.md
│
├── contracts/
│   ├── .gitkeep
│   └── tvbox.schema.json                  # [已有] 归一化契约唯一真源（R8）
│
├── src/                                   # React + TypeScript + Vite
│   ├── main.tsx / App.tsx / styles.css    # [已有] T-01 占位页
│   ├── lib/
│   │   └── invoke.ts                      # [规划] 唯一 IPC 入口，禁止 import Node 内置模块
│   ├── types/
│   │   └── tvbox.ts                       # [已有] 归一化契约 TS 侧
│   ├── store/                             # [规划] zustand 状态
│   └── pages/                             # [规划] 7 个页面（T-10）
│
├── src-tauri/
│   ├── Cargo.toml / Cargo.lock            # [已有] 最小依赖（T-01）
│   ├── build.rs                           # [已有]
│   ├── tauri.conf.json                    # [已有] 窗口、bundle、icon、externalBin 占位
│   ├── capabilities/default.json          # [已有] 最小白名单（无 shell:allow-spawn）
│   ├── icons/icon.ico                     # [已有] tools/make_icon.py 生成
│   └── src/
│       ├── main.rs / lib.rs               # [已有] 入口与 Builder
│       ├── commands.rs                    # [规划] 7 个 command（清单以 7.1 为准）
│       ├── error.rs                       # [规划] AppError / serde struct
│       ├── config.rs / http.rs            # [规划] T-05 / T-06
│       ├── bridge.rs / process.rs         # [规划] T-13 / T-18
│       ├── proxy.rs                       # [规划] T-08
│       ├── cms.rs                         # [规划] T-07
│       └── spider/                        # [规划] py / js / jvm 协议适配
│
├── sidecars/                              # 随包分发的 sidecar
│   ├── python-embed/                      # [规划] Python 3.11 embeddable
│   ├── py/                                # [规划] 适配层源码（stdio JSON-RPC）
│   ├── java/                              # [规划] SpiderRunner + stubs + dex2jar（P2）
│   ├── jre/                               # [规划] JDK 17 jlink 裁剪产物（P2）
│   ├── qjs-runner/                        # [规划] JS sidecar（R4 方案 A）
│   └── mpv/                               # [规划] 可选播放器（P3）
│
├── tests/
│   ├── fixtures/
│   │   ├── manual/                        # [已有] 真实配置样本（不入库）
│   │   ├── configs/                       # [已有] 6 类脱敏 fixture + README
│   │   └── jars/                          # [规划] 自编模板 jar（class / dex）
│   └── e2e/
│       ├── contract_check.py              # [已有] schema ↔ TS 字段名比对
│       ├── stub_server.py                 # [规划] 12.1 的 127.0.0.1 stub
│       └── p0.py ~ p3.py                  # [规划] 累积式阶段断言（R1）
│
└── tools/
    ├── inspect_config.py                  # [已有] 离线解码图种 + 形态统计
    └── make_icon.py                       # [已有] 生成 src-tauri/icons/icon.ico
```

说明：

- `AGENTS.md` 的「目录结构」段只指向本文与规格书第 5 节，不另抄一份，避免两处漂移。
- `docs/spec-v1.0/` 是逐字节归档，修订统一走 `docs/spec-v1.1/`；云端文档只读参考。
- `.workbuddy/` 是工具侧上下文，不属于上述工程树；其中 `memory/` 会随仓库提交，`buildtools-install.log` 这类日志被 `*.log` 忽略。

## 2. 各类文件放哪

| 类别 | 放置位置 | 说明 |
|---|---|---|
| 需求文档与修订稿 | `docs/spec-v1.0/`、`docs/spec-v1.1/` | 按版本号分目录；文件名用 ASCII |
| 修订建议 | 根目录 `SPEC_REVIEW.md` | 唯一一份，历史分析口径 |
| 项目协作说明 | 根目录 `AGENTS.md` | 索引与协作约定 |
| T-xx 交付记录 | `docs/tasks/` | 每个任务一份，含变更清单、验收结果、未解决问题 |
| 真实配置样本（手工抓取） | `tests/fixtures/manual/` | 开发期人工验证；含外部地址，**不入库、不被代码引用** |
| 构造 fixture（自造） | `tests/fixtures/configs/` | 自动化 fixture 只能放这里；必须脱敏，网络目标只指向 `127.0.0.1`（12.1） |
| 契约 | `contracts/` | 归一化契约唯一真源；TS / Rust / Python 三端字段名与之一致 |
| 前端源码 | `src/` | React + TypeScript + Vite |
| Rust 宿主源码 | `src-tauri/src/` | command、进程管理、proxy、运行时 |
| sidecar | `sidecars/` | 统一在 `tauri.conf.json` 的 `externalBin` 注册，由 Rust `process.rs` 拉起 |
| 验收脚本与 stub | `tests/e2e/`、`tests/fixtures/jars/` | 分阶段脚本与自编模板 jar |
| 离线工具 | `tools/` | 不参与构建、不发网络请求的开发辅助脚本 |

## 3. 编码约定

1. **所有文本文件一律 UTF-8 无 BOM**（含 `.md`、`.ts`、`.tsx`、`.rs`、`.py`、`.json`、`.toml`、`.gitignore`、`.gitkeep`）。
   新增文件不要带 BOM；BOM 会破坏 shebang、JSON 解析与部分 Rust/TS 工具链。
2. **换行统一 LF**：`.md` / `.ts` / `.tsx` / `.rs` / `.py` / `.json` / `.toml` / `.gitignore` 全部使用 `\n`。
   已配置 `core.autocrlf=false`、`core.safecrlf=true`；唯一例外是 `docs/spec-v1.0/spec-v1.0-raw.md` 里源文件自带的 1 处 CRLF（逐字节归档要求）。
3. **禁止用 Windows 记事本「另存为」选 ANSI / GBK**：会写成带 BOM 或非 UTF-8 编码，中文直接乱码。
4. **JSON 保存中文用 `ensure_ascii=False`**：中文以原字符写入，不要写成 `\uXXXX` 转义；同时保持 UTF-8 无 BOM + LF。
   ```python
   json.dump(obj, f, ensure_ascii=False, indent=2)
   ```
5. **Python 源码不写 coding 声明**：Python 3 默认 UTF-8。
6. **Rust / TS 源码注释可用中文，但字符串字面量与标识符一律 ASCII**：变量名、函数名、文件名、类型名、错误码、协议字段名用 ASCII。
7. **二进制样本例外**：`tests/fixtures/configs/image-seed.txt` 是 TVBox 图种（JPEG + base64），整体不是 UTF-8；标记后的 base64 段为 ASCII，属预期。

## 4. 命名约定

- 源码与配置文件：ASCII，小写蛇形 `snake_case`（`.rs` / `.py`）或小写 kebab `kebab-case`（目录、`.json` / `.toml`、前端文件名），例如 `tvbox.schema.json`、`project-layout.md`、`invoke.ts`、`contract_check.py`。
- 禁止中文文件名、空格、大写开头与盘符 / 绝对路径写进源码。
- 文档文件名用 ASCII（`project-layout.md`、`verification-config.md`、`size-report.md`），标题与正文用简体中文；版本目录用 `spec-v1.0` / `spec-v1.1`。
- 目录名用小写 kebab / 蛇形；占位文件统一叫 `.gitkeep`。

## 5. 不入库（.gitignore）范围

| 目录 / 文件 | 原因 |
|---|---|
| `tests/fixtures/manual/` | 真实配置样本，含外部地址；规格书 0 节禁止内置外部地址、12.1 要求 fixture 自造且只指向 `127.0.0.1`。**整目录忽略** |
| `docs/verification-config.md` | 抓取记录含真实 URL 与响应头，与样本同等敏感，不入库 |
| `node_modules/` | 前端依赖，由 pnpm 锁文件重建 |
| `dist/` | 前端构建产物 |
| `target/`、`src-tauri/target/` | Cargo 构建产物 |
| `src-tauri/gen/` | Tauri 生成的 schema 与中间产物 |
| `*.log`、`pnpm-debug.log*` | 运行日志，可能含密钥 / 外部地址 |
| `.DS_Store`、`Thumbs.db` | 系统元数据 |

配套规则：

- 根目录 `.gitignore` 已覆盖上述规则，文件本身 UTF-8 无 BOM、LF。
- `tests/fixtures/manual/` 下的 `.gitkeep` 也被整目录规则忽略，属预期。
- **不要**为「让样本进仓库」加 `!` 反忽略规则；自动化 fixture 只能放 `tests/fixtures/configs/`，且必须脱敏为指向 `127.0.0.1` 的自造样本。
- 密钥、token、用户本机提供的 jar、抓取缓存一律不入库、不回显。

## 6. 与既有文档的关系

- 本文不修改 `AGENTS.md`、`SPEC_REVIEW.md`，也不改动 `docs/spec-v1.0/`、`docs/spec-v1.1/` 内容。
- 工程实现以本地 `docs/spec-v1.1/` 为唯一依据；若本文与规格书冲突，按 `AGENTS.md`「本地需求文档优先」处理。
