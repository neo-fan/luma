# TVBox 桌面客户端 · 实现规格书 v1.1 修订说明（CHANGELOG）

> 日期：2026-11-08
> 对象：<<internal design doc>>（doc 节点 `aJ5N61nUGzZS42QCOSOl4D`）
> 输入：`docs/archive/SPEC_REVIEW.md`（原根目录，2026-11-14 归档）的 11 条修订建议（R1~R11）与 5 个决策；用户已确认「全按推荐」。
> 本文件是本地修订稿的变更说明；逐条可粘贴文本见同目录 `replacements.md`。

---

## 一、v1.0 → v1.1 变更摘要（11 条）

| 条目 | 变更（各一句话） |
| --- | --- |
| R1（阻断，采纳） | 12.2 改为按阶段「累积断言矩阵」，未交付能力标 `N/A` 不计 FAIL，`p0.py` 不再被要求覆盖 P1~P3 才有的能力。 |
| R2（采纳） | 7.1 的 7 个 command 定为唯一真源，删除第 5 节目录树与 4.1 拓扑图里写死的数量、补上漏掉的 `config_remove`。 |
| R3（采纳） | T-14 改为「11 个业务方法 + `ping`」逐方法断言，并明确区分 6.2 `SpiderMethod`(6) / 7.2 协议方法(11) / 8.4 Spider API(12) 三套集合，数量不再互相套用。 |
| R4（方案 A） | JS 下沉为独立 `qjs-runner` sidecar，由 Rust `process.rs` 统一拉起并纳入 Job Object，主进程不执行第三方 JS。 |
| R5（采纳） | Rust `process.rs` 为唯一拉起主体，删除 `capabilities` 里的 `shell:allow-spawn`，sidecar 清单集中到 13 节 `externalBin`。 |
| R6（线程池） | Python 主循环采用 `ThreadPoolExecutor(max_workers=8)`，新增 7.2.1「并发与取消语义」定义 id 单调 / epoch / 取消帧 / 崩溃重启 / 迟到帧回收。 |
| R7（目标白名单） | 保留 9978 默认端口、不做一次性 token，新增 7.5.1 动态端口注入表，并定义 SSRF 目标白名单与请求限制。 |
| R8（轻量方案） | `AppError` 补 `rawSaved` / `details` 字段，新增 `contracts/tvbox.schema.json` 为唯一真源 + `tests/e2e/contract_check.py` 校验脚本，不引入新依赖。 |
| R9（采纳） | 「目标 jar」定义为 `tests/fixtures/jars/` 下的自编模板 jar（class / dex 两种形态），跑通率量化为模板 jar 100%，不对第三方 jar 作承诺。 |
| R10（采纳） | JDK 统一 17（开发 / 编译 / `jlink` 裁剪），不探测、不兼容 JDK 8。 |
| R11（方案 A） | Python 随包分发，T-32 的「按需版 ≤25MB」改为 `docs/size-report.md` 实测口径（v1.1 按需版目标 ≤45MB，含 Python embeddable 与前端产物）。 |

> 无争议、直接采纳：R1、R2、R3、R5、R9、R10；带决策的：R4、R6、R7、R8、R11（见第二节）。

---

## 二、5 个决策的最终选择与理由

| # | 决策 | 最终选择 | 理由 | 影响条目 |
| --- | --- | --- | --- | --- |
| 1 | JS 隔离：A 下沉 sidecar / B 进程内 + 中断回调 | **A：JS 下沉为独立 `qjs-runner` sidecar** | 让 11.2「一律子进程隔离」真正成立；进程内 `rquickjs` 无法强杀 native 死循环 / 段错误，与 10 节「进程级可强杀」互斥；且与 R5「Rust 唯一拉起」天然一致，隔离 / 超时 / 崩溃恢复一次闭环。代价是多一个可执行文件，已在 13 节 `externalBin` 登记。 | R4、R5、T-16、4.1、3.2、第 5 节、10 节、11.2、13 节 |
| 2 | Python 并发：线程池 / 多常驻进程池 | **线程池（`ThreadPoolExecutor`，`max_workers = 8`）** | GIL 下短 JSON 计算任务可接受，改动小、内存与进程管理成本低，先落地；补 7.2.1 的取消 / epoch / id 语义即可闭环 20 源 fan-out。多常驻进程池隔离更好但成本翻倍，本版不采用。 | R6 的 7.2.1、T-13 / T-17、4.3、10 节 |
| 3 | proxy 加固：目标白名单 / 一次性 token | **目标白名单，保留 9978 默认端口，不做一次性 token** | 不破坏第三方 spider 硬编码 `127.0.0.1:9978` 的生态兼容性；一次性 token 会让硬编码 URL 全部失效，属已知兼容性损失。新增 7.5.1 注入表，端口占用且无法注入时降级为「代理不可用 + 源级灰显」。一次性 token 不纳入 v1.1。 | R7、11.2、7.5 / 7.5.1、T-08 / T-25 |
| 4 | 25MB 指标：放宽为实测（Python 随包）/ Python 也按需下载 | **放宽为实测口径（Python 随包）** | Python 是 T-05（P0）`config.decrypt` / `config.normalize` 的必备依赖，若按需下载则 P0 离线闭环不成立，且首启下载违反 0 节「测试网络目标只能是 127.0.0.1」。改为 `docs/size-report.md` 实测，v1.1 按需下载版目标 ≤45MB。 | R11、T-32、13 节、第 5 节 |
| 5 | 契约一致性：轻量校验脚本 / 引入代码生成链 | **轻量校验（补字段 + schema + `contract_check.py`），不引入新依赖** | 0 节第 3 条规定新增依赖须单独批准；完整代码生成链需 `json-schema-to-typescript` / `typify` 等依赖，本版不默认采用。轻量方案即可消除 `rawSaved` 字段漂移，并作为 T-04 / T-13 必跑断言。 | R8、6.2、T-04 / T-13 |

