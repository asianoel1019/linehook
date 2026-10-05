import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "./config.js";
import { currentSettings, saveSettings } from "./settings.js";
import { logger } from "./logger.js";

export interface BackupBundle {
  version: 1;
  exportedAt: string;
  settings: unknown;
  /** 檔名 → 文字內容（storage.json、各 schedules-*.json）。二進位不支援。 */
  files: Record<string, string>;
}

function readTextFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** 打包備份（J3）：設定＋登入狀態＋排程檔。 */
export function readBackupBundle(): BackupBundle {
  const files: Record<string, string> = {};
  const storage = readTextFile(config.line.storagePath);
  if (storage !== undefined) files["storage.json"] = storage;
  try {
    const dir = dirname(config.schedulesPath);
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.startsWith("schedules-") || !file.endsWith(".json")) continue;
        const content = readTextFile(join(dir, file));
        if (content !== undefined) files[file] = content;
      }
    }
    const main = readTextFile(config.schedulesPath);
    if (main !== undefined) files[basename(config.schedulesPath)] = main;
  } catch (error) {
    logger.warn("備份讀取排程檔失敗", { error: String(error) });
  }
  return { version: 1, exportedAt: new Date().toISOString(), settings: currentSettings(), files };
}

/** 還原備份；回傳還原的項目清單。呼叫端負責先備份現況。 */
export function restoreBackupBundle(bundle: unknown): string[] {
  if (!bundle || typeof bundle !== "object") throw new Error("備份格式錯誤");
  const data = bundle as Partial<BackupBundle>;
  if (data.version !== 1) throw new Error(`不支援的備份版本：${String((data as { version?: unknown }).version)}`);
  const restored: string[] = [];
  if (data.settings !== undefined) {
    saveSettings(data.settings);
    restored.push("settings");
  }
  const files = data.files && typeof data.files === "object" ? (data.files as Record<string, unknown>) : {};
  const storage = files["storage.json"];
  if (typeof storage === "string") {
    mkdirSync(dirname(config.line.storagePath), { recursive: true });
    writeFileSync(config.line.storagePath, storage, { mode: 0o600 });
    restored.push("storage.json");
  }
  const dir = dirname(config.schedulesPath);
  for (const [name, content] of Object.entries(files)) {
    if (name === "storage.json" || typeof content !== "string") continue;
    if (!(name.startsWith("schedules-") || name === basename(config.schedulesPath))) continue;
    if (!name.endsWith(".json") || name.includes("/") || name.includes("\\") || name.includes("..")) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), content, "utf8");
    restored.push(name);
  }
  logger.info("已還原備份", { restored });
  return restored;
}
