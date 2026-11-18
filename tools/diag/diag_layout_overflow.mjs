#!/usr/bin/env node
import { connect } from "../probes/lib/cdp.mjs";
const cdp = await connect();
await cdp.eval(`(() => { location.hash = '#/'; return 1; })()`);
await cdp.sleep(1000);
const m = await cdp.eval(`(() => {
  const sels = ['html','body','.app','.content','.page','.page-body','.home-hero','.poster-rail','.poster-rail__track'];
  const rows = sels.map((s) => {
    const e = s==='html'?document.documentElement : s==='body'?document.body : document.querySelector(s);
    if (!e) return { s, missing:true };
    return { s, sw:e.scrollWidth, cw:e.clientWidth, over: e.scrollWidth - e.clientWidth,
      ovfX: getComputedStyle(e).overflowX,
      right: Math.round(e.getBoundingClientRect().right) };
  });
  // 尝试把每个可能滚动容器滚到最右，看谁真能动
  const canScroll = {};
  for (const s of ['.content','.page','.page-body','.poster-rail__track']) {
    const e = document.querySelector(s); if (!e) continue;
    const before = e.scrollLeft; e.scrollLeft = 99999; canScroll[s] = e.scrollLeft - before; e.scrollLeft = before;
  }
  const hero = document.querySelector('.home-hero');
  const next = document.querySelector('.home-hero__next');
  return { innerWidth: window.innerWidth, docSW: document.documentElement.scrollWidth, docCW: document.documentElement.clientWidth,
    heroRight: hero ? Math.round(hero.getBoundingClientRect().right) : null,
    nextRight: next ? Math.round(next.getBoundingClientRect().right) : null,
    nextLeft: next ? Math.round(next.getBoundingClientRect().left) : null,
    rows, canScroll };
})()`);
console.log(JSON.stringify(m, null, 1));
cdp.close();
