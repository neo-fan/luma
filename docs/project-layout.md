# 项目目录结构与编码约定

> 本文只约定「文件放哪、怎么写、产物归哪」。架构见 `docs/ARCHITECTURE.md`，调试见 `docs/DEVELOPMENT.md`，发布见 `docs/RELEASING.md`。
> 当前状态（2026-11-14）：P0~P3 完成，真实配置「导入 → 搜索 → 详情 → 播放」跑通；前端 React + react-router + zustand，Rust 后端已按 `infra/` + `domain/` 物理分层。

## 1. 标准 Tauri v2 结构与本项目对齐

标准 Tauri v2 把工程分两层，三类产物各就各位、全部 gitignore：

```text
project-root/
├── src/                       前端源码（React/Vue）
├── public/  index.html  package.json  vite.config.ts
├── dist/                      ① 前端产物（Vite；tauri.conf.json frontendDist=../dist）
└── src-tauri/                 Rust crate 根（Cargo.toml 所在）
    ├── src/                   main.rs（入口）· lib.rs（模块+run）· 分层模块
    ├── Cargo.toml  build.rs  tauri.conf.json  capabilities/
    ├── icons/
    └── target/                ② Rust 产物（Cargo 默认；debug/ release/ bundle/）
```

本项目**完全对齐**标准 Tauri v2 骨架：前端 `dist/`、Rust `src-tauri/target/`、交付包走 Tauri 官方 `src-tauri/target/release/bundle/`。构建与打包**全部用官方 `tauri build`**，不手搓。交付形态为 **NSIS 安装器**（用户决定先出安装版、跟随官方），由 `tauri.conf.json` 的 `bundle.targets` 控制；随包运行时（python-embed / qjs-runner 二进制）经 `bundle.resources` / `bundle.externalBin` 打包，源文件由 `tools/prepare_runtime.py` 准备好（这一步是项目特有，不是轮子）。

三类产物统一归口（`AGENTS.md`「常用命令」给重建命令）：

| 产物 | 唯一位置 | 生成命令 | 是否入库 |
|---|---|---|---|
| ① 前端 | `dist/` | `corepack pnpm build`（经 `tauri build` 自动调用） | 否 |
| ② Rust | `src-tauri/target/` | `cargo build` / `pnpm tauri dev` / `pnpm tauri build` | 否 |
| ③ 交付包 | `src-tauri/target/release/bundle/nsis/*.exe` | `corepack pnpm tauri build`（官方） | 否 |

**注意**：根 `target/` 不会出现（本项目非 Cargo workspace，crate 根在 `src-tauri/`）。此外 `sidecars/qjs-runner/` 是**独立 Cargo crate**，Cargo 会在它自己目录产出 `target/`（`prepare_runtime.py` 依赖 `sidecars/qjs-runner/target/release/qjs-runner.exe`，故只是忽略、不挪位置）；将来新增独立 crate 同理，把其 `target/` 加入 `.gitignore`。所有 Cargo 产物统一原则 = **一律 gitignore，不入库**。

## 2. 完整目录树

