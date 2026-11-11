/**
 * 应用版本：由 Vite 在构建时从 package.json 注入（见 `vite.config.ts`）。
 * 不要在页面里硬编码版本号，Cargo / tauri.conf / package.json 必须一致。
 */
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
