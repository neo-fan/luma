import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorLogging, log } from "./lib/logger";
import { APP_VERSION } from "./lib/version";
import "./styles/index.css";

// 先装兜底日志再挂载 React：模块初始化 / 首个渲染的异常也要能落盘。
installGlobalErrorLogging();
log.info("frontend boot", {
  version: APP_VERSION,
  userAgent: navigator.userAgent.slice(0, 160),
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("root container not found");
}

/**
 * 收启动动画（见 index.html 的 `#boot`）。
 *
 * 时机比「模块加载完」更靠后一档：等 React 真的把第一帧画上去再淡出，否则
 * 会先闪一下空白再出现界面，比不做动画更难受。`MIN_VISIBLE_MS` 保证那段
 * 一口气就能加载完的场景不会看到一次「抽搐式」的闪现；`MAX_VISIBLE_MS` 是
 * 兜底，任何异常都不能让启动层永远盖住界面。
 */
const MIN_VISIBLE_MS = 480;
const MAX_VISIBLE_MS = 6000;
const bootAt = performance.now();

function dismissBoot() {
  const boot = document.getElementById("boot");
  if (!boot || boot.classList.contains("is-done")) {
    return;
  }
  boot.classList.add("is-done");
  // 过渡结束后移出 DOM：留着一个全屏 fixed 层会白白吃掉合成层与无障碍树。
  window.setTimeout(() => boot.remove(), 320);
}

function dismissBootWhenPainted() {
  const wait = Math.max(0, MIN_VISIBLE_MS - (performance.now() - bootAt));
  window.setTimeout(() => {
    requestAnimationFrame(() => requestAnimationFrame(dismissBoot));
  }, wait);
}

window.setTimeout(dismissBoot, MAX_VISIBLE_MS);

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

dismissBootWhenPainted();
