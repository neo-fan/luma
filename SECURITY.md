# 安全策略（SECURITY）

## 支持范围

| 版本 | 状态 |
|---|---|
| `1.0.x` | 接受安全报告 |
| `< 1.0` | 不再维护 |

## 如何报告

**请不要开公开 issue。** 优先用 GitHub 的 Private vulnerability reporting（仓库
`Security` 标签页 → `Report a vulnerability`）；如果不可用，发邮件到
`<security@example.com>`（占位，维护者替换为真实地址）。

报告里请包含：影响版本、复现步骤、受影响组件（Rust 宿主 / Python 适配层 /
qjs-runner / 反代 / 前端）、以及你能提供的日志片段。**不要贴真实配置地址、
播放直链或任何 token** —— 日志脱敏规则见下。

我们会在 7 天内确认收到，30 天内给出修复计划或说明。

## 安全模型（先理解边界）

这是一个**本地桌面应用**，它的威胁模型和 Web 服务不同：

1. **导入的配置与脚本是不可信代码。** Python 源脚本在独立 sidecar 进程里执行，
   JS 源在 `qjs-runner` 进程里执行，jar 源直接屏蔽。sidecar 崩溃不会带走主进程，
   但它们**不是**安全沙箱：恶意 py 脚本能读写当前用户有权限的文件、能发网络请求。
   这是 TVBox 生态的固有属性，导入任何第三方配置前请自行判断来源。
2. **本地反代只监听 `127.0.0.1`**（默认 `9978`），带 SSRF 防护：
   默认拒绝回环 / 链路本地 / 私网目标，只有显式设置 `LUMA_PROXY_ALLOW_LOCAL=1`
   才允许访问 `127.0.0.1`（供本地联调）。
3. **第 4 级嗅探窗口零权限**：隐藏的 `sniffer-*` WebView2 不在
   `capabilities/default.json` 的 `windows` 列表里，没有任何 Tauri command 权限，
   只用 `WebResourceRequested` 观察媒体请求。
4. **没有遥测/上传**：不收集使用数据，不上传配置；日志只写本机。
5. **日志脱敏**：URL 只记 `scheme + host + path`，查询参数（token / 签名）与
   播放直链不落盘。

## 已知的、明确接受的风险

- `tauri.conf.json` 的 `security.csp` 为 `null`（未启用 CSP）。当前前端不注入远程
  HTML、不使用 `dangerouslySetInnerHTML` / `eval`，因此没有直接利用面；但这意味着
  一旦出现 XSS，没有第二道防线。见 `docs/ARCHITECTURE.md`。
- 安装器未做代码签名，首次运行会触发 SmartScreen。正式分发需要 OV/EV 证书。
- `sidecars/qjs-assets/` 内含第三方 JS（含授权不明的 `drpy2.min.js`），它们是
  被当作**数据/引擎**加载的，不是本项目的代码；风险与来源见
  `THIRD-PARTY-NOTICES.md`。
- mpv 兜底会把播放地址透传给外部进程；mpv 自身的安全问题不在本项目范围内。
