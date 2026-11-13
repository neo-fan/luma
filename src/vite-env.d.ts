/// <reference types="vite/client" />

/** 由 `vite.config.ts` 从 package.json 注入，版本号只有一个来源。 */
declare const __APP_VERSION__: string;
/** 由 `vite.config.ts` 从 `git log -1` 注入：最近提交 short hash。 */
declare const __BUILD_HASH__: string;
/** 由 `vite.config.ts` 从 `git log -1` 注入：上述提交的提交时间。 */
declare const __BUILD_TIME__: string;
