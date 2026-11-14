/**
 * 窗口探针共用的最小 CDP 客户端。
 *
 * 只做「连窗口 / 求值 / 输入 / 截图 / 收集异常」这几件事，不做断言——
 * 断言留在各探针里（通过 `process.exit(1)` 表达失败），这样单跑与
 * `node tools/run_probes.mjs` 批量跑的行为一致。
 *
 *   import { connect } from "./lib/cdp.mjs";
 *   const cdp = await connect();
 *   await cdp.eval("location.hash = '#/live'");
 *   const active = await cdp.invoke("config_active");
 *   await cdp.close();
 *
 * 前置：`corepack pnpm tauri dev` 窗口已起（默认 CDP 9222；可用 CDP_PORT 覆盖）。
 */

const DEFAULT_MATCH = "localhost:1420";

export async function connect({ port = process.env.CDP_PORT || "9222", match = DEFAULT_MATCH } = {}) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  const targets = await (await fetch(endpoint)).json();
  const page = targets.find((item) => item.type === "page" && item.url.includes(match));
  if (!page) throw new Error(`没有找到匹配 ${match} 的窗口（${endpoint}）`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.addEventListener("open", () => resolve(new Cdp(ws, page)), { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
  });
}

class Cdp {
  constructor(ws, page) {
    this.ws = ws;
    this.page = page;
    this.nextId = 1;
    this.pending = new Map();
    this.exceptions = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        const detail = message.params?.exceptionDetails;
        this.exceptions.push(detail?.exception?.description || detail?.text || "unknown exception");
        return;
      }
      const slot = this.pending.get(message.id);
      if (slot) {
        this.pending.delete(message.id);
        slot(message);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 120000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
    return reply.then((message) => {
      if (message.error) throw new Error(`${method}: ${message.error.message}`);
      return message.result;
    });
  }

  /** 求值并取回值；页面内抛异常时抛到调用方。 */
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  /** 调 Tauri command（走页面里的 __TAURI_INTERNALS__，与前端同一条 IPC）。 */
  invoke(command, args = null) {
    return this.eval(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
    );
  }

  /** 真实鼠标点击（ArtPlayer 等控件对 dispatchEvent 不响应，必须走 Input 域）。 */
  async click(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  /** 视口截图（PNG）。探针只在不变量检查失败时才落盘，平时不产文件。 */
  async screenshot(filePath) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(filePath, Buffer.from(data, "base64"));
    return filePath;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  close() {
    this.ws.close();
  }
}

/** 打印问题清单并以退出码表达结果；探针统一用它收尾。 */
export function finish(problems, summary = "") {
  if (summary) console.log(summary);
  if (problems.length === 0) {
    console.log("[PASS]");
    return 0;
  }
  console.log("problems:", JSON.stringify(problems, null, 1));
  console.log("[FAIL]");
  return 1;
}
