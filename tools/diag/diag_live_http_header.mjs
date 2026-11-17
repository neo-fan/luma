#!/usr/bin/env node
// 打印 http-header / migu / litchi 相关的完整 EXTINF 原文，确认语法与所需头集合。
import { connect } from "../probes/lib/cdp.mjs";
const cdp = await connect();
const invoke = (cmd, p) => cdp.invoke(cmd, p).catch((e) => ({ __error: String(e) }));
const active = await invoke("config_active");
const lives = ((active?.snapshot || active)?.lives || []).filter((l) => /^https?:/.test(String(l.url || "")));
const names = new Set(["Kimentanm", "suxuang", "Guovin", "mlzlzj", "cluntop"]);
for (const src of lives) {
  if (!names.has(src.name)) continue;
  const f = await invoke("http_fetch", { request: { url: src.url, method: "GET", headers: src.ua ? { "user-agent": src.ua } : {} } });
  const body = String(f?.body ?? "");
  const lines = body.split(/\r?\n/);
  console.log(`\n===== ${src.name} =====`);
  let shown = 0;
  for (let i = 0; i < lines.length && shown < 4; i++) {
    if (/http-header=|litchi|jstv|encrypted|migutoken|miguvideo/i.test(lines[i])) {
      console.log(`L${i}: ${lines[i].slice(0, 260)}`);
      shown++;
    }
  }
  if (!shown) console.log("  （无 http-header/litchi/migu 相关行）");
}
cdp.close();
