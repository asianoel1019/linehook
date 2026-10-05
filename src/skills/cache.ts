import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";

interface CacheEntry<T> {
  savedAt: number;
  value: T;
}

function fileFor(name: string): string {
  // 消毒後加短雜湊前綴，避免不同名稱落到同一檔案（A8）。
  const safe = name.replace(/[^\w.-]+/g, "_");
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return resolve(config.cachePath, `${digest}-${safe}.json`);
}

/**
 * 讀取持久化快取。若不存在或已超過 ttlMs 則回 null。
 * ttlMs <= 0 表示永不過期（A8；注意 parseTtl 永不回傳 0，呼叫端傳 0 即明確要求永久）。
 */
export function readCache<T>(name: string, ttlMs: number): T | null {
  const path = fileFor(name);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry<T>;
    if (typeof entry.savedAt !== "number") return null;
    if (ttlMs > 0 && Date.now() - entry.savedAt > ttlMs) return null;
    return entry.value;
  } catch (error) {
    logger.warn("讀取快取失敗", { name, error: String(error) });
    return null;
  }
}

/** 寫入持久化快取（data/cache/<hash>-<name>.json）。 */
export function writeCache<T>(name: string, value: T): void {
  try {
    mkdirSync(config.cachePath, { recursive: true });
    const entry: CacheEntry<T> = { savedAt: Date.now(), value };
    writeFileSync(fileFor(name), JSON.stringify(entry), "utf8");
  } catch (error) {
    logger.warn("寫入快取失敗", { name, error: String(error) });
  }
}

/**
 * 清掃過期快取（A8）：刪除超過 maxAgeMs 未更新的檔案。
 * 預設保留 7 天；開機與每日各跑一次。
 */
export function sweepCache(maxAgeMs = 7 * 24 * 60 * 60 * 1000): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  try {
    if (!existsSync(config.cachePath)) return { removed, kept };
    const now = Date.now();
    for (const file of readdirSync(config.cachePath)) {
      if (!file.endsWith(".json")) continue;
      const path = resolve(config.cachePath, file);
      try {
        const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry<unknown>;
        if (typeof entry.savedAt === "number" && now - entry.savedAt <= maxAgeMs) {
          kept += 1;
          continue;
        }
        rmSync(path);
        removed += 1;
      } catch {
        // 損毀檔也清掉，避免永久佔位。
        try {
          rmSync(path);
          removed += 1;
        } catch {
          // ignore
        }
      }
    }
  } catch (error) {
    logger.warn("快取清掃失敗", { error: String(error) });
  }
  if (removed > 0) logger.info("快取清掃完成", { removed, kept });
  return { removed, kept };
}

/** 解析 TTL 設定字串（支援「60」(分鐘)、「30m」、「2h」、「90s」）；未設定或無效回預設（毫秒）。 */
export function parseTtl(raw: string | undefined, fallbackMinutes = 60): number {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return fallbackMinutes * 60 * 1000;
  const m = value.match(/^(\d+(?:\.\d+)?)\s*(s|m|h)?$/);
  if (!m) return fallbackMinutes * 60 * 1000;
  const num = Number(m[1]);
  const unit = m[2] ?? "m";
  const ms = unit === "s" ? num * 1000 : unit === "h" ? num * 3600_000 : num * 60_000;
  return ms > 0 ? ms : fallbackMinutes * 60 * 1000;
}
