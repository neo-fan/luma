# 测试与回归约定

> 目标：新增一个用例时不用问「放哪」。四层各管一段，命令与目录一一对应。
> 目录归口见 `docs/project-layout.md` §4；发版验收清单在 `docs/RELEASING.md`。

## 1. 四层模型

| 层 | 放哪 | 入口 | 什么时候跑 |
|---|---|---|---|
| 单测（前端） | 被测模块同目录 `*.test.ts` | `corepack pnpm test` | 每次改前端 |
| 单测（Rust） | 同文件 `#[cfg(test)] mod tests` | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | 每次改 Rust |
| 离线检查 | `tests/offline/` | `python tools/check.py` | **每次改动的最低门槛** |
| 阶段验收 | `tests/acceptance/p0.py~p3.py` | 单独执行（可带 `--offline`） | 改 sidecar / 打包前 |
| 窗口探针 | `tools/{probes,verify,diag,audit}/` | `node tools/run_probes.mjs` | 改 UI / 播放 / 配置链路后 |

一句话边界：**能离线判定对错的进 `tests/`，必须靠真实窗口才能取证的进 `tools/`。**

## 2. 目录约定

```text
src/lib/*.test.ts          # 前端单测：与被测模块同目录，import "./模块名"
src/pages/*.test.tsx
src/stores/*.test.ts
src-tauri/src/**/*.rs      # Rust 单测内联在同文件 #[cfg(test)] mod tests
src-tauri/tests/           # 目前为空（没有跨 crate 集成测试就不建）

tests/
  stub_server.py           # 共享桩服务（离线检查与阶段验收共用）
  fixtures/                # 测试输入：configs / spiders / media / manual
  frontend/                # 跨文件约定测试（readFileSync 读源码文本，断言"哪些文件里必须出现什么"）
  offline/                 # 离线确定性检查，全部进 tools/check.py
    contract_check.py      #   schema ↔ TS ↔ Rust ↔ Python 字段对齐
    capabilities_check.py  #   Tauri 权限闭集
    py_compat_check.py     #   TVBox py 脚本通用兼容
    py_base_spider_check.py#   py 框架与 base.spider 原生行为对齐
    adapter_isolation.py   #   适配层车道隔离 / 坏帧回帧 / 编码
    parse_check.py         #   CMS 解析池与站点字段透传
    parse_epg_check.py     #   XMLTV 解析
    config_compat.py       #   真实 box.json 形态（相对地址、base.spider）
    config_shapes_check.py #   T-05：六种配置形状端到端
  acceptance/              # spec 12.2 阶段验收，累积断言，未交付能力标 N/A
    p0.py p1.py p3.py      # p2.py（jar/JVM 回归）已随 JVM 运行时移除

tools/
  probes/                  # 窗口回归探针（每个文件自己断言，失败 exit 1）
    lib/cdp.mjs            #   新探针共用的最小 CDP 客户端（连接/求值/真实点击/截图）
  verify/  diag/  audit/   # 一次性验收 / 证据打印 / 静态走查（diag 不断言）
```

窗口探针的两种写法：早期 49 个探针各自内联一份 `Cdp` 类（自包含、复制粘贴）；
**新探针一律 `import { connect, finish } from "./lib/cdp.mjs"`**，断言留在探针里。

## 3. 判断该放哪

- 纯函数 / 组件行为、不碰网络与真实窗口 → **单测**，放在模块旁边。
- 断言「仓库里某几个文件必须保持某种写法」（比如控件必须来自 lucide、页面必须保留某个 DOM 结构）→ `tests/frontend/`，它读的是源码文本，不属于任何单模块。
- 起进程、跑 stub server、验证三端字段一致、验证适配层协议 → `tests/offline/`，并接进 `tools/check.py`。
- 按规格书 12.2 逐阶段验收（会跑 stub、可能要求窗口）→ `tests/acceptance/pN.py`。
- 需要 CDP 9222 才能取证（DOM 尺寸、截图、真实点击）→ `tools/` 下的探针。

## 4. 硬约束

1. **离线检查必须真的离线**：不访问公网，fixture 只指向 `127.0.0.1`。
2. **新增离线检查要同时改两处**：`tools/check.py` 的 `checks()` 与 `docs/MAINTENANCE.md` §2 的覆盖清单；`--ci` 子集只放「干净机器能跑」的项。
3. **阶段验收不进 CI**：它依赖运行中的应用与 stub，留在发版手工清单。
4. **探针会切后端 active 配置的，cleanup 必须 `location.reload()`**（见 `AGENTS.md` 工程铁律 7）。
5. 跑 `cargo test` 前先结束残留的 `qjs-runner` 进程：`tauri-build` 每次构建都要覆盖 `target/debug/qjs-runner.exe`，被占用会报 `os error 5 拒绝访问`。
6. 若本会话的 `TEMP` 指向仓库内目录，Rust 单测里建子目录会因 ACL 失败（`create data dir failed`），改用系统临时目录（`$env:TEMP`）或仓库外的可写目录；**不要把临时目录建进仓库**。

## 5. 现状基线

`python tools/check.py` 8/8、`pnpm test` 364（45 个文件）、`cargo test --lib` 157 passed / 1 ignored。
数字随提交变化，以 `AGENTS.md`「当前状态」为准。
