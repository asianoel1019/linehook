// alias.mjs — 註冊 `@lw/*` 模組解析 hook。
// 讓「技能」可以用穩定的別名匯入宿主提供的基礎設施與其他技能，
// 而不是 `../../logger.js` 這種相依目錄結構的相對路徑——這是技能 zip
// 能自包含分享的前提：zip 裡只有 index.js，安裝到任何位置都能解析。
//
// 用法（dev / test / 正式都要帶）：
//   node --import tsx --import ./alias.mjs src/index.ts
//   node --import ./alias.mjs dist/index.js
import { register } from "node:module";

// 開發（主程式是 .ts 或被 tsx 載入）→ 解析到 src/；正式 → dist/。
const entry = process.argv[1] ?? "";
const dev = /\.(ts|mts|cts)$/.test(entry) || Boolean(process.env.TSX);
const base = new URL(dev ? "src/" : "dist/", import.meta.url);

register("./alias-hooks.mjs", {
  parentURL: import.meta.url,
  data: { base: base.href },
});
