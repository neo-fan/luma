#!/usr/bin/env node
/**
 * bundle_report.mjs — 构建产物体积报告（纯 Node ESM，仅用内置模块）
 *
 * 用到的内置模块：node:fs、node:zlib、node:path（未引入任何第三方依赖）。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node tools/bundle_report.mjs
 *       打印 dist/assets/ 下所有 .js / .css 的体积表与总计。
 *
 *   node tools/bundle_report.mjs --out <path>
 *       额外把当前报告写成 JSON，可作为下次的 --baseline 输入。
 *       父目录不存在会自动创建；文件 UTF-8 无 BOM、LF 换行。
 *
 *   node tools/bundle_report.mjs --baseline <json文件路径>
 *       读取一份「同格式 JSON」（即本脚本 --out 生成的文件）作为对比基线，
 *       逐 chunk 输出 gzip / raw 的增减百分比与差值，并输出总计变化。
 *       基线里存在而当前没有的 chunk 标 [移除]，当前新增的标 [新增]。
 *
 *   node tools/bundle_report.mjs --baseline old.json --out new.json
 *       对比 + 落盘可一起用。
 *
 *   node tools/bundle_report.mjs -h | --help
 *       打印本用法并正常退出。
 *
 * ── 行为细节 ────────────────────────────────────────────────────────────
 *   - 项目根 = 本脚本所在目录（tools/）的上一级，故可从任意 cwd 运行。
 *   - 递归读取 <项目根>/dist/assets/ 下所有 .js 与 .css（含子目录），
 *     忽略 .map 等其它文件。
 *   - raw  = 文件字节数（读到的 Buffer 长度）。
 *     gzip = node:zlib gzipSync 默认压缩级别后的字节数。
 *   - 表格按 gzip 字节降序，大小相同再按路径升序。
 *   - JS / CSS 分开统计总计，并额外给出 all 合计。
 *   - 路径一律相对项目根，且统一用 "/" 分隔（跨平台一致）。
 *   - dist/assets/ 不存在时打印清晰提示并以退出码 1 结束。
 *
 * ── JSON 字段（--out 输出，也是 --baseline 期望的格式）──────────────────
 *   {
 *     "version": 1,                       // 结构版本号
 *     "assetsDir": "dist/assets",         // 相对项目根的产物目录（信息用）
 *     "chunks": [                         // 按 gzip 降序
 *       {
 *         "path": "dist/assets/index-xxxx.js",  // 相对项目根，统一 "/" 分隔
 *         "kind": "js",                   // "js" | "css"
 *         "raw": 937625,                  // 原始字节
 *         "gzip": 271234                  // gzip 后字节
 *       }
 *     ],
 *     "totals": {
 *       "js":  { "raw": 937625, "gzip": 271234, "count": 1 },
 *       "css": { "raw":  14319, "gzip":   3712, "count": 1 },
 *       "all": { "raw": 951944, "gzip": 274946, "count": 2 }
 *     }
 *   }
 *   基线匹配以 chunk.path 为键；百分比 = (当前 - 基线) / 基线，基线为 0 时记 n/a。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const VERSION = 1;
const ASSETS_REL = "dist/assets";
const NUM_W = 12;

// 仅凭脚本自身位置定位项目根，不依赖 cwd。
const SCRIPT_PATH = resolve(process.argv[1] || "tools/bundle_report.mjs");
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const ASSETS_DIR = join(ROOT, "dist", "assets");

const HELP = `用法:
  node tools/bundle_report.mjs [--baseline <json>] [--out <json>] [--help]

  --baseline <json>  读取本脚本 --out 生成的 JSON 作为基线，逐 chunk 输出
                      gzip / raw 的增减百分比、差值及总计变化。
  --out <json>       把当前报告写成 JSON（UTF-8 无 BOM、LF），供下次对比。
  -h / --help        打印本帮助。

  未传任何参数时只打印体积表与 JS / CSS / ALL 总计。
  字段定义见本文件头部注释。`;

function die(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { baseline: null, out: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--baseline" || arg === "--out") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        die(`${arg} 需要一个文件路径。\n\n${HELP}`);
      }
      opts[arg === "--baseline" ? "baseline" : "out"] = value;
      i += 1;
    } else {
      die(`未知参数：${arg}\n\n${HELP}`);
    }
  }
  return opts;
}

function collectFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full));
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (ext === ".js" || ext === ".css") {
        files.push(full);
      }
    }
  }
  return files;
}

function toChunk(file) {
  const buf = readFileSync(file);
  return {
    path: relative(ROOT, file).split(sep).join("/"),
    kind: extname(file) === ".css" ? "css" : "js",
    raw: buf.length,
    gzip: gzipSync(buf).length,
  };
}

function byGzipDesc(a, b) {
  return b.gzip - a.gzip || a.path.localeCompare(b.path);
}

function buildReport(chunks) {
  const js = { raw: 0, gzip: 0, count: 0 };
  const css = { raw: 0, gzip: 0, count: 0 };
  for (const chunk of chunks) {
    const bucket = chunk.kind === "css" ? css : js;
    bucket.raw += chunk.raw;
    bucket.gzip += chunk.gzip;
    bucket.count += 1;
  }
  const all = {
    raw: js.raw + css.raw,
    gzip: js.gzip + css.gzip,
    count: js.count + css.count,
  };
  return {
    version: VERSION,
    assetsDir: ASSETS_REL,
    chunks,
    totals: { js, css, all },
  };
}

function num(value) {
  return value.toLocaleString("en-US");
}

function printReport(report) {
  console.log(`\nBundle report — ${report.assetsDir}/  (相对项目根，按 gzip 降序)`);
  console.log("");
  console.log(`${"GZip (B)".padStart(NUM_W)}  ${"Raw (B)".padStart(NUM_W)}   Path`);
  console.log(`${"-".repeat(NUM_W)}  ${"-".repeat(NUM_W)}   ${"-".repeat(40)}`);
  for (const chunk of report.chunks) {
    console.log(
      `${num(chunk.gzip).padStart(NUM_W)}  ${num(chunk.raw).padStart(NUM_W)}   ${chunk.path}  [${chunk.kind}]`,
    );
  }
  console.log("\nTotals");
  for (const kind of ["js", "css", "all"]) {
    const t = report.totals[kind];
    console.log(
      `  ${kind.toUpperCase().padEnd(3)} : raw ${num(t.raw).padStart(NUM_W)} B   gzip ${num(t.gzip).padStart(NUM_W)} B   ${t.count} file(s)`,
    );
  }
}

function pct(current, base) {
  if (base === 0) return current === 0 ? "0.00%" : "n/a";
  const value = ((current - base) / base) * 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function diff(current, base) {
  const value = current - base;
  return `${value > 0 ? "+" : ""}${num(value)}`;
}

function metric(current, base) {
  return `${pct(current, base).padStart(8)}  (${num(base)} → ${num(current)}, Δ${diff(current, base)})`;
}

function printComparison(report, baselinePath) {
  const abs = resolve(baselinePath);
  if (!existsSync(abs)) {
    die(`基线文件不存在：${abs}`);
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    die(`无法解析基线 JSON：${abs}\n${err.message}`);
  }
  if (!baseline || !Array.isArray(baseline.chunks) || !baseline.totals) {
    die(`基线 JSON 不是本脚本 --out 生成的格式：${abs}`);
  }
  if (!baseline.totals.all) {
    const js = baseline.totals.js || { raw: 0, gzip: 0 };
    const css = baseline.totals.css || { raw: 0, gzip: 0 };
    baseline.totals.all = {
      raw: js.raw + css.raw,
      gzip: js.gzip + css.gzip,
    };
  }

  const baseChunks = new Map(baseline.chunks.map((c) => [c.path, c]));
  const curChunks = new Map(report.chunks.map((c) => [c.path, c]));

  console.log(`\nComparison vs baseline — ${baselinePath}`);
  console.log("  %Δ = (当前 - 基线) / 基线；分列 gzip 与 raw\n");
  for (const chunk of report.chunks) {
    const base = baseChunks.get(chunk.path);
    if (!base) {
      console.log(`  [新增] ${chunk.path}  gzip ${num(chunk.gzip)} B  raw ${num(chunk.raw)} B`);
      continue;
    }
    console.log(`  ${chunk.path}`);
    console.log(`     gzip ${metric(chunk.gzip, base.gzip)}`);
    console.log(`     raw  ${metric(chunk.raw, base.raw)}`);
  }
  for (const base of baseline.chunks) {
    if (!curChunks.has(base.path)) {
      console.log(`  [移除] ${base.path}  (基线 gzip ${num(base.gzip)} B  raw ${num(base.raw)} B)`);
    }
  }

  console.log("\n  Totals change:");
  for (const kind of ["js", "css", "all"]) {
    const current = report.totals[kind];
    const base = baseline.totals[kind] || { raw: 0, gzip: 0 };
    console.log(`    ${kind.toUpperCase().padEnd(3)}  gzip ${metric(current.gzip, base.gzip)}`);
    console.log(`         raw  ${metric(current.raw, base.raw)}`);
  }
}

function writeReport(report, outPath) {
  const abs = resolve(outPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n已写出 JSON：${abs}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }

  if (!existsSync(ASSETS_DIR)) {
    die(
      `未找到产物目录：${ASSETS_DIR}\n` +
        `请先执行构建（例如 corepack pnpm build 或 vite build）生成 dist/assets/ 后再运行本脚本。`,
    );
  }

  const chunks = collectFiles(ASSETS_DIR).map(toChunk).sort(byGzipDesc);
  const report = buildReport(chunks);

  printReport(report);

  if (opts.baseline) {
    printComparison(report, opts.baseline);
  }

  if (opts.out) {
    writeReport(report, opts.out);
  }
}

main();
