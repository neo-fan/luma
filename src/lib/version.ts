/**
 * 应用版本：由 Vite 在构建时从 package.json 注入（见 `vite.config.ts`）。
 * 不要在页面里硬编码版本号，Cargo / tauri.conf / package.json 必须一致。
 */
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
/** 构建号：最近提交 short hash（与后端同源，双击 exe 可比对前后端是否同构建）。 */
export const BUILD_HASH = typeof __BUILD_HASH__ === "string" ? __BUILD_HASH__ : "unknown";
/** 构建号：上述提交的提交时间。 */
export const BUILD_TIME = typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "unknown";