```text
luma/
├── AGENTS.md                              # 给 AI 协作者/维护者的当前规范（≤ 20 KB）
├── README.md                              # 对外说明（免责声明/功能/构建/使用/已知限制）
├── CHANGELOG.md                           # 版本变更日志（每次发版更新）
├── LICENSE                                # 许可证（GPL-3.0-or-later 全文）
├── CONTRIBUTING.md                        # 贡献流程与代码约定
├── SECURITY.md                            # 安全模型与漏洞报告
├── THIRD-PARTY-NOTICES.md                 # 随仓库分发的第三方组件与许可
├── .gitignore                             # 产物 / 运行时 / 敏感数据忽略规则
├── .github/workflows/check.yml            # CI：离线回归三 job（checks / rust / py-adapter），不跑窗口探针
├── package.json / pnpm-lock.yaml          # 前端依赖与锁文件（pnpm 9.15.4）
├── tsconfig.json / vite.config.ts         # 构建配置（dev 端口 1420）
├── index.html  public/                    # 前端入口与静态资源（含 icon.svg）
├── dist/                                  # [产物] 前端，gitignore
├── src-tauri/target/release/bundle/        # [产物] NSIS 安装器，gitignore
│
├── docs/                                  # 只放活文档（冻结快照不随仓库分发）
│   ├── README.md                          # 本文档目录的索引（谁读、何时改）
│   ├── project-layout.md                  # 本文档（目录/产物/编码权威）
│   ├── ARCHITECTURE.md                    # 架构说明 + ADR（进程/四类源/数据流/分层）
│   ├── DEVELOPMENT.md                     # 开发调试指南（环境/四端调试/日志/回归/常见坑）
│   ├── MAINTENANCE.md                     # 维护与升级（契约/依赖/回归分层/工程债）
│   ├── RELEASING.md                       # 发布流程（版本同步清单/检查/打包/验收）
│   ├── js-support.md                      # JS 源机制、ESM 加载与随包资源清单（含 SHA256）
│   ├── size-report.md                     # 体积实测报告
│   ├── verification-config.md             # [本地] 抓取记录（含真实地址，gitignore）
│   └── spec.md                           # 实现规格（现状唯一基线，不按版本号切分）
│
├── contracts/
│   └── luma.schema.json                  # 归一化契约唯一真源（TS 类型 ↔ Rust 序列化）
│
├── src/                                   # React + TypeScript + Vite
│   ├── main.tsx  App.tsx  AppShell.tsx    # 入口 / RouterProvider / 布局壳（侧栏·同步·Esc·滚动）
│   ├── routes.tsx                         # 路由表（8 条）+ 页面包装组件
│   ├── styles/                            # 样式模块，级联顺序由 index.css 的 @import 决定
│   │   ├── index.css                      # 入口：只有顺序说明与 @import
│   │   ├── base.css                       # token（:root）/ 字体 / 滚动条
│   │   ├── layout.css  live.css  chrome.css
│   │   ├── controls.css  cards.css  feedback.css
│   │   ├── detail.css  player.css  player-panels.css  command-palette.css
│   │   └── pages.css  polish.css          # polish 是后置覆盖层，必须排最后
│   ├── pages/                             # Home/Search/Detail/Player/Live/Favorites/History/Settings
│   ├── components/                        # 通用控件；player/ 播放页组件；settings/ 设置分区
│   ├── hooks/                             # usePlayerEngine / usePlayResolution / useEpisodeList /
│   │                                      #   useLiveCatalog / useProxiedImage
│   ├── stores/appStore.ts                 # zustand：跨页共享态（cache/preferredSite/sidebarCollapsed）
│   ├── lib/                               # invoke（唯一 IPC）、pageCache、usePageState、playerPrefs、
│   │                                      #   sources、sourceCache、format、logger…（纯逻辑为主，
│   │                                      #   与被测模块同目录的 *.test.ts 也放这里）
│   └── types/luma.ts                     # 归一化契约 TS 侧
│
├── src-tauri/
│   ├── Cargo.toml / Cargo.lock  build.rs
│   ├── tauri.conf.json                    # frontendDist=../dist、window、bundle.targets=["nsis"]
│   ├── capabilities/default.json          # 权限白名单（只授 main 窗口）
│   ├── icons/                             # 各尺寸 ICO/PNG
│   ├── binaries/                          # [产物] externalBin 暂存（qjs-runner-<triple>.exe），gitignore
│   └── src/
│       ├── main.rs                        # 只调 luma_lib::run()
│       ├── lib.rs                         # #[path] 分层映射 + run() + 37 个 command 注册
│       ├── infra/                         # 底座：error/env/paths/process/netrules/http/
│       │                                  #   db/{mod,schema,meta,configs,favorites,history}
│       │                                  #   bridge/store/window
│       │                                  #   logging/{mod,writer,redact,ui,diagnostics,report}
│       └── domain/                        # 业务：config/play/parse/proxy/live/sniff/
│                                          #   config/{mod,derive,naming,import,github,refresh}
│                                          #   proxy/{mod,handlers,guard,playlist,tests}
│                                          #   clipboard/ghproxy/spider/{mod,cms,python,quickjs}
│
├── sidecars/                              # 随包分发的 sidecar
│   ├── py/  qjs-runner/                   # 源码（入库）；py/ 只执行第三方脚本：
│   │                                      #   main.py（stdio 协议）、pyspider.py、pyrun.py、
│   │                                      #   adapterlog.py、base/spider.py
│   ├── qjs-assets/                        # [入库资源] 8 个 JS 依赖 + manifest.json，SHA256 校验
│   ├── python-embed/                      # [产物] 3.11 embeddable + site-packages 第三方依赖，gitignore
│   │                                      #   dev/交付统一用它（bridge.rs::embedded_python 自动探测）
│   │                                      #   依赖由 tools/python-requirements.txt + prepare_runtime.py 重建
│
├── tests/
│   ├── frontend/                          # 跨模块契约单测（播放器生命周期、图标控件…）
│   ├── stub_server.py                     # e2e 用的 127.0.0.1 桩服务
│   ├── fixtures/
│   │   ├── manual/                        # 真实配置样本（不入库）
│   │   ├── configs/  spiders/            # 脱敏 fixture / py spider
│   │   └── media/                         # m3u8 / flv / mp4 / ts 解码与解析样本
│   └── offline/                           # 离线确定性检查（全部进 check.py）：contract_check、
│                                          #   py_compat_check、py_base_spider_check、adapter_isolation、
│                                          #   config_compat、capabilities_check
│
└── tools/                                 # 离线辅助脚本（不参与构建）
    ├── prepare_runtime.py                 # 重建 python-embed 等产物；含 Python 依赖安装 + .pth 修正
    ├── python-requirements.txt            # 随包 Python 第三方依赖固定清单（Crypto/requests/lxml…）
    ├── inspect_config.py                  # 离线解码配置（图种 / 方言），只读不发网络
    ├── check.py                           # 离线一键回归（9 项门禁）
    ├── run_probes.mjs                     # 窗口探针一键回归（唯一入口）
    ├── bundle_report.mjs                  # 前端体积对比
    ├── probes/                            # 窗口探针：probe_*.mjs（50 个，按功能命名）
    ├── diag/                              # 一次性排障：diag_*.mjs + dump_state.mjs
    ├── verify/                            # 严格验收：verify_*.mjs（带断言与截图）
    └── audit/                             # DOM/布局取证与全站扫描：audit_*.mjs、scan_*.mjs、scan_sources.py
```

