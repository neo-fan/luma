#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { connect } from "../probes/lib/cdp.mjs";
mkdirSync("tools/.out", { recursive: true });
const cdp = await connect();
for (const W of [1920, 1280]) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: 900, deviceScaleFactor: 0, mobile: false });
  await cdp.eval(`(() => { location.hash = '#/'; return 1; })()`);
  await cdp.sleep(1200);
  await cdp.screenshot(`tools/.out/responsive-home-${W}.png`).catch(()=>{});
  console.log(`[shot] tools/.out/responsive-home-${W}.png`);
}
await cdp.send("Emulation.clearDeviceMetricsOverride");
cdp.close();
