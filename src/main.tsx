import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installGlobalErrorLogging, log } from "./lib/logger";
import { APP_VERSION } from "./lib/version";
import "./styles.css";

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

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
