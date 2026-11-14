#!/usr/bin/env node
/**
 * 首页网格诊断：不同窗口宽度下 `.vod-grid` 是否把可用宽度用满。
 *
 * 背景（2026-11-14）：`repeat(auto-fill, minmax(220px, 260px))` 在 1440 宽时
 * 只能放 4 列、每列顶到 260，右侧留 ~80px 死角。改成 `minmax(200px, 1fr)` 后
 * 列宽随容器均分。这里用 CDP 改视口逐个宽度量「列数 / 列宽 / 剩余空隙」。
 *
 *   node tools/diag/diag_home_grid.mjs
 *   node tools/diag/diag_home_grid.mjs --widths=1024,1280,1440,1680
 */
import { connect } from "../probes/lib/cdp.mjs";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const hit = args.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : "";
};
const widths = (valueOf("--widths") || "1024,1100,1280,1440,1680,1920")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item > 0);

const cdp = await connect();

await cdp.eval("location.hash = '#/'");
await cdp.sleep(1500);
const cards = await cdp.eval("document.querySelectorAll('.content .vod-grid .vod-card').length");
if (cards === 0) {
  console.log("[SKIP] 首页没有卡片（未导入配置或站点无内容）");
  cdp.close();
  process.exit(0);
}
console.log("卡片数:", cards);

const MEASURE = `(() => {
  const grid = document.querySelector('.content .vod-grid');
  if (!grid) return null;
  const style = getComputedStyle(grid);
  const tracks = style.gridTemplateColumns.split(/\\s+/).filter(Boolean).map((item) => parseFloat(item));
  const gap = parseFloat(style.columnGap) || 0;
  const rect = grid.getBoundingClientRect();
  const used = tracks.reduce((sum, item) => sum + item, 0) + gap * Math.max(0, tracks.length - 1);
  return {
    viewport: window.innerWidth,
    gridWidth: Math.round(rect.width * 10) / 10,
    columns: tracks.length,
    trackWidth: Math.round(tracks[0] * 10) / 10,
    gap,
    spare: Math.round((rect.width - used) * 10) / 10,
  };
})()`;

const rows = [];
for (const width of widths) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await cdp.sleep(450);
  const row = await cdp.eval(MEASURE);
  rows.push({ requested: width, row });
  console.log(JSON.stringify(row));
}

await cdp.send("Emulation.clearDeviceMetricsOverride");
cdp.close();

const problems = rows.filter(({ row }) => !row || Math.abs(row.spare) > 2);
if (problems.length > 0) {
  console.log("problems:", JSON.stringify(problems));
  process.exit(1);
}
console.log("[PASS] 各宽度下网格均铺满（剩余空隙 ≤ 2px）");
