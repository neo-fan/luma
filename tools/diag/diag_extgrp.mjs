import { connect } from "../probes/lib/cdp.mjs";
const cdp = await connect();
const invoke = (cmd, p) => cdp.invoke(cmd, p).catch((e) => ({ __error: String(e) }));
const active = await invoke("config_active");
const lives = ((active?.snapshot || active)?.lives || []).filter((l) => /^https?:/.test(String(l.url || "")));
const gb = lives.find((l) => /gambiarras/i.test(l.name) || /gambiarras/i.test(l.url));
console.log("[源]", gb?.name, gb?.url?.slice(0, 70));
const parsed = await invoke("live_parse", { url: gb.url, ua: gb.ua || null });
if (parsed?.__error) { console.log("parse 失败", parsed.__error); cdp.close(); process.exit(0); }
const groups = parsed?.groups || [];
console.log("[分组数]", groups.length, "频道总数", parsed?.count);
for (const g of groups.slice(0, 12)) {
  console.log(`  [${g.channels?.length ?? 0}] ${g.name}`);
}
cdp.close();