## 3. Rust 后端分层（2026-11-11 物理归档）

27 个 `.rs` 原先 21 个平铺在 `src-tauri/src/` 根，`lib.rs` 一屏 `pub mod`。现按技术层归入两目录，用 `#[path = "…"]` 映射：

- **逻辑模块名不变**：仍是 `crate::error`、`crate::config`……所有 `use crate::foo` 与 `generate_handler!` 的 37 个 command 路径零改动 → 不会引发运行时 "command not found"（这是 Rust 分层最大的隐性雷区，编译期抓不到）。
- **分层规避双向依赖环**：`db ↔ store` 同放 `infra/`，`proxy ↔ spider` 同放 `domain/`，两组真实双向引用都不跨层。
- **这是物理分层，非依赖方向硬约束**。后续阶段再把 `crate::` 路径前缀化为 `crate::infra::*` / `crate::domain::*`，并把 command 与私有 helper 分离到 `commands/`（需逐个提升 helper 为 `pub(crate)`）。详见 `docs/ARCHITECTURE.md` 与 git history。

## 4. 各类文件放哪

| 类别 | 放置位置 | 说明 |
|---|---|---|
| 实现规格 | `docs/spec.md` | 单一文件、只写现状；历史看 `CHANGELOG.md` 与 git |
| 项目协作说明 | 根目录 `AGENTS.md` | 给 AI 协作者/维护者的当前规范（≤ 20 KB） |
| 真实配置样本 | `tests/fixtures/manual/` | 含外部地址，**不入库、不被代码引用** |
| 构造 fixture | `tests/fixtures/configs/` | 必须脱敏，网络目标只指向 `127.0.0.1` |
| 契约 | `contracts/` | 归一化契约唯一真源；TS 类型与 Rust 序列化两端一致（适配层只原样交回脚本结果） |
| 前端源码 | `src/` | React + TypeScript + Vite |
| Rust 宿主源码 | `src-tauri/src/{infra,domain}/` | 命令、进程管理、proxy、运行时，按层归档 |
| sidecar 源码 | `sidecars/{py,qjs-runner}/` | 入库；二进制产物目录见 §1 |
| 离线检查脚本 | `tests/offline/` | 契约、版本一致性、py 兼容、适配层协议等确定性检查，全部接进 `tools/check.py` |
| 阶段验收脚本 | `tests/acceptance/p0.py~p3.py` | 规格书 12.2 累积断言；stub 在 `tests/stub_server.py` |
| 前端单测 | 与被测模块同目录 `*.test.ts`（`src/lib`、`src/pages`、`src/stores`） | 只测本模块；不为了放测试而新建目录 |
| 跨文件约定测试 | `tests/frontend/` | 读源码文本断言「哪些文件里必须出现什么」，不属于任何单模块 |
| 窗口探针 | `tools/{probes,verify,diag,audit}/` | 靠 CDP 9222 取证的脚本，统一入口 `tools/run_probes.mjs` |
| 离线工具 | `tools/` | 不参与构建、不发网络请求的开发辅助脚本（`prepare_runtime.py` 例外，参与随包运行时准备） |
| 机制说明与专项报告 | `docs/`，文件名 ASCII kebab | 如 `js-support.md`、`size-report.md`；结论性长文不写进 `AGENTS.md`，只在其中留摘要与指针 |
| 对外说明与贡献流程 | 仓库根 `README.md` / `CONTRIBUTING.md` / `SECURITY.md` / `THIRD-PARTY-NOTICES.md` | 面向使用者与贡献者，不写内部过程 |

