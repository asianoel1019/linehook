import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { hideSkill, isBuiltinSkill, reloadSkills, listSkills } from "./loader.js";

const builtinDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * 技能 API 版本：技能用 `@lw/*` 別名匯入宿主的共享模組（llm/cache/net/…）與其他技能，
 * 這份清單由主機提供。升級若破壞相容性就提高這個數字；安裝較新的技能會被擋下。
 */
export const SKILL_API_VERSION = 1;

/** 別名匯入面（寫文件用；實際解析由專案根的 alias-hooks.mjs 負責）。 */
export const SKILL_ALIAS_PREFIX = "@lw/";

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

/**
 * P3 備份根：與 skillsPath 同層（`data/skill-backups/<id>.bak/`），刻意不放 skillsPath 內——
 * loader 會載入該目錄下所有子目錄，放裡面會被誤載入成技能。
 */
function backupsRoot(): string {
  return resolve(skillsRoot(), "..", "skill-backups");
}

function backupDir(id: string): string {
  return join(backupsRoot(), `${safeName(id)}.bak`);
}

function readDirVersion(dir: string): string {
  try {
    const m = JSON.parse(readFileSync(join(dir, "skill.json"), "utf8")) as { version?: unknown };
    return typeof m.version === "string" ? m.version : "";
  } catch {
    return "";
  }
}

/** 語義化版本比較（數字段逐段比；缺段視為 0；非數字段按字串比）。回 -1/0/1。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 安裝前備份現有版本（P3）。只有目錄內已有像樣的安裝（進入點或 skill.json）才備；
 * 回傳是否備份成功。同一技能只留一份備份（新備份覆蓋舊的）。
 */
export function backupSkill(id: string): boolean {
  const safe = safeName(id);
  if (!safe) return false;
  const src = join(skillsRoot(), safe);
  const plausible = ["index.js", "index.mjs", "index.cjs", "skill.json"].some((f) => existsSync(join(src, f)));
  if (!plausible) return false;
  try {
    const dest = backupDir(safe);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(backupsRoot(), { recursive: true });
    cpSync(src, dest, { recursive: true });
    logger.info("已備份技能舊版", { id: safe });
    return true;
  } catch (error) {
    logger.warn("備份技能舊版失敗", { id: safe, error: String(error) });
    return false;
  }
}

/** 是否有可回滾的備份。 */
export function hasSkillBackup(id: string): boolean {
  const safe = safeName(id);
  if (!safe) return false;
  return existsSync(backupDir(safe));
}

/** 安裝失敗時把舊版搬回來（盡力而為；備份會被消耗掉——它變回現版了）。 */
function restoreBackup(safe: string): void {
  const bak = backupDir(safe);
  const cur = join(skillsRoot(), safe);
  try {
    if (!existsSync(bak)) return;
    rmSync(cur, { recursive: true, force: true });
    renameSync(bak, cur);
    logger.info("安裝失敗，已還原舊版", { id: safe });
  } catch (error) {
    logger.warn("還原舊版失敗", { id: safe, error: String(error) });
  }
}

/**
 * 一鍵回滾（P3）：備份與現版交換，可反覆橫跳。無備份回 null。
 * 現版不存在（移除後反悔）則直接把備份搬回來。
 */
