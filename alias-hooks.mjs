// alias-hooks.mjs — `@lw/*` 解析 hook（由 alias.mjs 以 module.register 註冊）。
//
// 命名約定：
//   @lw/<模組>          → <base>/<模組>.ts｜.js          例：@lw/logger、@lw/net
//   @lw/skills/<模組>   → <base>/skills/<模組>.ts｜.js   例：@lw/skills/llm
//   @lw/skills/<技能>   → <base>/skills/<技能>/index.*    例：@lw/skills/weather
//
// base 由 alias.mjs 依「開發（src）／正式（dist）」決定，因此匯入永遠指向
// 應用程式那一份模組實例（config/logger/cache 等單例不會被複製第二份）。
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const PREFIX = "@lw/";
const SUFFIXES = [".ts", "/index.ts", ".js", "/index.js"];

let root = "";

/** hook 執行緒初始化：接收 register 傳入的 base（file:// URL）。 */
export function initialize(data) {
  const base = typeof data?.base === "string" ? data.base : "";
  if (!base) throw new Error("alias-hooks：缺少 base（應由 alias.mjs 傳入）");
  root = fileURLToPath(base);
}

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(PREFIX)) return nextResolve(specifier, context);

  const rel = specifier.slice(PREFIX.length);
  // 禁止穿越：別名不接受 `.`、`..`、絕對路徑或反斜線
  if (!rel || rel.includes("..") || rel.startsWith(".") || rel.includes("\\")) {
    throw new Error(`非法的 @lw 匯入：${specifier}`);
  }

  for (const suffix of SUFFIXES) {
    const candidate = `${root}/${rel}${suffix}`;
    if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
  }
  throw new Error(
    `找不到模組「${specifier}」（試過：${SUFFIXES.map((s) => rel + s).join("、")}）。` +
      "外部技能請透過 @lw/* 別名匯入宿主的模組；這通常代表技能版本與主機不相容。",
  );
}
