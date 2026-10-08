import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { SkillDefinition } from "./types.js";

const builtinDir = fileURLToPath(new URL(".", import.meta.url));

let skills: SkillDefinition[] = [];
let loaded = false;

function toSkill(mod: unknown): SkillDefinition | null {
  const value = mod as { default?: unknown };
  for (const c of [value?.default, mod]) {
    const def = c as Partial<SkillDefinition> | undefined;
    if (
      def &&
      typeof def.id === "string" &&
      typeof def.name === "string" &&
      typeof def.run === "function"
    ) {
      return def as SkillDefinition;
    }
  }
  return null;
}

async function tryImportFolder(dir: string): Promise<SkillDefinition | null> {
  for (const file of ["index.js", "index.ts"]) {
    const target = join(dir, file);
    if (!existsSync(target)) continue;
    try {
      const mod = await import(`${pathToFileURL(target).href}?t=${Date.now()}`);
      const def = toSkill(mod);
      if (def) return def;
    } catch (error) {
      logger.warn("載入技能失敗", { path: target, error: String(error) });
    }
  }
  return null;
}

async function loadFromDir(dir: string, external: boolean): Promise<SkillDefinition[]> {
  const out: SkillDefinition[] = [];
  if (!existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const def = await tryImportFolder(full);
      if (def) {
        out.push(def);
        logger.info("已載入技能", { id: def.id, folder: name, external });
      }
    } else if (stat.isFile() && /\.(m?js|cjs)$/.test(name) && !/^index\./.test(name)) {
      try {
        const mod = await import(`${pathToFileURL(full).href}?t=${Date.now()}`);
        const def = toSkill(mod);
        if (def) {
          out.push(def);
          logger.info("已載入技能", { id: def.id, file: name, external });
        }
      } catch (error) {
        logger.warn("載入技能檔失敗", { file: full, error: String(error) });
      }
    }
  }
  return out;
}

/** 已隱藏的技能 id 清單（內建技能「移除」＝隱藏不載入，檔案保留，可恢復）。 */
function hiddenPath(): string {
  return join(config.skillsPath, ".hidden.json");
}

export function readHiddenSkills(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(hiddenPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeHiddenSkills(ids: string[]): void {
  mkdirSync(config.skillsPath, { recursive: true });
  writeFileSync(hiddenPath(), `${JSON.stringify([...new Set(ids)], null, 2)}\n`, "utf8");
}

/** 隱藏技能（不刪檔）；已隱藏回 false。 */
export function hideSkill(id: string): boolean {
  const list = readHiddenSkills();
  if (list.includes(id)) return false;
  list.push(id);
  writeHiddenSkills(list);
  return true;
}

/** 恢復已隱藏的技能；本來就沒隱藏回 false。 */
export function restoreSkill(id: string): boolean {
  const list = readHiddenSkills();
  const next = list.filter((x) => x !== id);
  if (next.length === list.length) return false;
  writeHiddenSkills(next);
  return true;
}

/** 載入內建（src/skills）與外部（data/skills）技能；外部同名 id 覆寫內建。 */
export async function loadSkills(): Promise<SkillDefinition[]> {
  const hidden = new Set(readHiddenSkills());
  const builtin = (await loadFromDir(builtinDir, false)).filter((s) => !hidden.has(s.id));
  const external = await loadFromDir(config.skillsPath, true);
  const map = new Map<string, SkillDefinition>();
  for (const s of builtin) map.set(s.id, s);
  for (const s of external) map.set(s.id, s);
  skills = [...map.values()];
  loaded = true;
  return skills;
}

/** 重新掃描並載入技能（供安裝 / 移除後呼叫）。 */
export async function reloadSkills(): Promise<SkillDefinition[]> {
  return loadSkills();
}

export function listSkills(): SkillDefinition[] {
  return skills;
}

export function getSkill(id: string): SkillDefinition | undefined {
  return skills.find((skill) => skill.id === id);
}

export function skillsLoaded(): boolean {
  return loaded;
}

export function isBuiltinSkill(id: string): boolean {
  return (
    existsSync(join(builtinDir, id, "index.js")) || existsSync(join(builtinDir, id, "index.ts"))
  );
}
