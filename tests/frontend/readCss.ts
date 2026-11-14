/**
 * 读「按级联顺序拼接好的样式源码」。
 *
 * 样式拆成 `src/styles/` 下的多个模块后，源码契约测试（判断某条规则在不在、
 * 写成什么样）需要看到和打包产物一样的顺序：按 `index.css` 的 `@import`
 * 顺序拼起来即可 —— Vite 也是用同一个顺序把模块内联成一个 CSS。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const styleRoot = resolve(__dirname, "../../src/styles");

const IMPORT_PATTERN = /@import\s+"\.\/([^"]+)";/g;

/** 模块文件名，顺序即级联顺序。 */
export function styleModules(): string[] {
  const index = readFileSync(resolve(styleRoot, "index.css"), "utf8");
  return [...index.matchAll(IMPORT_PATTERN)].map((match) => match[1]);
}

/** 所有样式模块按级联顺序拼接后的文本。 */
export function readCss(): string {
  return styleModules()
    .map((file) => readFileSync(resolve(styleRoot, file), "utf8"))
    .join("\n");
}
