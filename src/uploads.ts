import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface UploadUsage {
  files: number;
  bytes: number;
  maxBytes: number;
}

/** 上傳目錄用量（I2）。 */
export function uploadUsage(): UploadUsage {
  const maxBytes = Math.max(0, config.uploadsMaxMb) * 1024 * 1024;
  let files = 0;
  let bytes = 0;
  try {
    if (!existsSync(config.uploadsPath)) return { files, bytes, maxBytes };
    for (const file of readdirSync(config.uploadsPath)) {
      try {
        const st = statSync(join(config.uploadsPath, file));
        if (st.isFile()) {
          files += 1;
          bytes += st.size;
        }
      } catch {
        // ignore single file errors
      }
    }
  } catch (error) {
    logger.warn("讀取上傳目錄失敗", { error: String(error) });
  }
  return { files, bytes, maxBytes };
}

/** 是否還有空間接受 size 位元組的新上傳（配額 0 = 不限制）。 */
export function uploadHasRoom(size: number): boolean {
  const { bytes, maxBytes } = uploadUsage();
  if (maxBytes <= 0) return true;
  return bytes + size <= maxBytes;
}

/**
 * 依保留天數清理上傳檔（I2）；retentionDays <= 0 表示不清理。
 * 回傳刪除數。
 */
export function pruneUploads(retentionDays = config.uploadsRetentionDays): number {
  if (!(retentionDays > 0)) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    mkdirSync(config.uploadsPath, { recursive: true });
    for (const file of readdirSync(config.uploadsPath)) {
      const full = join(config.uploadsPath, file);
      try {
        const st = statSync(full);
        if (st.isFile() && st.mtimeMs < cutoff) {
          rmSync(full);
          removed += 1;
        }
      } catch {
        // ignore single file errors
      }
    }
  } catch (error) {
    logger.warn("清理上傳檔失敗", { error: String(error) });
  }
  if (removed > 0) logger.info("已清理過期上傳檔", { removed, retentionDays });
  return removed;
}
