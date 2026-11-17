#!/usr/bin/env node
import { connect } from "../probes/lib/cdp.mjs";
const cdp = await connect();
for (const W of [960, 1280, 1440, 1920, 2560]) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: 800, deviceScaleFactor: 0, mobile: false });
  await cdp.eval(`(() => { location.hash = '#/'; return 1; })()`);
  await cdp.sleep(700);
  const m = await cdp.eval(`(() => {
    const vw = window.innerWidth;
    const g = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) }; };
    return { vw, hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      docSW: document.documentElement.scrollWidth,
      page: g('.page'), hero: g('.home-hero'), next: g('.home-hero__next') };
  })()`);
  const ok = !m.hScroll && m.hero && m.next && m.next.right <= m.vw && m.hero.right >= m.vw - 2;
  console.log(`W=${W}`, JSON.stringify(m), ok ? "✅铺满无横滚" : "❌");
}
await cdp.send("Emulation.clearDeviceMetricsOverride");
cdp.close();
