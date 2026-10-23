#!/usr/bin/env node
// build-library.mjs — 產生靜態技能庫（侘寂風 Landing）
// 用法：node scripts/build-library.mjs
// 輸出：library/index.html + library/<id>.zip（可整個丟到任何靜態主機）

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "src", "skills");
const distSkillsDir = join(root, "dist", "skills");
const outDir = join(root, "library");

// fflate（zip）
let zipSync;
try {
  ({ zipSync } = await import("fflate"));
} catch {
  try {
    ({ zipSync } = require("fflate"));
  } catch {
    console.error("缺少 fflate，請先 npm install");
    process.exit(1);
  }
}

// 從技能定義區塊擷取欄位值；值可為字串或 { zh, en, ja } 多語物件。
function extractField(hay, key) {
  const re = new RegExp(`\\b${key}\\s*:\\s*`);
  const m = re.exec(hay);
  if (!m) return undefined;
  let s = hay.slice(m.index + m[0].length).trimStart();

  // { ... } 多語物件
  if (s.startsWith("{")) {
    const end = s.indexOf("}");
    if (end < 0) return undefined;
    const obj = s.slice(0, end + 1);
    const out = {};
    const kvRe = /(zh|en|ja|label|value)\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
    let kv;
    while ((kv = kvRe.exec(obj))) out[kv[1]] = kv[2] ?? kv[3] ?? "";
    return out;
  }
  // 字串
  const str = s.match(/^"((?:[^"\\]|\\.)*)"|^'((?:[^'\\]|\\.)*)'/);
  if (str) return str[1] ?? str[2] ?? "";
  return undefined;
}
// 從技能定義區塊擷取字串陣列（例如 triggerAliases）。
function extractArray(hay, key) {
  const re = new RegExp(`\\b${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`);
  const m = re.exec(hay);
  if (!m) return [];
  const out = [];
  const itemRe = /(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g;
  let it;
  while ((it = itemRe.exec(m[1]))) out.push(it[1] ?? it[2] ?? "");
  return out;
}

function defBlock(src) {
  const anchor = src.match(/id\s*:\s*["'][^"']*["'][\s\S]*/);
  return anchor ? anchor[0] : src;
}

function zhOf(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return value.zh || value.en || value.ja || "";
}

// 讀取單一技能的中繼資料：優先 skill.json，其次靜態解析 index.ts/tsx 的欄位
function readMeta(dir, id) {
  const manifest = join(dir, "skill.json");
  if (existsSync(manifest)) {
    try {
      const m = JSON.parse(readFileSync(manifest, "utf8"));
      return {
        id,
        name: m.name || id,
        description: m.description || "",
        usage: m.usage,
        category: m.category || "技能",
        defaultTrigger: m.defaultTrigger || "",
        triggerAliases: m.triggerAliases || [],
        needsKey: Boolean(m.needsKey) || /secret\s*:\s*true/.test(readIndexSource(dir)),
        version: m.version || "1.0.0",
      };
    } catch {}
  }
  const src = readIndexSource(dir);
  const hay = defBlock(src);
  const needsKey = /secret\s*:\s*true/.test(src) || /\bapiKey\b/.test(hay);
  return {
    id,
    name: zhOf(extractField(hay, "name")) || id,
    description: extractField(hay, "description") ?? "",
    usage: extractField(hay, "usage"),
    category: extractField(hay, "category") ?? "技能",
    defaultTrigger: zhOf(extractField(hay, "defaultTrigger")),
    triggerAliases: extractArray(hay, "triggerAliases"),
    needsKey,
    version: "1.0.0",
  };
}

function readIndexSource(dir) {
  for (const f of ["index.ts", "index.js", "index.mjs"]) {
    if (existsSync(join(dir, f))) return readFileSync(join(dir, f), "utf8");
  }
  return "";
}

function zipSkill(dir, id, meta) {
  const files = {};
  files["skill.json"] = Buffer.from(
    JSON.stringify(
      {
        id,
        name: meta.name,
        description: meta.description,
        ...(meta.usage ? { usage: meta.usage } : {}),
        ...(meta.category ? { category: meta.category } : {}),
        ...(meta.defaultTrigger ? { defaultTrigger: meta.defaultTrigger } : {}),
        ...(meta.triggerAliases && meta.triggerAliases.length ? { triggerAliases: meta.triggerAliases } : {}),
        // 技能 API 版本：zip 只帶 index.js，其餘靠 @lw/* 別名向宿主要
        api: 1,
        version: meta.version,
      },
      null,
      2,
    ),
    "utf8",
  );
  // 優先打包已編譯的 dist/skills/<id>/index.js（Docker 內安裝後可直接跑，
  // 不需 TS 執行環境）；本機沒 build 過才退回 src 的 index.ts。
  let entry = "";
  const compiled = join(distSkillsDir, id, "index.js");
  if (existsSync(compiled)) entry = compiled;
  else {
    for (const f of ["index.js", "index.ts", "index.mjs", "index.cjs"]) {
      if (existsSync(join(dir, f))) {
        entry = join(dir, f);
        break;
      }
    }
  }
  if (!entry) return null;
  files["index" + entry.slice(entry.lastIndexOf("."))] = readFileSync(entry);
  return Buffer.from(zipSync(files));
}

// 技能圖解：src/skills/<id>/guide.{svg,png,jpg,jpeg,webp} → library/<id>-guide.{ext}。
// 用法區塊展開時顯示，點擊放大（燈箱）。zip 打包不受影響（只帶 index.js＋skill.json）。
const GUIDE_EXTS = [".svg", ".png", ".jpg", ".jpeg", ".webp"];

function findGuideFile(id) {
  const dir = join(skillsDir, id);
  for (const ext of GUIDE_EXTS) {
    const p = join(dir, `guide${ext}`);
    try {
      if (statSync(p).isFile()) return { src: p, file: `${id}-guide${ext}` };
    } catch {
      // 不存在就試下一個副檔名
    }
  }
  return null;
}

// 掃描技能資料夾（略過 ai/llm/cache 等非技能檔案；ai 為技能要保留）
const IGNORE = new Set(["llm.ts", "cache.ts", "loader.ts", "types.ts", "install.ts", "index.ts"]);
const skills = [];
for (const name of readdirSync(skillsDir)) {
  const dir = join(skillsDir, name);
  try {
    if (!statSync(dir).isDirectory()) continue;
  } catch {
    continue;
  }
  const meta = readMeta(dir, name);
  skills.push({ ...meta, dir });
}
skills.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));

