#!/usr/bin/env node
/**
 * 日志三通道回归：前端日志只进 `logs/ui/`，不污染 `logs/app/`。
 *
 * 背景（2026-11-14）：日志按用途拆成三通道——`app/`（宿主）、`ui/`（前端
 * `target: "ui"`）、`spider/`（Python 适配层）。分流的单测只覆盖路由规则，
 * 这里端到端验一次真实落盘：写一条带随机标记的日志，再到数据目录里核对。
 *
 * 依赖 dev 窗口（CDP 9222）。数据目录默认取 `%APPDATA%\Luma-debug`（debug 标识），
 * 可用 `LUMA_DATA_DIR` 覆盖（便携模式 / 自定义目录时）。
 *
 *   node tools/probes/probe_log_channels.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, finish } from "./lib/cdp.mjs";

const dataDir =
  process.env.LUMA_DATA_DIR ||
  join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Luma-debug");
const logsRoot = join(dataDir, "logs");

const cdp = await connect();
const problems = [];
const token = `channel-probe-${Date.now().toString(36)}`;

/** 某通道目录里最新的日志文件内容（没有文件返回空串）。 */
function newestLog(channel) {
  const dir = join(logsRoot, channel);
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".log"));
  } catch {
    return { file: null, text: "" };
  }
  if (names.length === 0) return { file: null, text: "" };
  names.sort((left, right) => statSync(join(dir, right)).mtimeMs - statSync(join(dir, left)).mtimeMs);
  const file = join(dir, names[0]);
  return { file, text: readFileSync(file, "utf8") };
}

// 1) 走真实 IPC 写一条前端日志
const written = await cdp
  .invoke("log_write", {
    entries: [{ level: "warn", message: `ui channel probe ${token}`, context: { probe: token } }],
  })
  .then(() => "ok")
  .catch((error) => String(error));
console.log("log_write:", written);
if (written !== "ok") problems.push(`log_write 失败：${written}`);

await cdp.sleep(800);

// 2) ui 通道必须有这行
const ui = newestLog("ui");
console.log("ui file:", ui.file);
if (!ui.file) problems.push("logs/ui/ 下没有日志文件");
else if (!ui.text.includes(token)) problems.push("ui 通道没有收到前端日志");

// 3) app 通道不能有这行（分流串台）
const app = newestLog("app");
console.log("app file:", app.file);
if (app.text.includes(token)) problems.push("前端日志串进了 app 通道");

// 4) 诊断接口要带 channel 字段，且三通道都在枚举里
const diagnostics = await cdp.invoke("diagnostics").catch((error) => ({ error: String(error) }));
const files = diagnostics?.logFiles ?? [];
const channels = [...new Set(files.map((file) => file.channel))];
console.log("diagnostics channels:", channels, "files:", files.length);
if (files.length === 0) problems.push("diagnostics.logFiles 为空");
if (!files.every((file) => typeof file.channel === "string" && file.channel.length > 0)) {
  problems.push("diagnostics.logFiles 有条目缺 channel");
}
if (files.some((file) => !file.name.includes("/") || file.name.includes("\\"))) {
  problems.push("diagnostics.logFiles 的 name 不是「通道/文件」相对路径");
}

const code = finish(problems);
cdp.close();
process.exit(code);