## 5. 编码约定

1. **所有文本文件一律 UTF-8 无 BOM**（含 `.md`/`.ts`/`.tsx`/`.rs`/`.py`/`.json`/`.toml`/`.gitignore`）。BOM 会破坏 shebang、JSON 解析与部分 Rust/TS 工具链。
2. **换行统一 LF**：已配置 `core.autocrlf=false`、`core.safecrlf=true`；二进制 fixture 与随包 JS 资源按 `.gitattributes` 保留原字节。
3. **禁止用 Windows 记事本「另存为」选 ANSI/GBK**：会写成带 BOM 或非 UTF-8，中文乱码。
4. **JSON 保存中文用 `ensure_ascii=False`**：中文以原字符写入，不写成 `\uXXXX`。
5. **Python 源码不写 coding 声明**：Python 3 默认 UTF-8。
6. **Rust/TS 标识符与字符串字面量一律 ASCII**，注释可中文；command 的 serde 字段按前端契约用 camelCase（如 `siteKey`），故 `store.rs` 等处 command 参数保留 camelCase 会有 `non_snake_case` 警告，属预期、不改。
7. **二进制样本例外**：`tests/fixtures/configs/image-seed.txt` 是 TVBox 图种（JPEG + base64），整体非 UTF-8，属预期。
8. **不再使用 `.gitkeep` 占位**：非空目录由真实文件自行保留；被 ignore 的产物目录不跟踪任何占位文件（历史 `.gitkeep` 已于 2026-11-11 全部清理，`prepare_runtime.py` 也不再生成）。

## 6. 命名约定

- 源码与配置文件：ASCII，小写蛇形 `snake_case`（`.rs`/`.py`）或小写 kebab `kebab-case`（目录、`.json`/`.toml`、前端文件名）。
- 禁止中文文件名、空格、大写开头与盘符/绝对路径写进源码。
- 文档文件名用 ASCII，标题与正文用简体中文；实现规格是单一文件 `docs/spec.md`，不按版本号切分。

## 7. 不入库（.gitignore）范围

| 目录 / 文件 | 原因 |
|---|---|
| `tests/fixtures/manual/`、`docs/verification-config.md` | 真实配置样本与抓取记录，含外部地址，规格书禁止内置 |
| `dist/`、`src-tauri/target/`、`src-tauri/target/release/bundle/` | 三类编译/交付产物，均可重建（见 §1） |
| `src-tauri/gen/` | Tauri 生成的 schema 与中间产物 |
| `sidecars/python-embed/`、`src-tauri/binaries/` | 随包运行时/二进制产物，由 `prepare_runtime.py` 重建 |
| `node_modules/` | 前端依赖，由 pnpm 锁文件重建 |
| `*.log`、`pnpm-debug.log*` | 运行日志，可能含密钥/外部地址 |
| `.DS_Store`、`Thumbs.db` | 系统元数据 |

配套规则：

- 根目录 `.gitignore` 已覆盖上述规则，文件本身 UTF-8 无 BOM、LF。
- 被 ignore 的目录整目录忽略，**不保留、不生成 `.gitkeep`**；`prepare_runtime.py` 重建产物目录后也不补占位。
- **不要**为「让样本进仓库」加 `!` 反忽略规则；自动化 fixture 只能放 `tests/fixtures/configs/`，且必须脱敏为指向 `127.0.0.1` 的自造样本。
- 密钥、token、用户本机提供的 jar、抓取缓存一律不入库、不回显。

## 8. 与既有文档的关系

- 本文是目录/产物/编码约定的权威；`AGENTS.md` 的「目录结构」段只指向本文，不另抄一份，避免两处漂移。
- 工程实现以本地 `docs/spec.md` 为唯一依据；若本文与规格冲突，按 `AGENTS.md`「本地需求文档优先」处理。