// 輸出
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const built = [];
const guides = new Map();
for (const s of skills) {
  const zip = zipSkill(s.dir, s.id, s);
  if (!zip) continue;
  writeFileSync(join(outDir, `${s.id}.zip`), zip);
  const guide = findGuideFile(s.id);
  if (guide) {
    writeFileSync(join(outDir, guide.file), readFileSync(guide.src));
    guides.set(s.id, guide.file);
  }
  built.push(s);
}

// P3：機器可讀 manifest，供 /skills/updates.json 比對「可更新」（版本＋api）。
writeFileSync(
  join(outDir, "index.json"),
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      count: built.length,
      skills: built.map((s) => ({ id: s.id, name: s.name, version: s.version, api: 1 })), // 與 zipSkill 內的 api 一致（＝ SKILL_API_VERSION）
    },
    null,
    2,
  ),
  "utf8",
);

const STYLE = `
  :root {
    --paper-1:#f7f5f0; --paper-2:#fffef8; --paper-3:#f0ecdf;
    --ink-1:#2a2a28; --ink-2:#0d0c0a; --ink-soft:#6b6557;
    --border-1:#d7d1c2; --border-2:#6b6557;
    --shadow:rgba(60,50,30,.14);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper-1:#1a1917; --paper-2:#22201d; --paper-3:#141210;
      --ink-1:#e8e4da; --ink-2:#f5f2ea; --ink-soft:#9a9182;
      --border-1:#3a3630; --border-2:#5a5449; --shadow:rgba(0,0,0,.5);
    }
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{
    margin:0; color:var(--ink-1); line-height:1.8;
    font-family:"Georgia","Noto Serif TC",serif;
    background:
      radial-gradient(1200px 600px at 12% -10%, var(--paper-2), transparent 60%),
      radial-gradient(900px 500px at 100% 0%, var(--paper-3), transparent 55%),
      linear-gradient(180deg, var(--paper-1), var(--paper-3));
    min-height:100vh;
  }
  .wrap{max-width:1080px;margin:0 auto;padding:0 22px}
  a{color:inherit}

  /* hero */
  header{padding:88px 0 40px}
  .eyebrow{font-size:12px;letter-spacing:.4em;color:var(--ink-soft);text-transform:uppercase}
  h1{font-size:clamp(34px,6vw,58px);font-weight:400;letter-spacing:.06em;margin:18px 0 10px;color:var(--ink-2)}
  .lead{max-width:620px;color:var(--ink-soft);font-size:16px}
  .philo{display:flex;flex-wrap:wrap;gap:10px 12px;margin:34px 0 6px;align-items:center}
  .filter{font:inherit;font-size:13px;letter-spacing:.1em;color:var(--ink-soft);background:transparent;border:1px solid var(--border-1);border-radius:999px;padding:6px 18px;cursor:pointer;transition:background-color .35s ease,color .35s ease,border-color .35s ease}
  .filter:hover{border-color:var(--border-2);color:var(--ink-2)}
  .filter.active{background:var(--ink-2);border-color:var(--ink-2);color:var(--paper-2)}
  .filter-count{font-size:12px;color:var(--ink-soft);letter-spacing:.12em}
  .rule{height:1px;background:linear-gradient(90deg,var(--border-1),transparent);margin:48px 0}

  /* grid */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:28px;padding-bottom:20px}
  .card{
    position:relative;padding:28px 26px 24px;
    background:linear-gradient(160deg,var(--paper-2),var(--paper-1));
    border:1px solid var(--border-1);
    border-radius:4px 24px 4px 24px;
    box-shadow:0 2px 3px var(--shadow),0 16px 34px -20px var(--shadow);
    transition:transform .5s ease, box-shadow .5s ease;
  }
  .card:nth-child(3n){border-radius:24px 4px 24px 4px}
  .card:nth-child(3n+2){margin-top:16px}
  .card:hover{transform:translateY(-4px);box-shadow:0 5px 8px var(--shadow),0 26px 46px -22px var(--shadow)}
  .card .tag{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--border-2);margin-bottom:12px}
  .card h2{font-size:19px;font-weight:500;margin:0 0 8px;color:var(--ink-2);letter-spacing:.04em}
  .card p{margin:0 0 20px;font-size:13.5px;color:var(--ink-soft);min-height:46px}
  .btn{
    display:inline-block;padding:9px 22px;font-size:13px;letter-spacing:.1em;
    color:var(--ink-2);text-decoration:none;
    border:1px solid var(--border-2);border-radius:2px 12px 2px 12px;
    transition:background-color .4s ease,color .4s ease;
  }
  .btn:hover{background:var(--ink-2);color:var(--paper-2)}
  .btn.ghost{background:transparent}
  .btn.ghost:hover{background:var(--ink-2);color:var(--paper-2)}
  .card-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .usage-label{font-size:10.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--border-2);margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;gap:8px}
  .copy-btn{font:inherit;font-size:11px;letter-spacing:.15em;color:var(--ink-soft);background:transparent;border:1px solid var(--border-1);border-radius:999px;padding:3px 14px;cursor:pointer;transition:border-color .3s ease,color .3s ease}
  .copy-btn:hover{border-color:var(--border-2);color:var(--ink-2)}
  .lightbox-close{position:absolute;top:14px;right:20px;font-size:26px;line-height:1;color:#fff;background:transparent;border:0;cursor:pointer;opacity:.85}
  .lightbox-close:hover{opacity:1}
  .lightbox-card{margin:0;background:var(--paper-2);border:1px solid var(--border-1);border-radius:16px;max-width:min(920px,94vw);max-height:92vh;overflow:auto;padding:18px;cursor:default}
  .lightbox-card img{display:block;width:100%;height:auto;max-height:60vh;object-fit:contain;border-radius:10px;background:#fff}
  .lightbox-card img[hidden]{display:none}
  .lightbox-card figcaption{margin-top:14px;padding:12px 14px;border:1px dashed var(--border-1);border-radius:10px 2px 10px 2px;background:var(--paper-3)}
  .lightbox-card code{display:block;font-family:ui-monospace,"SFMono-Regular",Menlo,monospace;font-size:13px;color:var(--ink-2);white-space:pre-wrap;word-break:break-all}
  .lightbox{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(20,18,12,.74);cursor:zoom-out}
  .lightbox[hidden]{display:none}
  .lightbox img{max-width:min(1100px,94vw);max-height:92vh;border-radius:12px;background:#fff;box-shadow:0 30px 80px rgba(0,0,0,.4)}
  .meta{display:flex;align-items:center;gap:10px;margin:0 0 18px;flex-wrap:wrap}
  .badge{font-size:11px;letter-spacing:.08em;padding:3px 10px;border-radius:2px 10px 2px 10px;border:1px solid var(--border-2);color:var(--ink-soft)}
  .badge.soft{border-color:var(--border-1);color:var(--ink-soft);opacity:.8}
  .file{font-size:11px;color:var(--ink-soft);font-family:ui-monospace,monospace;letter-spacing:.02em}
  .trig{font-size:11.5px;color:var(--border-2);margin:-12px 0 16px;letter-spacing:.04em}

  /* how */
  section{padding:34px 0}
  h2.sec{font-size:14px;letter-spacing:.28em;text-transform:uppercase;color:var(--border-2);font-weight:400;margin:0 0 22px}
  ol.steps{margin:0;padding-left:0;list-style:none;counter-reset:step;display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
  ol.steps li{counter-increment:step;padding:20px 22px;background:var(--paper-2);border:1px solid var(--border-1);border-radius:14px 2px 14px 2px;font-size:14px;color:var(--ink-soft)}
  ol.steps li::before{content:counter(step,decimal-leading-zero);display:block;font-size:22px;color:var(--border-2);margin-bottom:6px}

  footer{padding:60px 0 80px;color:var(--ink-soft);font-size:12px;letter-spacing:.14em;text-align:center;border-top:1px solid var(--border-1);margin-top:40px}
`;

