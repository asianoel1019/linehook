import { basename, dirname, join } from "node:path";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";

/**
 * 若檔案超過 maxBytes 就輪替：path -> path.1，path.1 -> path.2 ... 保留 maxFiles 個舊檔。
 * 使用 rename（同目錄原子操作），中途崩潰不遺失（C7）。
 */
export function rotateIfNeeded(path: string, maxBytes: number, maxFiles: number): void {
  try {
    if (statSync(path).size <= maxBytes) return;
    const max = Math.max(1, maxFiles);
    for (let i = max - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      if (existsSync(from)) {
        if (i === max - 1) rmSync(from);
        else renameSync(from, `${path}.${i + 1}`);
      }
    }
    renameSync(path, `${path}.1`);
  } catch (error) {
    console.error(`[rotate] 輪替失敗 ${path}: ${String(error)}`);
  }
}

/**
 * 按日輪替（C7）：每天第一次呼叫時把 path 改名為 path.YYYY-MM-DD，
 * 只保留最近 maxFiles 天（檔名排序即時間排序）。
 */
export function rotateDailyIfNeeded(path: string, maxFiles: number): void {
  try {
    if (!existsSync(path)) return;
    const day = new Date().toISOString().slice(0, 10);
    const dated = `${path}.${day}`;
    if (existsSync(dated)) return;
    // rename 同目錄即原子操作；若當日已有則跳過。
    renameSync(path, dated);
    const dir = dirname(path);
    const base = basename(path);
    const datedFiles = readdirSync(dir).filter(
      (file) => file.startsWith(`${base}.`) && /^\d{4}-\d{2}-\d{2}$/.test(file.slice(base.length + 1)),
    );
    datedFiles.sort();
    while (datedFiles.length > Math.max(1, maxFiles)) {
      const oldest = datedFiles.shift();
      if (oldest) rmSync(join(dir, oldest));
    }
  } catch (error) {
    console.error(`[rotate] 按日輪替失敗 ${path}: ${String(error)}`);
  }
}
