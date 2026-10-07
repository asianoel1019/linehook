import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { hideSkill, isBuiltinSkill, reloadSkills, listSkills } from "./loader.js";

const builtinDir = fileURLToPath(new URL(".", import.meta.url));

// fflate 為選用依賴：延遲載入，避免未安裝時整個服務啟動失敗。
async function loadFflate(): Promise<{
  unzipSync: (data: Uint8Array) => Record<string, Uint8Array>;
  zipSync: (files: Record<string, Uint8Array>) => Uint8Array;
}> {
  try {
    return (await import("fflate")) as unknown as {
      unzipSync: (data: Uint8Array) => Record<string, Uint8Array>;
      zipSync: (files: Record<string, Uint8Array>) => Uint8Array;
    };
  } catch {
    throw new Error("缺少 fflate 套件，請先執行 npm install");
  }
}

export interface InstalledSkill {
  id: string;
  name: string;
  version: string;
  description: string;
  dir: string;
}

function skillsRoot(): string {
  return resolve(config.skillsPath);
}

export function safeName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "");
}

/** manifest 欄位可能是字串或 { zh, en, ja }；取 zh（或第一個非空）。 */
function resolveManifestText(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of ["zh", "en", "ja"]) {
      const v = rec[key];
      if (typeof v === "string" && v) return v;
    }
  }
  return fallback;
}

/** 讀取已安裝的外部技能資訊。 */
export function listInstalled(): InstalledSkill[] {
  const root = skillsRoot();
  if (!existsSync(root)) return [];
  const out: InstalledSkill[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifestPath = join(dir, "skill.json");
    let name2 = name;
    let version = "";
    let description = "";
    if (existsSync(manifestPath)) {
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
        name2 = resolveManifestText(m.name, name);
        version = String(m.version ?? "");
        description = resolveManifestText(m.description, "");
      } catch {
        // ignore
      }
    }
    out.push({ id: name, name: name2, version, description, dir });
  }
  return out;
}

/**
 * 安裝技能 zip。支援兩種結構：
 *  - zip 內含單一資料夾（folder/index.js 或 folder/skill.json）
 *  - zip 根目錄即技能檔（index.js / skill.json）
 * 解壓到 data/skills/<id>/，並重新載入技能。
 */
export async function installZip(buffer: Buffer): Promise<{ id: string; files: number }> {
  const { unzipSync } = await loadFflate();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch (error) {
    throw new Error(`無法解壓 zip：${String(error)}`);
  }

  const names = Object.keys(files).filter((n) => !n.endsWith("/"));
  if (names.length === 0) throw new Error("zip 內沒有檔案");
  if (names.length > 200) throw new Error("zip 內檔案過多（上限 200）");
  let totalBytes = 0;
  for (const n of names) {
    totalBytes += files[n].length;
    if (files[n].length > 5 * 1024 * 1024) throw new Error("zip 內有單檔過大（上限 5MB）");
  }
  if (totalBytes > 50 * 1024 * 1024) throw new Error("zip 解壓後過大（上限 50MB）");

  // 判斷最上層共同資料夾
  const roots = new Set(names.map((n) => n.split("/")[0]));
  const singleRoot = roots.size === 1 && names.every((n) => n.includes("/"));

  // 讀 manifest 取 id
  let id = "";
  const manifestKey = names.find((n) => n.endsWith("skill.json"));
  if (manifestKey) {
    try {
      const m = JSON.parse(Buffer.from(files[manifestKey]).toString("utf8")) as { id?: string };
      if (m.id) id = safeName(m.id);
    } catch {
      // ignore
    }
  }
  if (!id) {
    const entry = names.find((n) => /(^|\/)index\.(m?js|cjs)$/.test(n));
    if (entry) {
      const parts = entry.split("/");
      id = safeName(singleRoot && parts.length > 1 ? parts[0] : parts[0].replace(/\.(m?js|cjs)$/, ""));
    }
  }
  if (!id) id = `skill-${Date.now()}`;

  const root = skillsRoot();
  const destDir = join(root, id);
  mkdirSync(destDir, { recursive: true });

  let count = 0;
  for (const name of names) {
    const rel = singleRoot ? name.split("/").slice(1).join("/") : name;
    if (!rel) continue;
    const clean = rel
      .split("/")
      .map(safeName)
      .filter(Boolean)
      .join("/");
    if (!clean) continue;
    const target = resolve(destDir, clean);
    if (!target.startsWith(destDir)) continue; // 防目錄穿越
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, Buffer.from(files[name]));
    count++;
  }

  if (!existsSync(join(destDir, "index.js")) && !existsSync(join(destDir, "index.mjs")) && !existsSync(join(destDir, "index.cjs"))) {
    rmSync(destDir, { recursive: true, force: true });
    throw new Error("技能缺少 index.js（或 index.mjs）進入點");
  }

  await reloadSkills();
  const loaded = listSkills().some((s) => s.id === id);
  if (!loaded) {
    logger.warn("技能已解壓但載入失敗（請檢查 index.js）", { id });
  }
  logger.info("已安裝技能", { id, files: count });
  return { id, files: count };
}

/** 移除外部技能。 */
export async function uninstallSkill(id: string): Promise<boolean> {
  const safe = safeName(id);
  if (!safe) return false;
  const root = skillsRoot();
  const dir = resolve(root, safe);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (dir === root || !dir.startsWith(rootWithSep)) return false;
  let removed = false;
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    removed = true;
    logger.info("已移除外部技能", { id: safe });
  }
  // 內建技能不刪檔（重建置會復活）：改為隱藏不載入，可於安裝/移除頁恢復。
  if (isBuiltinSkill(safe)) {
    hideSkill(safe);
    removed = true;
    logger.info("已隱藏內建技能", { id: safe });
  }
  if (removed) await reloadSkills();
  return removed;
}

/** 打包內建技能為 zip（含 index.js/ts 與 skill.json），供技能庫下載。 */
export async function buildSkillZip(
  id: string,
  meta: {
    name: string;
    description: string | Record<string, string>;
    usage?: string | Record<string, string>;
    category?: string | Record<string, string>;
    defaultTrigger?: string;
    triggerAliases?: string[];
    version?: string;
  },
): Promise<Buffer | null> {
  const dir = join(builtinDir, id);
  let entry = "";
  if (existsSync(join(dir, "index.js"))) entry = "index.js";
  else if (existsSync(join(dir, "index.ts"))) entry = "index.ts";
  if (!entry) return null;

  const { zipSync } = await loadFflate();
  const files: Record<string, Uint8Array> = {};
  files["skill.json"] = Buffer.from(
    JSON.stringify(
      {
        id,
        name: meta.name,
        description: meta.description,
        ...(meta.usage ? { usage: meta.usage } : {}),
        ...(meta.category ? { category: meta.category } : {}),
        ...(meta.defaultTrigger ? { defaultTrigger: meta.defaultTrigger } : {}),
        ...(meta.triggerAliases && meta.triggerAliases.length > 0 ? { triggerAliases: meta.triggerAliases } : {}),
        version: meta.version ?? "1.0.0",
      },
      null,
      2,
    ),
    "utf8",
  );
  files[entry] = readFileSync(join(dir, entry));
  return Buffer.from(zipSync(files));
}