export async function rollbackSkill(id: string): Promise<{ id: string; version: string } | null> {
  const safe = safeName(id);
  if (!safe) return null;
  const root = skillsRoot();
  const cur = join(root, safe);
  const bak = backupDir(safe);
  if (!existsSync(bak)) return null;
  try {
    if (existsSync(cur)) {
      const tmp = join(root, `${safe}.tmp-swap`);
      rmSync(tmp, { recursive: true, force: true });
      renameSync(cur, tmp);
      renameSync(bak, cur);
      renameSync(tmp, bak);
    } else {
      mkdirSync(root, { recursive: true });
      renameSync(bak, cur);
    }
  } catch (error) {
    logger.warn("回滾技能失敗", { id: safe, error: String(error) });
    return null;
  }
  await reloadSkills();
  logger.info("已回滾技能", { id: safe });
  return { id: safe, version: readDirVersion(cur) };
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
 * P3：覆蓋前先備份現有版本（同層 skill-backups/）；缺進入點等失敗時自動還原舊版。
 */
export async function installZip(
  buffer: Buffer,
): Promise<{ id: string; files: number; version: string; previousVersion: string; backedUp: boolean }> {
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
  let version = "";
  const manifestKey = names.find((n) => n.endsWith("skill.json"));
  if (manifestKey) {
    try {
      const m = JSON.parse(Buffer.from(files[manifestKey]).toString("utf8")) as { id?: string; api?: unknown; version?: unknown };
      if (m.id) id = safeName(m.id);
      if (typeof m.version === "string") version = m.version;
      // 技能 API 版本：技能以 @lw/* 別名匯入宿主模組，主機版本較舊就明確拒絕，
      // 而不是裝了一個載入時才默默消失的技能。
      if (typeof m.api === "number" && m.api > SKILL_API_VERSION) {
        throw new Error(`技能需要更新的主機（api ${m.api} > 本機 ${SKILL_API_VERSION}），請先更新 IM Webhook`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("api ")) throw error;
      // manifest 壞掉不阻止安裝（退回用資料夾名當 id）
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
  // P3 兩段式寫入：先解到系統暫存驗證（進入點齊全才动現版），避免壞包與舊檔混成四不像。
  // 暫存放 os.tmpdir 而非 skillsPath，避免 crash 殘留被 loader 誤載入。
  const stageDir = join(tmpdir(), `skill-install-${process.pid}-${Date.now()}`);
  mkdirSync(stageDir, { recursive: true });
  try {
    let count = 0;
    for (const name of names) {
      const rel = singleRoot ? name.split("/").slice(1).join("/") : name;
      if (!rel) continue;
      const clean = rel.split("/").map(safeName).filter(Boolean).join("/");
      if (!clean) continue;
      const target = resolve(stageDir, clean);
      if (target !== stageDir && !target.startsWith(stageDir + sep)) continue; // 防目錄穿越
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, Buffer.from(files[name]));
      count++;
    }

    if (
      !existsSync(join(stageDir, "index.js")) &&
      !existsSync(join(stageDir, "index.mjs")) &&
      !existsSync(join(stageDir, "index.cjs"))
    ) {
      throw new Error("技能缺少 index.js（或 index.mjs）進入點");
    }

    // 驗證通過才動現版：備份 → 清掉 → 搬入；搬入失敗還原備份。
    const previousVersion = readDirVersion(destDir);
    const backedUp = backupSkill(id);
    try {
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      cpSync(stageDir, destDir, { recursive: true });
    } catch (error) {
      if (backedUp) restoreBackup(id);
      throw error;
    }

    await reloadSkills();
    const loaded = listSkills().some((s) => s.id === id);
    if (!loaded) {
      logger.warn("技能已解壓但載入失敗（請檢查 index.js）", { id });
    }
    logger.info("已安裝技能", { id, files: count });
    return { id, files: count, version, previousVersion, backedUp };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/** 移除外部技能（連同回滾備份一起清掉，省得古董版某天詐屍）。 */
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
  if (removed) {
    rmSync(backupDir(safe), { recursive: true, force: true });
    await reloadSkills();
  }
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
  // 優先打包已編譯的 dist 版（Docker／正式機裝了就能跑）；本機沒 build 才退回 src。
  const appRoot = fileURLToPath(new URL("../..", import.meta.url));
  const compiled = join(appRoot, "dist", "skills", id, "index.js");
  let entry = "";
  let entryName = "";
  if (existsSync(compiled)) {
    entry = compiled;
    entryName = "index.js";
  } else {
    for (const f of ["index.js", "index.ts"]) {
      if (existsSync(join(dir, f))) {
        entry = join(dir, f);
        entryName = f;
        break;
      }
    }
  }
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
        api: SKILL_API_VERSION,
        version: meta.version ?? "1.0.0",
      },
      null,
      2,
    ),
    "utf8",
  );
  files[entryName] = readFileSync(entry);
  return Buffer.from(zipSync(files));
}