---

## 三、按章节的改动清单

| 章节 | 改什么 |
| --- | --- |
| 文首 | 版本号 v1.0 → v1.1，新增「v1.1 修订说明」段（列出改动章节与决策结论）。 |
| 0 节 | 第 1 条补 `N/A` 门禁语义；第 6 条补「目标 jar」定义（自编模板 jar，不入库）。 |
| 2 节 / 3.2 / 3.3 | JDK 统一 17；`rquickjs` 用途随 R4 改为「JS sidecar 内运行时」；Python 随包口径保持不变。 |
| 4.1 / 4.3 / 5 | 拓扑图补 `config_remove`、JS sidecar 化、`process.rs` 为唯一拉起主体；数据流补 7.2.1 约束；目录树补 `contracts/`、`qjs-runner/`、`tests/fixtures/jars/`、`size-report.md`，并改 `commands.rs` / `quickjs.rs` 注释。 |
| 6.2 / 7.1 / 7.2 / 7.5 | `AppError` 补字段 + schema 真源；command 清单唯一真源；方法集合区分 + 新增 7.2.1；proxy 白名单 + 新增 7.5.1 注入表。 |
| 8.4 / 8.5 | 8.4 明确为 Spider API(12) 并区分三套集合；8.5 保持不变。 |
| 9 节 | T-03、T-04、T-08、T-11、T-13、T-14、T-16、T-17、T-19、T-20、T-23、T-25、T-27、T-32 的验收列（T-23 另含任务列）。 |
| 10 节 | 超时行覆盖 py/js/jar；并发行与 7.2.1 对齐。 |
| 11.1 / 11.2 | 删 `shell:allow-spawn`、明确 Rust 唯一拉起；11.2 第一条按 R4 方案 A 重写、第二条按 R7 白名单重写。 |
| 12.2 / 13 / 14 | 12.2 替换为累积断言矩阵（富文本表）；13 节 `externalBin` 列全部 sidecar + 体积报告；14 节 jar 跑通率量化与首行兜底。 |

---

## 四、v1.1 新增的工程文件

以下为 v1.1 规格新增 / 规划的工程文件，**当前均尚未创建**；`capabilities/default.json`、`tauri.conf.json` 等属于修改而非新增。

| 路径 | 用途 | 关联 |
| --- | --- | --- |
| `contracts/tvbox.schema.json` | 归一化契约唯一真源，`src/types/tvbox.ts` / `error.rs` 的 serde struct / Python 输出字段与之对齐 | R8 |
| `tests/e2e/contract_check.py` | 比对三端字段名，作为 T-04 与 T-13 的必跑断言 | R8 |
| `sidecars/qjs-runner/` | JS sidecar：独立可执行文件，内部 `rquickjs` 每请求新建 context、不共享 | R4 |
| `docs/size-report.md` | T-32 前产出，逐项列出主程序 / 前端产物 / Python embeddable / JRE / mpv 的实测体积（压缩前 / 后） | R11 |
| `tests/fixtures/jars/template-class.jar` | 自编纯 class 形态模板 jar，作为 T-20 `javap` 守恒与 T-23 跑通率基准 | R9 |
| `tests/fixtures/jars/template-dex.jar` | 自编 dex 形态模板 jar，同上 | R9 |

> 另：`qjs-runner` 需在 `tauri.conf.json` 的 `externalBin` 注册；`tests/e2e/p0.py ~ p3.py` 为 v1.0 已有脚本，v1.1 仅更新其累积断言语义，非新增文件。

---

## 五、状态说明（2026-11-08 收尾后）

- **全部在本地**：用户明确「不用改云端规格书，全部在本地」。本目录（`CHANGELOG.md` + `replacements.md`）即为 v1.1 的**唯一实现依据**；云端 doc 节点在历史流程中曾被写入 v1.1（40/40 条直接编辑、无待接受卡片），但只读参考、不再写入、不作为依据。是否回滚云端由用户决定。
- v1.0 原文逐字节归档在 `docs/spec-v1.0/spec-v1.0-raw.md`（161426 字节）；`cloud-actions.json` 为那次云端写入的审计记录，只作留档。
- 已用 Git 管理（`main` 分支，初始基线已提交）；真实配置样本与抓取记录不入库；目录与编码约定见 `docs/project-layout.md`；`AGENTS.md` 已同步为本地基线。
- **仍未开工、未建代码**：只有文档、目录骨架与 `tools/inspect_config.py` 一个离线脚本；无源码、无构建脚本、无依赖。
- 下一步：按 P0 / T-01 起建工程；按 `docs/archive/verification-report.md` 第 5 节构造 6 类脱敏 fixture（全部指向 `127.0.0.1`）。
