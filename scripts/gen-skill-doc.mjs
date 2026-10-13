#!/usr/bin/env node
// gen-skill-doc.mjs — 由技能定義產生 README 的「內建技能總表」。
// 用法：node scripts/gen-skill-doc.mjs（README 會在 SKILLS:BEGIN/END 標記之間就地更新）
// 技能有增減時重跑一次即可，避免手工表過期。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(root, "src", "skills");
const readmePath = join(root, "README.md");
const BEGIN = "<!-- SKILLS:BEGIN -->";
const END = "<!-- SKILLS:END -->";

/** 從 index.ts 擷取技能定義欄位（值可為字串或 { zh, en, ja }）。 */
function field(src, key) {
  const re = new RegExp(`\\b${key}\\s*:\\s*`);
  const m = re.exec(src);
  if (!m) return undefined;
  let rest = src.slice(m.index + m[0].length).trimStart();
  if (rest.startsWith("{")) {
    const obj = rest.slice(0, rest.indexOf("}") + 1);
    const zh = /zh\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(obj);
    return zh ? zh[1] : undefined;
  }
  const str = rest.match(/^"((?:[^"\\]|\\.)*)"/);
  return str ? str[1] : undefined;
}

/** 這個技能需要 API key 嗎（有 secret 欄位或明顯的 Key 欄位）。 */
function needsKey(src) {
  return /secret\s*:\s*true/.test(src) || /"[a-zA-Z]*(apiKey|Key|Token|Secret)[a-zA-Z]*"\s*:/i.test(src);
}

const skills = [];
for (const name of readdirSync(skillsDir)) {
  const dir = join(skillsDir, name);
  if (!existsSync(join(dir, "index.ts"))) continue;
  const src = readFileSync(join(dir, "index.ts"), "utf8");
  const def = src.slice(src.indexOf(`id: "${name}"`) >= 0 ? src.indexOf(`id: "${name}"`) : 0);
  const trigger = field(def, "defaultTrigger");
  if (!trigger) continue; // auto-reply 等無觸發詞
  const aliases = (() => {
    const m = /triggerAliases\s*:\s*\[([^\]]*)\]/.exec(def);
    return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : [];
  })();
  skills.push({
    id: name,
    name: field(def, "name") ?? name,
    desc: field(def, "description") ?? "",
    cat: field(def, "category") ?? "未分類",
    trigger,
    alias: aliases[0] ?? "",
    key: needsKey(def),
  });
}

const cats = [...new Set(skills.map((s) => s.cat))].sort((a, b) => a.localeCompare(b, "zh-Hant"));
const lines = [];
lines.push(BEGIN);
lines.push("");
lines.push(`共 ${skills.length} 個可觸發技能。完整維護方式：\`node scripts/gen-skill-doc.mjs\`。`);
lines.push("");
for (const cat of cats) {
  lines.push(`**${cat}**`);
  lines.push("");
  lines.push("| 技能 | 觸發詞 | 說明 | 金鑰 |");
  lines.push("| --- | --- | --- | --- |");
  for (const s of skills.filter((x) => x.cat === cat)) {
    const trig = s.alias ? `${s.trigger}（別名 ${s.alias}…）` : s.trigger;
    lines.push(`| ${s.name} | ${trig} | ${s.desc} | ${s.key ? "需要" : "免 key"} |`);
  }
  lines.push("");
}
lines.push(END);

const readme = readFileSync(readmePath, "utf8");
const start = readme.indexOf(BEGIN);
const end = readme.indexOf(END);
if (start < 0 || end < 0) {
  console.error("README 缺少 SKILLS:BEGIN / SKILLS:END 標記，請先手動加入");
  process.exit(1);
}
const next = readme.slice(0, start) + lines.join("\n") + readme.slice(end + END.length);
writeFileSync(readmePath, next, "utf8");
console.log(`README 技能總表已更新（${skills.length} 個技能、${cats.length} 個分類）`);
