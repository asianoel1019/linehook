import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { reloadSkills } from "./loader.js";

/**
 * P2 技能熱重載：監看技能目錄，檔案一改就自動重載（不必重啟整個服務）。
 * 用 fs.watch（零依賴）：看父目錄（新增/刪除/改名）＋各技能子目錄（改檔）。
 * 內建技能是 TS 原始碼（開發時靠 tsx watch 重新載入整個行程），這裡主要照顧
 * 外部技能（data/skills）與 dist 部署後的環境。
 */

const DEBOUNCE_MS = 1500;
const builtinDir = fileURLToPath(new URL(".", import.meta.url));

let watchers: FSWatcher[] = [];
let timer: NodeJS.Timeout | null = null;
/** 已啟動（監看中）。 */
let started = false;
/** 正在重載（避免重入）。 */
let reloading = false;
let reloadCount = 0;

function scheduleReload(reason: string): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void doReload(reason);
  }, DEBOUNCE_MS);
  if (typeof timer.unref === "function") timer.unref();
}

async function doReload(reason: string): Promise<void> {
  if (reloading) return;
  reloading = true;
  try {
    const defs = await reloadSkills();
    reloadCount += 1;
    logger.info("技能已熱重載", { reason, skills: defs.length, count: reloadCount });
  } catch (error) {
    logger.error("技能熱重載失敗", { reason, error: String(error) });
  } finally {
    reloading = false;
  }
}

function watchDir(dir: string, label: string): void {
  if (!existsSync(dir)) return;
  try {
    const w = watch(dir, { persistent: false }, (_event, filename) => {
      scheduleReload(`${label}:${String(filename ?? "?")}`);
    });
    w.on("error", (error) => {
      logger.warn("技能目錄監看失敗", { dir, error: String(error) });
    });
    watchers.push(w);
  } catch (error) {
    logger.warn("技能目錄監看失敗", { dir, error: String(error) });
  }
}

/** 啟動熱重載（冪等）。回傳是否成功啟動。 */
export function startHotReload(): boolean {
  if (started) return true;
  const dirs: Array<{ dir: string; label: string }> = [
    { dir: builtinDir, label: "builtin" },
    { dir: config.skillsPath, label: "external" },
  ];
  for (const { dir, label } of dirs) {
    watchDir(dir, label);
    // 各技能子目錄也要看（改 index.js 不會觸發父目錄事件）
    try {
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        try {
          if (statSync(join(dir, name)).isDirectory()) watchDir(join(dir, name), `${label}/${name}`);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }
  if (watchers.length === 0) {
    logger.warn("技能熱重載未啟動（沒有可監看的目錄）");
    return false;
  }
  started = true;
  logger.info("技能熱重載已啟動", { dirs: watchers.length });
  return true;
}

/** 停止熱重載（測試／關閉用）。 */
export function stopHotReload(): void {
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      // ignore
    }
  }
  watchers = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  started = false;
}

/** 目前是否在監看。 */
export function hotReloadActive(): boolean {
  return watchers.length > 0;
}

/** 已重載次數（測試用）。 */
export function hotReloadCount(): number {
  return reloadCount;
}
