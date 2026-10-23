import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "../logger.js";
import { safeName } from "./install.js";

/**
 * P3 技能庫讀取：`library/index.json`（build-library.mjs 產生的機器可讀 manifest）
 * 與 `library/<id>.zip`。路徑可覆寫（測試用）。
 */

export interface LibraryEntry {
  id: string;
  name: string;
  version: string;
  api: number;
}

let overrideDir: string | null = null;
/** 測試用：改技能庫根目錄。 */
export function setLibraryDir(dir: string | null): void {
  overrideDir = dir;
}

export function libraryDir(): string {
  return overrideDir ?? resolve("./library");
}

/** 讀技能庫 manifest；沒建過庫（index.json 不存在）回空陣列，不炸。 */
export function readLibraryIndex(): LibraryEntry[] {
  const path = join(libraryDir(), "index.json");
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { skills?: unknown };
    if (!raw || !Array.isArray(raw.skills)) return [];
    const out: LibraryEntry[] = [];
    for (const s of raw.skills) {
      if (!s || typeof s !== "object") continue;
      const rec = s as Record<string, unknown>;
      if (typeof rec.id !== "string" || !rec.id) continue;
      out.push({
        id: rec.id,
        name: typeof rec.name === "string" ? rec.name : rec.id,
        version: typeof rec.version === "string" ? rec.version : "",
        api: typeof rec.api === "number" ? rec.api : 1,
      });
    }
    return out;
  } catch (error) {
    logger.warn("讀取技能庫 manifest 失敗", { error: String(error) });
    return [];
  }
}

/** 讀技能庫內某技能的 zip；不存在回 null（safeName 已擋掉目錄穿越）。 */
export function readLibraryZip(id: string): Buffer | null {
  const safe = safeName(id);
  if (!safe) return null;
  const path = join(libraryDir(), `${safe}.zip`);
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}