const cards = built
  .map((s) => {
    const cat = zhOf(s.category) || "未分類";
    const usage = zhOf(s.usage) || (s.defaultTrigger ? `${s.defaultTrigger} …` : "");
    const usageBtn = usage
      ? `<button class="btn ghost" type="button" onclick="openGuideFor('${s.id}')">用法</button>`
      : "";
    return `      <article class="card" data-cat="${escapeHtml(cat)}">
        <div class="tag">${escapeHtml(cat)}</div>
        <h2>${escapeHtml(s.name)}</h2>
        <p>${escapeHtml(zhOf(s.description) || "無說明")}</p>
        ${s.defaultTrigger ? `<div class="trig">觸發：${escapeHtml(s.defaultTrigger)}</div>` : ""}
        <div class="meta">${s.needsKey ? `<span class="badge">需設定 API Key</span>` : `<span class="badge soft">隨裝即用</span>`}<span class="file">${escapeHtml(s.id)}.zip</span></div>
        <div class="card-actions"><a class="btn" href="./${s.id}.zip" download>下載</a>${usageBtn}</div>
      </article>`;
  })
  .join("\n");

const categories = [...new Set(built.map((s) => zhOf(s.category) || "未分類"))];

// 燈箱資料：用法鈕直開燈箱用（圖＋用文＋名稱）。
const guidesData = {};
for (const s of built) {
  const u = zhOf(s.usage) || (s.defaultTrigger ? `${s.defaultTrigger} …` : "");
  guidesData[s.id] = {
    img: guides.get(s.id) ? `./${guides.get(s.id)}` : null,
    usage: `阿寶請幫忙 ${u}`,
    name: s.name,
  };
}
const guidesJson = JSON.stringify(guidesData).replace(/<\//g, "<\\/");
const jsStr = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const filters = ["全部", ...categories]
  .map(
    (c, i) =>
      `      <button type="button" class="filter${i === 0 ? " active" : ""}" data-filter="${escapeHtml(c)}" onclick="filterCat('${jsStr(c)}', this)">${escapeHtml(c)}</button>`,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ImHook 技能庫 · 侘寂</title>
<meta name="description" content="ImHook 技能庫 — 以侘寂美學靜置每一個技能，下載即用。">
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">ImHook · Skills</div>
    <h1>技能庫</h1>
    <p class="lead">不完美、不張揚。共 <strong>${built.length}</strong> 個技能，每個技能都是一段可獨立存在的器物，下載後安放於你的 ImHook，即能使用。</p>
    <div class="philo" id="filters">
${filters}
      <span class="filter-count" id="filter-count"></span>
    </div>
  </header>

  <div class="rule"></div>

  <section>
    <div class="grid">
${cards || `      <article class="card"><h2>尚無技能</h2><p>目前沒有可下載的技能。</p></article>`}
    </div>
  </section>

  <section>
    <h2 class="sec">如何安裝</h2>
    <ol class="steps">
      <li>下載技能 <code>.zip</code>。</li>
      <li>開啟 ImHook 的「技能」頁。</li>
      <li>上傳 <code>.zip</code> 安裝，立即生效。</li>
    </ol>
  </section>

  <footer>靜置 · 使用 · 放下　—　ImHook Skill Library</footer>
</div>
<div class="lightbox" id="lightbox" hidden onclick="closeGuide()">
  <button class="lightbox-close" type="button" onclick="closeGuide()" aria-label="關閉">×</button>
  <figure class="lightbox-card" onclick="event.stopPropagation()">
    <img id="lightbox-img" alt="技能圖解">
    <figcaption>
      <div class="usage-label"><span id="lightbox-title">用法範例</span><button class="copy-btn" type="button" onclick="copyLightbox()">複製</button></div>
      <code id="lightbox-text"></code>
    </figcaption>
  </figure>
</div>
<script>
window.GUIDES = ${guidesJson};
function openGuideFor(id){
  var g = (window.GUIDES || {})[id];
  if (!g) return;
  var box = document.getElementById('lightbox');
  var img = document.getElementById('lightbox-img');
  var title = document.getElementById('lightbox-title');
  var text = document.getElementById('lightbox-text');
  if (!box || !img || !text) return;
  if (g.img) {
    img.src = g.img;
    img.alt = g.name + '圖解';
    img.removeAttribute('hidden');
  } else {
    img.setAttribute('hidden', '');
    img.removeAttribute('src');
  }
  if (title) title.textContent = g.name + ' · 用法範例';
  text.textContent = g.usage;
  box.removeAttribute('hidden');
}
function closeGuide(){
  var box = document.getElementById('lightbox');
  if (box) box.setAttribute('hidden', '');
}
function copyLightbox(){
  var code = document.getElementById('lightbox-text');
  var btn = document.querySelector('#lightbox .copy-btn');
  if (!code) return;
  var text = code.textContent || '';
  var done = function(){
    if (!btn) return;
    btn.textContent = '已複製';
    setTimeout(function(){ btn.textContent = '複製'; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function(){ fallbackCopy(text); done(); });
  } else {
    fallbackCopy(text);
    done();
  }
}
function fallbackCopy(text){
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') closeGuide();
});
function filterCat(cat, btn){
  var cards = document.querySelectorAll('.card[data-cat]');
  var n = 0;
  for (var i = 0; i < cards.length; i++) {
    var show = (cat === '全部' || cards[i].getAttribute('data-cat') === cat);
    cards[i].style.display = show ? '' : 'none';
    if (show) n++;
  }
  var btns = document.querySelectorAll('[data-filter]');
  for (var j = 0; j < btns.length; j++) btns[j].classList.toggle('active', btns[j] === btn);
  var count = document.getElementById('filter-count');
  if (count) count.textContent = '共 ' + n + ' 個';
}
</script>
</body>
</html>
`;

writeFileSync(join(outDir, "index.html"), html, "utf8");

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

console.log(`技能庫已產生：${outDir}`);
console.log(`- index.html`);
for (const s of built) console.log(`- ${s.id}.zip  (${s.name})`);
for (const [id, file] of guides) console.log(`- ${file}  (${id} 圖解)`);
console.log(`共 ${built.length} 個技能。`);
