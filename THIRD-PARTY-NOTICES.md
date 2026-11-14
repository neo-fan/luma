# 第三方组件与许可（THIRD-PARTY-NOTICES）

> 本仓库**自己的代码**的许可见 `LICENSE`（当前为占位符，All rights reserved）。
> 本文件只记录**随仓库分发的第三方内容**的来源、校验值与授权状态。

## 1. `sidecars/qjs-assets/`（随包 JS 运行库）

这些文件是 **TVBox 生态的 JS 引擎与其依赖**，从上游仓库 `cluntop/tvbox`
固定提交 `a08e4fe8f3e6c74ad8185f2ba3eef1a0c3d48bf8` 逐字节抓取，**未做任何修改**。
字节数与 SHA256 见 `sidecars/qjs-assets/manifest.json`，`python tools/prepare_runtime.py --check` 会校验。

| 文件 | 上游路径 | 字节 | 授权状态 |
|---|---|---:|---|
| `cheerio.min.js` | `lib/cheerio.min.js` | 356,588 | MIT（cheerio，上游未随文件附带声明） |
| `crypto-js.js` | `lib/crypto-js.js` | 204,310 | MIT（crypto-js） |
| `node-rsa.js` | `lib/node-rsa.js` | 167,481 | MIT（node-rsa） |
| `pako.min.js` | `lib/pako.min.js` | 46,859 | MIT（pako） |
| `json5.js` | `lib/json5.js` | 60,431 | MIT（JSON5） |
| `jinja.js` | `lib/jinja.js` | 22,706 | **未声明**（上游未给出许可证与来源） |
| `gbk.js` | `lib/gbk.js` | 56,313 | **未声明**（上游未给出许可证与来源） |
| `template.js` | `js/template.js` | 15,217 | **未声明**，且上游仓库该路径已不可达（我们按固定提交留档） |
| `drpy2.min.js` | `lib/drpy2.min.js` | 67,385 | **未声明**；这是第三方 TVBox JS 引擎本体 |

### 已知风险与处理

1. **`drpy2.min.js` / `template.js` / `gbk.js` / `jinja.js` 授权不明。** 这四个文件
   在上游仓库中没有许可证声明，法律上默认「保留所有权利」。当前保留它们只为
   兼容真实配置所需（离线兜底），**不代表我们对其再分发有授权**。
   如果权利方提出异议，会在下一个版本移除，改为「首次使用时由用户自行下载」。
2. **MIT 组件缺少版权头。** `cheerio` / `crypto-js` / `node-rsa` / `pako` / `json5`
   的压缩产物被上游去掉了许可证注释。按 MIT 要求，再分发应保留版权与许可声明，
   因此这里以「组件名 + 上游 URL + 许可证类型」的形式补充声明；正式发布前建议
   从各项目仓库取回 LICENSE 原文一并附上。
3. **这些文件不是本项目的代码**，不适用 `LICENSE`；对它们的使用风险由使用者承担。

## 2. Rust 依赖（`src-tauri/Cargo.lock`、`sidecars/qjs-runner/Cargo.lock`）

由 Cargo 管理，许可证以各 crate 自带的 `LICENSE*` 为准。第三方 crate 主要来自
Tauri 生态（MIT / Apache-2.0 双许可为主）与 `tokio` / `axum` / `reqwest` /
`rusqlite`（MIT 或 MIT/Apache-2.0）。二进制分发时需保留其许可声明，建议在
发布流程里用 `cargo deny` 或 `cargo about` 生成完整清单。

## 3. 前端依赖（`pnpm-lock.yaml`）

React、Vite、ArtPlayer（MIT）、hls.js（Apache-2.0）、mpegts.js（Apache-2.0）、
Radix UI（MIT）、cmdk（MIT）、sonner（MIT）、lucide-react（ISC）、zustand（MIT）、
react-router（MIT）等。许可证以各包 `package.json` 的 `license` 字段为准。

## 4. 随包 Python 运行时（`sidecars/python-embed/`，不入库）

由 `tools/prepare_runtime.py` 按 `tools/python-requirements.txt` 安装，包含
`requests` / `urllib3` / `lxml` / `pyquery` / `cssselect` / `pycryptodome` /
`cryptography` / `beautifulsoup4` 等。均为 Apache-2.0 / BSD / MIT 系许可，
随安装器分发时应附其许可文本（Python 自身的 PSF 许可证同样适用）。

## 5. 不随仓库分发的内容

- 随包 mpv 已在 1.0.3 移除，本项目不再分发 GPL-2.0+ 的 mpv。
- JVM 运行时（jlink 裁剪的 OpenJDK 17 / `runner.jar`）也已在 1.0.3 移除，不再涉及 GPL-2.0 + Classpath Exception 的再分发。
