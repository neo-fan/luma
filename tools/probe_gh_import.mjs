/**
 * GitHub 加速的导入链路探针：验证「导入那一刻就替换」。
 *
 * 用一份**桩文本配置**（id 由内容派生，不会撞用户已有配置）导入，
 * 断言返回快照里的 GitHub 链接已带当前代理前缀，然后删掉它并切回原配置。
 * 不写用户的真实配置。
 *
 * 用法：node tools/probe_gh_import.mjs
 */
const STUB = JSON.stringify({
  sites: [
    {
      key: "probe_gh_import",
      name: "probe-gh-import",
      type: 1,
      api: "https://example.com/api.php/provide/vod/",
      ext: "https://raw.githubusercontent.com/hunshcn/gh-proxy/master/README.md",
      logo: "https://img.example.com/logo.png",
    },
  ],
  parses: [{ name: "probe", type: 1, url: "https://github.com/hunshcn/gh-proxy/archive/refs/heads/master.zip" }],
});

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
}

const target = (await (await fetch("http://127.0.0.1:9222/json/list")).json()).find((t) => {
  try {
    const url = new URL(t.url);
    return t.type === "page" && url.port === "1420";
  } catch {
    return false;
  }
});
if (!target) {
  console.error("no CDP target on 1420");
  process.exit(2);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (method, params = {}) => {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
};
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.result?.exceptionDetails) {
    throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
  }
  return result.result?.result?.value;
};

await send("Runtime.enable");
const invoke = (cmd, args) =>
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`;

let failed = 0;
const record = (name, ok, detail) => {
  failed += ok ? 0 : 1;
  check(name, ok, detail);
};

const before = JSON.parse(await evaluate(`${invoke("config_active")}.then(v => JSON.stringify(v))`));
const beforeId = before?.id;
const state = JSON.parse(await evaluate(`${invoke("gh_proxy_state")}.then(v => JSON.stringify(v))`));
console.log(`当前前缀 ${state.prefix || "(直连)"} · active=${beforeId}`);

let importedId = null;
try {
  const imported = JSON.parse(
    await evaluate(
      `${invoke("config_import", { source: { kind: "text", value: STUB, name: "probe-gh-import" } })}.then(v => JSON.stringify(v), e => JSON.stringify({ __err: String(e && e.message || e) }))`,
    ),
  );
  record("导入成功", !imported.__err, imported.__err ?? `id=${imported.id}`);
  importedId = imported.id ?? null;

  const site = (imported.sites ?? []).find((item) => item.key === "probe_gh_import");
  record("桩站点在快照里", !!site, site ? "ok" : "missing");
  if (site && state.prefix) {
    record(
      "导入时 ext 已带加速前缀",
      String(site.ext).startsWith(state.prefix),
      String(site.ext).slice(0, 110),
    );
    record(
      "非 GitHub 的 api 未被改写",
      site.api === "https://example.com/api.php/provide/vod/",
      String(site.api),
    );
  } else if (site) {
    record("直连模式不改写", site.ext === "https://raw.githubusercontent.com/hunshcn/gh-proxy/master/README.md", String(site.ext));
  }
  const parse = (imported.parses ?? [])[0];
  if (parse) {
    record(
      "parses[].url 同样被改写",
      !state.prefix || String(parse.url).startsWith(state.prefix),
      String(parse.url).slice(0, 110),
    );
  }
} finally {
  if (importedId) {
    await evaluate(`${invoke("config_remove", { id: importedId })}.catch(e => String(e))`);
    record("桩配置已删除", true, importedId);
  }
  if (beforeId) {
    await evaluate(`${invoke("config_activate", { id: beforeId })}.then(v => v && v.id)`);
    const restored = JSON.parse(await evaluate(`${invoke("config_active")}.then(v => JSON.stringify(v))`));
    record("已切回原配置", restored?.id === beforeId, restored?.id ?? "none");
  }
}

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
