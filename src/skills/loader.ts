import { existsSync, readdirSync, statSync } from "node:fs";
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

/** 載入內建（src/skills）與外部（data/skills）技能；外部同名 id 覆寫內建。 */
export async function loadSkills(): Promise<SkillDefinition[]> {
  const builtin = await loadFromDir(builtinDir, false);
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
